import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FlowGraph, Job, Library, MediaFile } from "@flowarr/shared";

export interface StatisticsData {
  rangeDays: number;
  summary: { totalJobs: number; succeeded: number; failed: number; successRate: number; processedFiles: number; bytesSaved: number; sourceBytes: number; averageDurationSeconds: number; totalDurationSeconds: number };
  timeline: Array<{ date: string; succeeded: number; failed: number; bytesSaved: number }>;
  jobStatuses: Array<{ status: string; count: number }>;
  codecs: Array<{ codec: string; count: number }>;
  libraries: Array<{ name: string; files: number; bytesSaved: number }>;
  flows: Array<{ name: string; jobs: number; succeeded: number }>;
  workers: Array<{ name: string; jobs: number; succeeded: number }>;
}

export class Database {
  readonly raw: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.raw = new DatabaseSync(path.join(dataDir, "flowarr.db"));
    this.raw.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }
  private migrate() {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS flows (id TEXT PRIMARY KEY, name TEXT NOT NULL, graph_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS flow_revisions (id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE, revision INTEGER NOT NULL, graph_json TEXT NOT NULL, comment TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS libraries (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, flow_id TEXT REFERENCES flows(id), enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0, extensions_json TEXT NOT NULL, stability_seconds INTEGER NOT NULL DEFAULT 30, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL, probe_json TEXT, raw_probe_json TEXT, savings_bytes INTEGER NOT NULL DEFAULT 0, detected_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS files_status_idx ON files(status, detected_at);
      CREATE INDEX IF NOT EXISTS files_library_idx ON files(library_id, detected_at);
      CREATE INDEX IF NOT EXISTS files_updated_idx ON files(updated_at);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(id), flow_snapshot_json TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, progress INTEGER NOT NULL DEFAULT 0, speed TEXT, eta_seconds INTEGER, error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
      CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, priority DESC, created_at);
      CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs(created_at);
      CREATE INDEX IF NOT EXISTS jobs_finished_idx ON jobs(finished_at);
      CREATE INDEX IF NOT EXISTS jobs_file_idx ON jobs(file_id, status, created_at);
      CREATE TABLE IF NOT EXISTS job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, level TEXT NOT NULL, message TEXT NOT NULL, detail_json TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_registration_tokens (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
      CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, capabilities_json TEXT NOT NULL, path_mappings_json TEXT NOT NULL, last_seen_at TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workers_seen_idx ON workers(last_seen_at);
      CREATE TABLE IF NOT EXISTS integrations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key_encrypted TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, last_test_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS integrations_kind_idx ON integrations(kind,name);
    `);
    this.addColumn("jobs", "assigned_worker_id TEXT");
    this.addColumn("jobs", "lease_expires_at TEXT");
    this.addColumn("workers", "kind TEXT NOT NULL DEFAULT 'remote'");
    this.addColumn("workers", "priority INTEGER NOT NULL DEFAULT 0");
    this.addColumn("workers", `schedule_json TEXT NOT NULL DEFAULT '{"mode":"always","timezone":"UTC","days":[0,1,2,3,4,5,6],"start":"00:00","end":"23:59"}'`);
    this.addColumn("integrations", "sync_on_success INTEGER NOT NULL DEFAULT 0");
    this.addColumn("integrations", "last_sync_at TEXT");
  }
  private addColumn(table: string, definition: string) {
    const name = definition.split(/\s+/)[0];
    if (!name) throw new Error("Invalid database column definition");
    const columns = this.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
  transaction(action: () => void): void {
    this.raw.exec("BEGIN IMMEDIATE");
    try { action(); this.raw.exec("COMMIT"); }
    catch (error) { this.raw.exec("ROLLBACK"); throw error; }
  }
  hasUsers(): boolean { return Boolean((this.raw.prepare("SELECT 1 AS yes FROM users LIMIT 1").get() as { yes?: number } | undefined)?.yes); }
  listLibraries(): Library[] { return (this.raw.prepare("SELECT * FROM libraries ORDER BY priority DESC, name").all() as Record<string, unknown>[]).map(mapLibrary); }
  listFiles(status?: string): MediaFile[] {
    const rows = status
      ? this.raw.prepare("SELECT f.*,(SELECT j.id FROM jobs j WHERE j.file_id=f.id AND j.status='failed' ORDER BY j.created_at DESC LIMIT 1) AS failure_job_id FROM files f WHERE f.status=? ORDER BY f.detected_at DESC LIMIT 500").all(status)
      : this.raw.prepare("SELECT f.*,(SELECT j.id FROM jobs j WHERE j.file_id=f.id AND j.status='failed' ORDER BY j.created_at DESC LIMIT 1) AS failure_job_id FROM files f ORDER BY f.detected_at DESC LIMIT 500").all();
    return (rows as Record<string, unknown>[]).map(mapFile);
  }
  listJobs(): Job[] { return (this.raw.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100").all() as Record<string, unknown>[]).map(mapJob); }
  getStatistics(days = 30, now = new Date()): StatisticsData {
    const rangeDays = [7, 30, 90].includes(days) ? days : 30;
    const end = new Date(now); end.setUTCHours(23, 59, 59, 999);
    const start = new Date(end); start.setUTCDate(start.getUTCDate() - rangeDays + 1); start.setUTCHours(0, 0, 0, 0);
    const since = start.toISOString();
    const jobStatuses = (this.raw.prepare("SELECT status,COUNT(*) AS count FROM jobs WHERE created_at>=? GROUP BY status ORDER BY status").all(since) as Array<{ status: string; count: number }>).map((row) => ({ status: row.status, count: Number(row.count) }));
    const totalJobs = jobStatuses.reduce((sum, row) => sum + row.count, 0);
    const succeeded = jobStatuses.find((row) => row.status === "succeeded")?.count ?? 0;
    const failed = jobStatuses.find((row) => row.status === "failed")?.count ?? 0;
    const duration = this.raw.prepare("SELECT COALESCE(SUM(unixepoch(finished_at)-unixepoch(started_at)),0) AS seconds,COUNT(*) AS count FROM jobs WHERE finished_at>=? AND started_at IS NOT NULL").get(since) as { seconds: number; count: number };
    const media = this.raw.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(savings_bytes),0) AS saved,COALESCE(SUM(size+savings_bytes),0) AS source FROM files WHERE status='processed' AND updated_at>=?").get(since) as { count: number; saved: number; source: number };
    const dailyJobs = this.raw.prepare("SELECT substr(finished_at,1,10) AS date,status,COUNT(*) AS count FROM jobs WHERE finished_at>=? AND status IN ('succeeded','failed') GROUP BY date,status").all(since) as Array<{ date: string; status: string; count: number }>;
    const dailySavings = this.raw.prepare("SELECT substr(updated_at,1,10) AS date,COALESCE(SUM(savings_bytes),0) AS bytes FROM files WHERE status='processed' AND updated_at>=? GROUP BY date").all(since) as Array<{ date: string; bytes: number }>;
    const timeline = Array.from({ length: rangeDays }, (_, index) => {
      const date = new Date(start); date.setUTCDate(date.getUTCDate() + index); const key = date.toISOString().slice(0, 10);
      return { date: key, succeeded: Number(dailyJobs.find((row) => row.date === key && row.status === "succeeded")?.count ?? 0), failed: Number(dailyJobs.find((row) => row.date === key && row.status === "failed")?.count ?? 0), bytesSaved: Number(dailySavings.find((row) => row.date === key)?.bytes ?? 0) };
    });
    const codecCounts = new Map<string, number>();
    for (const row of this.raw.prepare("SELECT probe_json AS probe FROM files WHERE probe_json IS NOT NULL AND updated_at>=?").all(since) as Array<{ probe: string }>) {
      try {
        const probe = JSON.parse(row.probe) as { video?: Array<{ codec?: string }> };
        for (const codec of new Set((probe.video ?? []).map((video) => video.codec?.trim().toLowerCase()).filter((value): value is string => Boolean(value)))) codecCounts.set(codec, (codecCounts.get(codec) ?? 0) + 1);
      } catch {}
    }
    const codecs = [...codecCounts].map(([codec, count]) => ({ codec, count })).sort((a, b) => b.count - a.count || a.codec.localeCompare(b.codec)).slice(0, 8);
    const libraries = (this.raw.prepare("SELECT l.name,COUNT(f.id) AS files,COALESCE(SUM(f.savings_bytes),0) AS bytesSaved FROM libraries l JOIN files f ON f.library_id=l.id WHERE f.status='processed' AND f.updated_at>=? GROUP BY l.id,l.name ORDER BY bytesSaved DESC LIMIT 8").all(since) as Array<{ name: string; files: number; bytesSaved: number }>).map((row) => ({ name: row.name, files: Number(row.files), bytesSaved: Number(row.bytesSaved) }));
    const flowCounts = new Map<string, { jobs: number; succeeded: number }>();
    for (const row of this.raw.prepare("SELECT flow_snapshot_json AS graph,status FROM jobs WHERE created_at>=?").all(since) as Array<{ graph: string; status: string }>) {
      try { const name = (JSON.parse(row.graph) as FlowGraph).name || "Untitled flow"; const current = flowCounts.get(name) ?? { jobs: 0, succeeded: 0 }; current.jobs += 1; if (row.status === "succeeded") current.succeeded += 1; flowCounts.set(name, current); } catch {}
    }
    const flows = [...flowCounts].map(([name, value]) => ({ name, ...value })).sort((a, b) => b.jobs - a.jobs || a.name.localeCompare(b.name)).slice(0, 8);
    const workers = (this.raw.prepare("SELECT COALESCE(w.name,'Unassigned') AS name,COUNT(j.id) AS jobs,SUM(CASE WHEN j.status='succeeded' THEN 1 ELSE 0 END) AS succeeded FROM jobs j LEFT JOIN workers w ON w.id=j.assigned_worker_id WHERE j.created_at>=? GROUP BY COALESCE(w.name,'Unassigned') ORDER BY jobs DESC LIMIT 8").all(since) as Array<{ name: string; jobs: number; succeeded: number }>).map((row) => ({ name: row.name, jobs: Number(row.jobs), succeeded: Number(row.succeeded) }));
    const totalDurationSeconds = Number(duration.seconds);
    return { rangeDays, summary: { totalJobs, succeeded, failed, successRate: succeeded + failed > 0 ? succeeded / (succeeded + failed) * 100 : 0, processedFiles: Number(media.count), bytesSaved: Number(media.saved), sourceBytes: Number(media.source), averageDurationSeconds: Number(duration.count) > 0 ? totalDurationSeconds / Number(duration.count) : 0, totalDurationSeconds }, timeline, jobStatuses, codecs, libraries, flows, workers };
  }
  collectMetrics(now = new Date()): string {
    const lines: string[] = [];
    const add = (name: string, help: string, type: "counter" | "gauge" | "summary", samples: string[]) => lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples);
    const jobs = this.raw.prepare("SELECT status,COUNT(*) AS count FROM jobs GROUP BY status ORDER BY status").all() as Array<{ status: string; count: number }>;
    const files = this.raw.prepare("SELECT status,COUNT(*) AS count FROM files GROUP BY status ORDER BY status").all() as Array<{ status: string; count: number }>;
    const staleBefore = new Date(now.getTime() - 45_000).toISOString();
    const workers = this.raw.prepare(`SELECT kind,CASE WHEN last_seen_at >= ? THEN 'online' ELSE 'offline' END AS status,COUNT(*) AS count FROM workers GROUP BY kind,status ORDER BY kind,status`).all(staleBefore) as Array<{ kind: string; status: string; count: number }>;
    const savings = this.raw.prepare("SELECT COALESCE(SUM(savings_bytes),0) AS bytes FROM files").get() as { bytes: number };
    const duration = this.raw.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(unixepoch(finished_at)-unixepoch(started_at)),0) AS seconds FROM jobs WHERE started_at IS NOT NULL AND finished_at IS NOT NULL").get() as { count: number; seconds: number };
    add("flowarr_jobs", "Current jobs by status.", "gauge", jobs.map((row) => `flowarr_jobs{status="${row.status}"} ${Number(row.count)}`));
    add("flowarr_files", "Current media files by status.", "gauge", files.map((row) => `flowarr_files{status="${row.status}"} ${Number(row.count)}`));
    add("flowarr_workers", "Known workers by kind and availability.", "gauge", workers.map((row) => `flowarr_workers{kind="${row.kind}",status="${row.status}"} ${Number(row.count)}`));
    add("flowarr_bytes_saved", "Bytes saved by completed processing.", "gauge", [`flowarr_bytes_saved ${Number(savings.bytes)}`]);
    add("flowarr_job_duration_seconds", "Wall time of finished jobs.", "summary", [`flowarr_job_duration_seconds_count ${Number(duration.count)}`, `flowarr_job_duration_seconds_sum ${Number(duration.seconds)}`]);
    add("flowarr_process_uptime_seconds", "Server process uptime.", "gauge", [`flowarr_process_uptime_seconds ${process.uptime()}`]);
    return `${lines.join("\n")}\n`;
  }
  getFlow(id: string): { id: string; name: string; graph: FlowGraph; revision: number } | null {
    const row = this.raw.prepare("SELECT * FROM flows WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? { id: String(row.id), name: String(row.name), graph: JSON.parse(String(row.graph_json)) as FlowGraph, revision: Number(row.revision) } : null;
  }
}

function mapLibrary(row: Record<string, unknown>): Library { return { id: String(row.id), name: String(row.name), path: String(row.path), flowId: row.flow_id ? String(row.flow_id) : null, enabled: Boolean(row.enabled), priority: Number(row.priority), extensions: JSON.parse(String(row.extensions_json)) as string[], stabilitySeconds: Number(row.stability_seconds), createdAt: String(row.created_at) }; }
function mapFile(row: Record<string, unknown>): MediaFile { return { id: String(row.id), libraryId: String(row.library_id), path: String(row.path), name: String(row.name), size: Number(row.size), status: row.status as MediaFile["status"], probe: row.probe_json ? JSON.parse(String(row.probe_json)) : null, savingsBytes: Number(row.savings_bytes), detectedAt: String(row.detected_at), failureJobId: row.failure_job_id ? String(row.failure_job_id) : null }; }
function mapJob(row: Record<string, unknown>): Job { return { id: String(row.id), fileId: String(row.file_id), status: row.status as Job["status"], progress: Number(row.progress), speed: row.speed ? String(row.speed) : null, etaSeconds: row.eta_seconds === null ? null : Number(row.eta_seconds), error: row.error ? String(row.error) : null, createdAt: String(row.created_at), startedAt: row.started_at ? String(row.started_at) : null, finishedAt: row.finished_at ? String(row.finished_at) : null, workerId: row.assigned_worker_id ? String(row.assigned_worker_id) : null }; }
