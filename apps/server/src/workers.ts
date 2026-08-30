import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { arch, cpus, freemem, hostname, platform, totalmem } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { FlowGraph, PathMapping, WorkerCapabilities, WorkerInfo, WorkerSchedule } from "@flowarr/shared";
import type { Database } from "./database.js";
import type { EventHub } from "./events.js";

type WorkerRow = { id: string; name: string; kind: "local" | "remote"; priority: number; schedule_json: string; capabilities_json: string; path_mappings_json: string; last_seen_at: string; created_at: string };
type QueuedJobRow = { id: string; path: string; flow_snapshot_json: string };

const run = promisify(execFile);
export const LOCAL_WORKER_ID = "flowarr-local";
export const DEFAULT_WORKER_SCHEDULE: WorkerSchedule = { mode: "always", timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" };

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createRegistrationToken(db: Database, ttlHours = 24): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Math.max(1, Math.min(168, ttlHours)) * 3_600_000).toISOString();
  db.raw.prepare("INSERT INTO worker_registration_tokens (id,token_hash,created_at,expires_at) VALUES (?,?,?,?)")
    .run(randomUUID(), tokenHash(token), now.toISOString(), expiresAt);
  return { token, expiresAt };
}

export async function ensureLocalWorker(db: Database): Promise<WorkerInfo> {
  const now = new Date().toISOString();
  const capabilities = await detectLocalCapabilities();
  const name = process.env.FLOWARR_LOCAL_NODE_NAME?.trim() || `${hostname()} (local)`;
  const existing = db.raw.prepare("SELECT created_at FROM workers WHERE id=?").get(LOCAL_WORKER_ID) as { created_at: string } | undefined;
  db.raw.prepare(`INSERT INTO workers (id,name,kind,priority,capabilities_json,path_mappings_json,last_seen_at,created_at)
    VALUES (?,?,'local',0,?,'[]',?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind='local',capabilities_json=excluded.capabilities_json,path_mappings_json='[]',last_seen_at=excluded.last_seen_at`)
    .run(LOCAL_WORKER_ID, name, JSON.stringify(capabilities), now, now);
  return listWorkers(db).find((worker) => worker.id === LOCAL_WORKER_ID) ?? { id: LOCAL_WORKER_ID, name, kind: "local", priority: 0, schedule: DEFAULT_WORKER_SCHEDULE, scheduleActive: true, status: "online", capabilities, pathMappings: [], lastSeenAt: now, createdAt: existing?.created_at ?? now };
}

export function refreshLocalWorker(db: Database): void {
  const row = db.raw.prepare("SELECT capabilities_json FROM workers WHERE id=?").get(LOCAL_WORKER_ID) as { capabilities_json: string } | undefined;
  if (!row) return;
  const capabilities = JSON.parse(row.capabilities_json) as WorkerCapabilities;
  capabilities.freeMemory = freemem();
  capabilities.totalMemory = totalmem();
  db.raw.prepare("UPDATE workers SET capabilities_json=?,last_seen_at=? WHERE id=?")
    .run(JSON.stringify(capabilities), new Date().toISOString(), LOCAL_WORKER_ID);
}

