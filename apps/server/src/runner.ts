import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { buildPlan, ffmpegArgs, probe, safeReplace, temporaryOutput, transcode, validateOutput } from "@flowarr/ffmpeg";
import { expandSubflows, failureReason, resolvePath } from "@flowarr/flow-engine";
import type { PluginRegistry } from "@flowarr/plugin-sdk";
import type { FlowGraph } from "@flowarr/shared";
import type { Database } from "./database.js";
import type { EventHub } from "./events.js";
import { assignQueuedJobs, chooseWorker, releaseUnavailableAssignments } from "./workers.js";

export class LocalRunner {
  private active = false;
  constructor(private db: Database, private events: EventHub, private localWorkerId: string, private plugins: PluginRegistry) {}
  enqueue(fileId: string): string {
    const file = this.db.raw.prepare("SELECT f.*, l.flow_id FROM files f JOIN libraries l ON l.id=f.library_id WHERE f.id=?").get(fileId) as Record<string, unknown> | undefined;
    if (!file) throw new Error("File not found");
    if (!file.flow_id) throw new Error("Library has no assigned flow");
    const flow = this.db.getFlow(String(file.flow_id)); if (!flow) throw new Error("Flow not found");
    const graph = this.plugins.expandGraph(expandSubflows(flow.id, flow.graph, (flowId) => this.db.getFlow(flowId)?.graph ?? null));
    const id = randomUUID(); const now = new Date().toISOString();
    const workerId = chooseWorker(this.db, String(file.path), graph);
    this.db.raw.prepare("INSERT INTO jobs (id,file_id,flow_snapshot_json,status,assigned_worker_id,created_at) VALUES (?,?,?,'queued',?,?)").run(id, fileId, JSON.stringify(graph), workerId, now);
    this.db.raw.prepare("UPDATE files SET status='queued',updated_at=? WHERE id=?").run(now, fileId);
    if (workerId === this.localWorkerId) queueMicrotask(() => void this.pump());
    return id;
  }
  async pump(): Promise<void> {
    if (this.active) return; this.active = true;
    try {
      while (true) {
        releaseUnavailableAssignments(this.db);
        assignQueuedJobs(this.db);
        const job = this.db.raw.prepare("SELECT * FROM jobs WHERE status='queued' AND assigned_worker_id=? ORDER BY priority DESC,created_at LIMIT 1").get(this.localWorkerId) as Record<string, unknown> | undefined;
        if (!job) break;
        await this.process(job);
      }
    } finally { this.active = false; }
  }
  private log(jobId: string, level: string, message: string, detail?: unknown) {
    this.db.raw.prepare("INSERT INTO job_logs (job_id,level,message,detail_json,created_at) VALUES (?,?,?,?,?)").run(jobId, level, message, detail ? JSON.stringify(detail) : null, new Date().toISOString());
  }
  private async process(job: Record<string, unknown>): Promise<void> {
    const jobId = String(job.id); const file = this.db.raw.prepare("SELECT * FROM files WHERE id=?").get(String(job.file_id)) as Record<string, unknown>;
    const source = String(file.path); const temporary = temporaryOutput(source, jobId); const started = new Date().toISOString();
    this.db.raw.prepare("UPDATE jobs SET status='running',started_at=? WHERE id=?").run(started, jobId);
    this.db.raw.prepare("UPDATE files SET status='processing',updated_at=? WHERE id=?").run(started, String(file.id));
    this.events.send("job", { id: jobId, status: "running", progress: 0 });
    try {
      await stat(source); this.log(jobId, "INFO", "Source confirmed");
      const sourceProbe = await probe(source);
      this.db.raw.prepare("UPDATE files SET probe_json=?,raw_probe_json=? WHERE id=?").run(JSON.stringify(sourceProbe.normalized), JSON.stringify(sourceProbe.raw), String(file.id));
      const graph = JSON.parse(String(job.flow_snapshot_json)) as FlowGraph;
      const path = resolvePath(graph, sourceProbe.normalized);
      const routedFailure = failureReason(path); if (routedFailure) throw new Error(routedFailure);
      if (path.some((node) => node.kind === "success") && !path.some((node) => node.kind === "ffmpeg-execute")) {
        this.log(jobId, "INFO", "Flow completed without FFmpeg processing");
        this.finish(jobId, String(file.id), 0); return;
      }
      if (!path.some((node) => node.kind === "ffmpeg-execute")) throw new Error("Selected flow route has no FFmpeg Execute node");
      const plan = buildPlan(path, source, temporary);
      this.log(jobId, "DEBUG", "Executing FFmpeg", { arguments: redactArgs(ffmpegArgs(plan)) });
      await transcode(plan, sourceProbe.normalized.format.duration, (progress, speed) => {
        this.db.raw.prepare("UPDATE jobs SET progress=?,speed=? WHERE id=?").run(progress, speed, jobId);
        this.events.send("job", { id: jobId, status: "running", progress, speed });
      });
      await validateOutput(sourceProbe.normalized, temporary); this.log(jobId, "INFO", "Output validation passed");
      const originalSize = Number(file.size); const outputSize = (await stat(temporary)).size;
      const savingNode = path.find((node) => node.kind === "minimum-saving");
      const minimumSaving = Math.max(0, Math.min(100, Number(savingNode?.config?.percent ?? 0)));
      const savingPercent = originalSize > 0 ? (originalSize - outputSize) / originalSize * 100 : 0;
      if (savingPercent < minimumSaving) {
        await rm(temporary, { force: true });
        this.log(jobId, "INFO", `Output rejected: ${savingPercent.toFixed(2)}% saving is below ${minimumSaving}% minimum`);
        this.finish(jobId, String(file.id), 0); return;
      }
      await safeReplace(source, temporary, jobId); this.log(jobId, "INFO", "Source replaced atomically after validation");
      this.finish(jobId, String(file.id), Math.max(0, originalSize - outputSize), outputSize);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error); const now = new Date().toISOString();
      this.log(jobId, "ERROR", message);
      this.db.raw.prepare("UPDATE jobs SET status='failed',error=?,finished_at=? WHERE id=?").run(message, now, jobId);
      this.db.raw.prepare("UPDATE files SET status='failed',updated_at=? WHERE id=?").run(now, String(file.id));
      this.events.send("job", { id: jobId, status: "failed", error: message });
    }
  }
  private finish(jobId: string, fileId: string, savings: number, size?: number) {
    const now = new Date().toISOString();
    this.db.raw.prepare("UPDATE jobs SET status='succeeded',progress=100,finished_at=? WHERE id=?").run(now, jobId);
    this.db.raw.prepare("UPDATE files SET status='processed',savings_bytes=?,size=COALESCE(?,size),updated_at=? WHERE id=?").run(savings, size ?? null, now, fileId);
    this.events.send("job", { id: jobId, status: "succeeded", progress: 100 });
  }
}

function redactArgs(args: string[]): string[] {
  const secretFlags = new Set(["-headers", "-authorization", "-password"]);
  return args.map((arg, index) => index > 0 && secretFlags.has(args[index - 1] ?? "") ? "[REDACTED]" : arg);
}
