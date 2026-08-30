import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, platform, arch, cpus, totalmem, freemem } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildPlan, probe, safeReplace, temporaryOutput, transcode, validateOutput } from "@flowarr/ffmpeg";
import { failureReason, resolvePath } from "@flowarr/flow-engine";
import type { PathMapping, RemoteJob, WorkerCapabilities } from "@flowarr/shared";

const run = promisify(execFile);
const serverUrl = (process.env.FLOWARR_SERVER_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const workerName = process.env.FLOWARR_WORKER_NAME ?? hostname();
const dataDir = path.resolve(process.env.FLOWARR_WORKER_DATA_DIR ?? "./data");
const stateFile = path.join(dataDir, "worker.json");
let stopping = false;

interface WorkerState { id: string; token: string }

async function ffmpegCapabilities(): Promise<WorkerCapabilities["ffmpeg"]> {
  try {
    const [{ stdout: version }, { stdout: encoders }] = await Promise.all([run("ffmpeg", ["-version"]), run("ffmpeg", ["-hide_banner", "-encoders"])]);
    const names = encoders.split(/\r?\n/).map((line) => line.match(/^\s*[A-Z.]{6}\s+(\S+)/)?.[1]).filter((value): value is string => Boolean(value));
    return { available: true, version: version.split(/\r?\n/)[0], encoders: names };
  } catch (error) { return { available: false, error: error instanceof Error ? error.message : String(error), encoders: [] }; }
}

async function capabilities(): Promise<WorkerCapabilities> {
  return { platform: platform(), architecture: arch(), cpu: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length, totalMemory: totalmem(), freeMemory: freemem(), ffmpeg: await ffmpegCapabilities() };
}

function pathMappings(): PathMapping[] {
  const value = process.env.FLOWARR_PATH_MAPPINGS;
  if (!value) throw new Error('FLOWARR_PATH_MAPPINGS is required, for example [{"serverPath":"/media","workerPath":"/media"}]');
  const parsed = JSON.parse(value) as PathMapping[];
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("FLOWARR_PATH_MAPPINGS must be a non-empty JSON array");
  return parsed;
}

async function request<T>(pathname: string, state: WorkerState | null, init: RequestInit = {}): Promise<T | null> {
  const response = await fetch(`${serverUrl}${pathname}`, { ...init, headers: { "content-type": "application/json", ...(state ? { authorization: `Bearer ${state.token}` } : {}), ...init.headers } });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Flowarr server returned ${response.status}`);
  return body;
}

async function loadState(): Promise<WorkerState | null> {
  try { return JSON.parse(await readFile(stateFile, "utf8")) as WorkerState; } catch { return null; }
}

async function register(): Promise<WorkerState> {
  const registrationToken = process.env.FLOWARR_REGISTRATION_TOKEN;
  if (!registrationToken) throw new Error("Worker is not registered. Set FLOWARR_REGISTRATION_TOKEN once.");
  const result = await request<{ worker: { id: string }; token: string }>("/api/workers/register", null, {
    method: "POST", body: JSON.stringify({ token: registrationToken, name: workerName, capabilities: await capabilities(), pathMappings: pathMappings() })
  });
  if (!result) throw new Error("Empty registration response");
  const state = { id: result.worker.id, token: result.token };
  await mkdir(dataDir, { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
  return state;
}

async function heartbeat(state: WorkerState) {
  await request(`/api/workers/${state.id}/heartbeat`, state, { method: "POST", body: JSON.stringify({ capabilities: await capabilities() }) });
}

async function complete(state: WorkerState, job: RemoteJob, body: Record<string, unknown>) {
  await request(`/api/workers/${state.id}/jobs/${job.id}/complete`, state, { method: "POST", body: JSON.stringify(body) });
}

async function processJob(state: WorkerState, job: RemoteJob) {
  const temporary = temporaryOutput(job.sourcePath, job.id);
  try {
    const sourceStat = await stat(job.sourcePath);
    const sourceProbe = await probe(job.sourcePath);
    const nodes = resolvePath(job.graph, sourceProbe.normalized);
    const routedFailure = failureReason(nodes); if (routedFailure) throw new Error(routedFailure);
    if (nodes.some((node) => node.kind === "success") && !nodes.some((node) => node.kind === "ffmpeg-execute")) {
      await complete(state, job, { status: "succeeded", savingsBytes: 0, outputSize: sourceStat.size, probe: sourceProbe.normalized }); return;
    }
    if (!nodes.some((node) => node.kind === "ffmpeg-execute")) throw new Error("Selected flow route has no FFmpeg Execute node");
    const plan = buildPlan(nodes, job.sourcePath, temporary);
    await transcode(plan, sourceProbe.normalized.format.duration, (progress, speed) => {
      void request(`/api/workers/${state.id}/jobs/${job.id}/progress`, state, { method: "POST", body: JSON.stringify({ progress, speed }) })
        .catch((error) => process.stderr.write(`Progress update failed: ${error instanceof Error ? error.message : String(error)}\n`));
    });
    const outputProbe = await validateOutput(sourceProbe.normalized, temporary);
    const outputSize = (await stat(temporary)).size;
    const savingPercent = sourceStat.size > 0 ? (sourceStat.size - outputSize) / sourceStat.size * 100 : 0;
    const minimum = Math.max(0, Math.min(100, Number(nodes.find((node) => node.kind === "minimum-saving")?.config?.percent ?? 0)));
    if (savingPercent < minimum) {
      await rm(temporary, { force: true });
      await complete(state, job, { status: "succeeded", savingsBytes: 0, outputSize: sourceStat.size, probe: sourceProbe.normalized }); return;
    }
    await safeReplace(job.sourcePath, temporary, job.id);
    await complete(state, job, { status: "succeeded", savingsBytes: Math.max(0, sourceStat.size - outputSize), outputSize, probe: outputProbe });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    await complete(state, job, { status: "failed", error: message }).catch((reportError) => process.stderr.write(`Failed to report job ${job.id}: ${reportError instanceof Error ? reportError.message : String(reportError)}\n`));
  }
}

async function delay(milliseconds: number) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function main() {
  let state = await loadState();
  if (!state) state = await register();
  process.stdout.write(`Flowarr worker ${workerName} connected as ${state.id}.\n`);
  let nextHeartbeat = 0;
  while (!stopping) {
    try {
      if (Date.now() >= nextHeartbeat) { await heartbeat(state); nextHeartbeat = Date.now() + 15_000; }
      const job = await request<RemoteJob>(`/api/workers/${state.id}/jobs/claim`, state, { method: "POST", body: "{}" });
      if (job) await processJob(state, job); else await delay(2_000);
    } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); await delay(5_000); }
  }
}

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