export function registerWorker(db: Database, token: string, name: string, capabilities: WorkerCapabilities, pathMappings: PathMapping[]): WorkerInfo {
  const now = new Date().toISOString();
  const registration = db.raw.prepare("SELECT id FROM worker_registration_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?")
    .get(tokenHash(token), now) as { id: string } | undefined;
  if (!registration) throw new Error("Invalid or expired registration token");
  validateWorkerCapabilities(capabilities);
  const mappings = validatePathMappings(pathMappings);
  const existing = db.raw.prepare("SELECT id,created_at,priority,kind FROM workers WHERE name=?").get(name) as { id: string; created_at: string; priority: number; kind: string } | undefined;
  if (existing?.kind === "local") throw new Error("This name is reserved by the local Flowarr node");
  const id = existing?.id ?? randomUUID();
  db.transaction(() => {
    db.raw.prepare("UPDATE worker_registration_tokens SET used_at=? WHERE id=?").run(now, registration.id);
    if (existing) db.raw.prepare("UPDATE workers SET kind='remote',capabilities_json=?,path_mappings_json=?,last_seen_at=? WHERE id=?")
      .run(JSON.stringify(capabilities), JSON.stringify(mappings), now, id);
    else db.raw.prepare("INSERT INTO workers (id,name,kind,priority,capabilities_json,path_mappings_json,last_seen_at,created_at) VALUES (?,?,'remote',0,?,?,?,?)")
      .run(id, name, JSON.stringify(capabilities), JSON.stringify(mappings), now, now);
  });
  return listWorkers(db).find((worker) => worker.id === id) ?? { id, name, kind: "remote", priority: existing?.priority ?? 0, schedule: DEFAULT_WORKER_SCHEDULE, scheduleActive: true, status: "online", capabilities, pathMappings: mappings, lastSeenAt: now, createdAt: existing?.created_at ?? now };
}

export function listWorkers(db: Database): WorkerInfo[] {
  const onlineAfter = Date.now() - 45_000;
  return (db.raw.prepare("SELECT * FROM workers ORDER BY priority DESC,kind,name").all() as WorkerRow[]).map((row) => {
    const schedule = parseWorkerSchedule(row.schedule_json);
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      priority: Number(row.priority),
      schedule,
      scheduleActive: isWorkerScheduleActive(schedule),
      status: row.kind === "local" || Date.parse(row.last_seen_at) >= onlineAfter ? "online" : "offline",
      capabilities: JSON.parse(row.capabilities_json) as WorkerCapabilities,
      pathMappings: JSON.parse(row.path_mappings_json) as PathMapping[],
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at
    };
  });
}

export function setWorkerPriority(db: Database, workerId: string, priority: number): WorkerInfo | null {
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) throw new Error("Priority must be an integer from 0 to 100");
  const result = db.raw.prepare("UPDATE workers SET priority=? WHERE id=?").run(priority, workerId);
  return result.changes ? listWorkers(db).find((worker) => worker.id === workerId) ?? null : null;
}

export function setWorkerSchedule(db: Database, workerId: string, schedule: WorkerSchedule): WorkerInfo | null {
  const normalized = validateWorkerSchedule(schedule);
  const result = db.raw.prepare("UPDATE workers SET schedule_json=? WHERE id=?").run(JSON.stringify(normalized), workerId);
  return result.changes ? listWorkers(db).find((worker) => worker.id === workerId) ?? null : null;
}

export function chooseWorker(db: Database, sourcePath: string, graph: FlowGraph): string | null {
  const requiredEncoder = requiredVideoEncoder(graph);
  const busyWorkerIds = new Set((db.raw.prepare("SELECT DISTINCT assigned_worker_id AS id FROM jobs WHERE status IN ('queued','running') AND assigned_worker_id IS NOT NULL").all() as Array<{ id: string }>).map((row) => row.id));
  return listWorkers(db)
    .filter((worker) => worker.status === "online" && worker.capabilities.ffmpeg.available)
    .filter((worker) => worker.scheduleActive)
    .filter((worker) => !busyWorkerIds.has(worker.id))
    .filter((worker) => !requiredEncoder || worker.capabilities.ffmpeg.encoders.includes(requiredEncoder))
    .filter((worker) => worker.kind === "local" || worker.pathMappings.some((mapping) => isInside(mapping.serverPath, sourcePath)))
    .sort((a, b) => b.priority - a.priority || b.capabilities.freeMemory - a.capabilities.freeMemory || b.capabilities.logicalCpus - a.capabilities.logicalCpus)[0]?.id ?? null;
}

export function assignQueuedJobs(db: Database): number {
  const jobs = db.raw.prepare("SELECT j.id,f.path,j.flow_snapshot_json FROM jobs j JOIN files f ON f.id=j.file_id WHERE j.status='queued' AND j.assigned_worker_id IS NULL ORDER BY j.priority DESC,j.created_at").all() as QueuedJobRow[];
  let assigned = 0;
  for (const job of jobs) {
    const workerId = chooseWorker(db, job.path, JSON.parse(job.flow_snapshot_json) as FlowGraph);
    if (!workerId) continue;
    assigned += Number(db.raw.prepare("UPDATE jobs SET assigned_worker_id=? WHERE id=? AND status='queued' AND assigned_worker_id IS NULL").run(workerId, job.id).changes);
  }
  return assigned;
}

export function mapPathForWorker(db: Database, workerId: string, sourcePath: string): string {
  const row = db.raw.prepare("SELECT kind,capabilities_json,path_mappings_json FROM workers WHERE id=?").get(workerId) as { kind: string; capabilities_json: string; path_mappings_json: string } | undefined;
  if (!row) throw new Error("Worker not found");
  if (row.kind === "local") return sourcePath;
  const capabilities = JSON.parse(row.capabilities_json) as WorkerCapabilities;
  const mappings = (JSON.parse(row.path_mappings_json) as PathMapping[])
    .filter((mapping) => isInside(mapping.serverPath, sourcePath))
    .sort((a, b) => path.resolve(b.serverPath).length - path.resolve(a.serverPath).length);
  const mapping = mappings[0];
  if (!mapping) throw new Error("No path mapping for this file");
  const relative = path.relative(path.resolve(mapping.serverPath), path.resolve(sourcePath));
  const workerPath = capabilities.platform === "win32" ? path.win32 : path.posix;
  return workerPath.join(mapping.workerPath, ...relative.split(path.sep));
}

export function releaseStaleAssignments(db: Database): number {
  const staleBefore = new Date(Date.now() - 45_000).toISOString();
  const result = db.raw.prepare("UPDATE jobs SET assigned_worker_id=NULL,lease_expires_at=NULL WHERE status='queued' AND assigned_worker_id IN (SELECT id FROM workers WHERE kind='remote' AND last_seen_at<?)").run(staleBefore);
  return Number(result.changes);
}

export function releaseUnavailableAssignments(db: Database): number {
  let released = 0;
  for (const worker of listWorkers(db)) {
    if (worker.scheduleActive) continue;
    released += Number(db.raw.prepare("UPDATE jobs SET assigned_worker_id=NULL,lease_expires_at=NULL WHERE status='queued' AND assigned_worker_id=?").run(worker.id).changes);
  }
  return released;
}

export function expireWorkerLeases(db: Database, events?: EventHub): number {
  const now = new Date().toISOString();
  const expired = db.raw.prepare("SELECT id,file_id FROM jobs WHERE status='running' AND assigned_worker_id IN (SELECT id FROM workers WHERE kind='remote') AND lease_expires_at<?").all(now) as Array<{ id: string; file_id: string }>;
  if (!expired.length) return 0;
  db.transaction(() => {
    for (const job of expired) {
      db.raw.prepare("UPDATE jobs SET status='failed',error='Remote worker lease expired',finished_at=?,lease_expires_at=NULL WHERE id=?").run(now, job.id);
      db.raw.prepare("UPDATE files SET status='failed',updated_at=? WHERE id=?").run(now, job.file_id);
      db.raw.prepare("INSERT INTO job_logs (job_id,level,message,created_at) VALUES (?,'ERROR','Remote worker lease expired',?)").run(job.id, now);
    }
  });
  for (const job of expired) events?.send("job", { id: job.id, status: "failed", error: "Remote worker lease expired" });
  return expired.length;
}

async function detectLocalCapabilities(): Promise<WorkerCapabilities> {
  const ffmpeg: WorkerCapabilities["ffmpeg"] = await Promise.all([
    run("ffmpeg", ["-version"], { windowsHide: true }),
    run("ffmpeg", ["-hide_banner", "-encoders"], { windowsHide: true })
  ]).then(([version, encoders]) => ({
    available: true,
    version: version.stdout.split(/\r?\n/)[0],
    encoders: encoders.stdout.split(/\r?\n/).map((line) => line.match(/^\s*[A-Z.]{6}\s+(\S+)/)?.[1]).filter((value): value is string => Boolean(value))
  })).catch((error: unknown) => ({ available: false, error: error instanceof Error ? error.message : String(error), encoders: [] }));
  return {
    platform: platform(), architecture: arch(), cpu: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length,
    totalMemory: totalmem(), freeMemory: freemem(), ffmpeg
  };
}

export function isWorkerScheduleActive(schedule: WorkerSchedule, now = new Date()): boolean {
  if (schedule.mode === "always") return true;
  if (schedule.mode === "disabled") return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const current = hour * 60 + minute;
  const start = timeToMinutes(schedule.start);
  const end = timeToMinutes(schedule.end);
  if (start < end) return schedule.days.includes(day) && current >= start && current < end;
  const previousDay = (day + 6) % 7;
  return (schedule.days.includes(day) && current >= start) || (schedule.days.includes(previousDay) && current < end);
}

export function validateWorkerSchedule(value: WorkerSchedule): WorkerSchedule {
  if (!value || !["always", "scheduled", "disabled"].includes(value.mode) || typeof value.timezone !== "string") throw new Error("Invalid worker schedule");
  try { new Intl.DateTimeFormat("en-US", { timeZone: value.timezone }).format(); }
  catch { throw new Error("Invalid schedule timezone"); }
  if (!Array.isArray(value.days)) throw new Error("Schedule requires valid working days");
  const days = [...new Set(value.days)].sort((a, b) => a - b);
  if (days.some((day) => !Number.isInteger(day) || day < 0 || day > 6) || (value.mode === "scheduled" && !days.length)) throw new Error("Schedule requires valid working days");
  if (!isTime(value.start) || !isTime(value.end) || (value.mode === "scheduled" && value.start === value.end)) throw new Error("Schedule requires different valid start and end times");
  return { mode: value.mode, timezone: value.timezone, days, start: value.start, end: value.end };
}

function parseWorkerSchedule(value: string): WorkerSchedule {
  try {
    const parsed = JSON.parse(value) as WorkerSchedule & { enabled?: boolean };
    if (!parsed.mode && typeof parsed.enabled === "boolean") parsed.mode = parsed.enabled ? "scheduled" : "always";
    return validateWorkerSchedule(parsed);
  }
  catch { return { ...DEFAULT_WORKER_SCHEDULE, days: [...DEFAULT_WORKER_SCHEDULE.days] }; }
}

function isTime(value: string): boolean { return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }
function timeToMinutes(value: string): number { const [hour = 0, minute = 0] = value.split(":").map(Number); return hour * 60 + minute; }

function requiredVideoEncoder(graph: FlowGraph): string | null {
  const explicit = graph.nodes.find((node) => node.kind === "video-encode")?.config?.codec;
  if (typeof explicit === "string" && explicit !== "copy") return explicit;
  return graph.nodes.some((node) => node.kind === "hevc-encode") ? "libx265" : null;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function validateWorkerCapabilities(value: WorkerCapabilities) {
  if (!value || typeof value.platform !== "string" || !Number.isFinite(value.logicalCpus) || !value.ffmpeg || !Array.isArray(value.ffmpeg.encoders)) {
    throw new Error("Invalid worker capabilities");
  }
}

function validatePathMappings(mappings: PathMapping[]): PathMapping[] {
  if (!Array.isArray(mappings) || mappings.length === 0) throw new Error("At least one path mapping is required");
  return mappings.map((mapping) => {
    if (!mapping || typeof mapping.serverPath !== "string" || typeof mapping.workerPath !== "string" || !mapping.serverPath.trim() || !mapping.workerPath.trim()) throw new Error("Invalid path mapping");
    return { serverPath: mapping.serverPath.trim(), workerPath: mapping.workerPath.trim() };
  });
}
