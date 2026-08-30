import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { expandSubflows, starterFlow, resolvePath, validateFlow, type StarterFlowKind } from "@flowarr/flow-engine";
import { buildPlan, ffmpegArgs } from "@flowarr/ffmpeg";
import { PluginRegistry } from "@flowarr/plugin-sdk";
import type { FlowGraph, NormalizedProbe, PathMapping, WorkerCapabilities, WorkerSchedule } from "@flowarr/shared";
import { hashPassword, verifyPassword } from "./auth.js";
import { Database } from "./database.js";
import { EventHub, WebhookNotifier } from "./events.js";
import { createIntegration, deleteIntegration, listIntegrations, refreshEnabledIntegrations, refreshIntegration, testIntegration, updateIntegration } from "./integrations.js";
import { deleteLibrary, updateLibrary } from "./libraries.js";
import { LocalRunner } from "./runner.js";
import { scanLibrary } from "./scanner.js";
import { assignQueuedJobs, createRegistrationToken, ensureLocalWorker, expireWorkerLeases, listWorkers, LOCAL_WORKER_ID, mapPathForWorker, refreshLocalWorker, registerWorker, releaseStaleAssignments, releaseUnavailableAssignments, setWorkerPriority, setWorkerSchedule, validateWorkerCapabilities } from "./workers.js";

const dataDir = path.resolve(process.env.FLOWARR_DATA_DIR ?? "./data");
const pluginDir = path.resolve(process.env.FLOWARR_PLUGIN_DIR ?? "./plugins");
const db = new Database(dataDir);
const plugins = new PluginRegistry(pluginDir);
const integrationKey = process.env.FLOWARR_ENCRYPTION_KEY ?? process.env.FLOWARR_JWT_SECRET ?? "development-only-change-me";
const webhook = process.env.FLOWARR_WEBHOOK_URL ? new WebhookNotifier(process.env.FLOWARR_WEBHOOK_URL, process.env.FLOWARR_WEBHOOK_SECRET) : undefined;
const events = new EventHub(webhook, async () => { await refreshEnabledIntegrations(db, integrationKey); });
await ensureLocalWorker(db);
const runner = new LocalRunner(db, events, LOCAL_WORKER_ID, plugins);
const app = Fastify({ logger: true, bodyLimit: 1_000_000 });

function validMetricsToken(authorization: string | undefined): boolean {
  const configured = process.env.FLOWARR_METRICS_TOKEN;
  if (!configured || !authorization?.startsWith("Bearer ")) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(authorization.slice(7)), digest(configured));
}

function materializeFlow(flowId: string, graph: FlowGraph): FlowGraph {
  return plugins.expandGraph(expandSubflows(flowId, graph, (referencedId) => db.getFlow(referencedId)?.graph ?? null));
}

await app.register(cors, { origin: process.env.NODE_ENV === "production" ? false : true });
await app.register(cookie);
await app.register(jwt, { secret: process.env.FLOWARR_JWT_SECRET ?? "development-only-change-me" });

app.addHook("onRequest", async (request, reply) => {
  const publicPaths = ["/api/health", "/api/auth/status", "/api/auth/setup", "/api/auth/login", "/api/workers/register"];
  if (!request.url.startsWith("/api/") || publicPaths.includes(request.url.split("?")[0] ?? "")) return;
  if (request.url.split("?")[0] === "/api/metrics" && validMetricsToken(request.headers.authorization)) return;
  if (request.url.startsWith("/api/events")) {
    const token = request.cookies.flowarr_session;
    try { if (!token) throw new Error("missing token"); app.jwt.verify(token); return; } catch { return reply.code(401).send({ error: "Authentication required" }); }
  }
  try {
    await request.jwtVerify();
    const identity = request.user as { role?: string; workerId?: string };
    if (identity.role === "worker" && (!identity.workerId || !request.url.startsWith(`/api/workers/${identity.workerId}/`))) {
      return reply.code(403).send({ error: "Worker token cannot access this endpoint" });
    }
  } catch { return reply.code(401).send({ error: "Authentication required" }); }
});

app.get("/api/health", async () => ({ status: "ok", name: "Flowarr", version: "0.1.0" }));
app.get("/api/metrics", async (_request, reply) => reply.type("text/plain; version=0.0.4; charset=utf-8").send(db.collectMetrics()));
app.get("/api/plugins", async () => plugins.snapshot());
app.post("/api/plugins/reload", async () => plugins.reload());
app.get("/api/auth/status", async () => ({ setupRequired: !db.hasUsers() }));
app.post<{ Body: { username?: string; password?: string } }>("/api/auth/setup", async (request, reply) => {
  if (db.hasUsers()) return reply.code(409).send({ error: "Administrator already exists" });
  const username = request.body.username?.trim(); const password = request.body.password ?? "";
  if (!username) return reply.code(400).send({ error: "Username is required" });
  try {
    db.raw.prepare("INSERT INTO users (id,username,password_hash,created_at) VALUES (?,?,?,?)").run(randomUUID(), username, hashPassword(password), new Date().toISOString());
    const token = app.jwt.sign({ username, role: "administrator" }, { expiresIn: "12h" });
    reply.setCookie("flowarr_session", token, { httpOnly: true, sameSite: "strict", secure: process.env.FLOWARR_SECURE_COOKIES === "true", path: "/api/events", maxAge: 43_200 });
    return { token };
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", async (request, reply) => {
  const user = db.raw.prepare("SELECT username,password_hash FROM users WHERE username=?").get(request.body.username ?? "") as { username: string; password_hash: string } | undefined;
  if (!user || !verifyPassword(request.body.password ?? "", user.password_hash)) return reply.code(401).send({ error: "Invalid credentials" });
  const token = app.jwt.sign({ username: user.username, role: "administrator" }, { expiresIn: "12h" });
  reply.setCookie("flowarr_session", token, { httpOnly: true, sameSite: "strict", secure: process.env.FLOWARR_SECURE_COOKIES === "true", path: "/api/events", maxAge: 43_200 });
  return { token };
});

app.get("/api/integrations", async () => listIntegrations(db));
app.post<{ Body: { kind?: "sonarr" | "radarr" | "jellyfin"; name?: string; baseUrl?: string; apiKey?: string; enabled?: boolean; syncOnSuccess?: boolean } }>("/api/integrations", async (request, reply) => {
  try {
    if (!request.body.kind) return reply.code(400).send({ error: "Provider is required" });
    return reply.code(201).send(createIntegration(db, { kind: request.body.kind, name: request.body.name ?? "", baseUrl: request.body.baseUrl ?? "", apiKey: request.body.apiKey ?? "", enabled: request.body.enabled, syncOnSuccess: request.body.syncOnSuccess }, integrationKey));
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.patch<{ Params: { id: string }; Body: { name?: string; baseUrl?: string; apiKey?: string; enabled?: boolean; syncOnSuccess?: boolean } }>("/api/integrations/:id", async (request, reply) => {
  try {
    const integration = updateIntegration(db, request.params.id, request.body, integrationKey);
    return integration ?? reply.code(404).send({ error: "Integration not found" });
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.delete<{ Params: { id: string } }>("/api/integrations/:id", async (request, reply) => deleteIntegration(db, request.params.id) ? reply.code(204).send() : reply.code(404).send({ error: "Integration not found" }));
app.post<{ Params: { id: string } }>("/api/integrations/:id/refresh", async (request, reply) => {
  try { return await refreshIntegration(db, request.params.id, integrationKey); }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});app.post<{ Params: { id: string } }>("/api/integrations/:id/test", async (request, reply) => {
  try { return await testIntegration(db, request.params.id, integrationKey); }
  catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/workers", async () => listWorkers(db));
app.patch<{ Params: { id: string }; Body: { priority?: number; schedule?: WorkerSchedule } }>("/api/workers/:id", async (request, reply) => {
  const identity = request.user as { role?: string };
  if (identity.role !== "administrator") return reply.code(403).send({ error: "Administrator access required" });
  try {
    if (request.body.priority === undefined && request.body.schedule === undefined) return reply.code(400).send({ error: "Priority or schedule is required" });
    let worker = request.body.priority === undefined ? listWorkers(db).find((item) => item.id === request.params.id) ?? null : setWorkerPriority(db, request.params.id, Number(request.body.priority));
    if (worker && request.body.schedule !== undefined) worker = setWorkerSchedule(db, request.params.id, request.body.schedule);
    if (!worker) return reply.code(404).send({ error: "Worker not found" });
    releaseUnavailableAssignments(db); assignQueuedJobs(db); void runner.pump();
    return worker;
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post<{ Body: { ttlHours?: number } }>("/api/workers/tokens", async (request, reply) => {
  return reply.code(201).send(createRegistrationToken(db, request.body.ttlHours));
});
app.post<{ Body: { token?: string; name?: string; capabilities?: WorkerCapabilities; pathMappings?: PathMapping[] } }>("/api/workers/register", async (request, reply) => {
  const token = request.body.token ?? ""; const name = request.body.name?.trim() ?? "";
  if (!token || !name || !request.body.capabilities || !request.body.pathMappings) return reply.code(400).send({ error: "Token, name, capabilities and path mappings are required" });
  try {
    const worker = registerWorker(db, token, name, request.body.capabilities, request.body.pathMappings);
    const workerToken = app.jwt.sign({ role: "worker", workerId: worker.id, name: worker.name }, { expiresIn: "30d" });
    return reply.code(201).send({ worker, token: workerToken });
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post<{ Params: { id: string }; Body: { capabilities?: WorkerCapabilities } }>("/api/workers/:id/heartbeat", async (request, reply) => {
  const now = new Date().toISOString();
  if (request.body.capabilities) {
    try { validateWorkerCapabilities(request.body.capabilities); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  }
  const result = request.body.capabilities
    ? db.raw.prepare("UPDATE workers SET last_seen_at=?,capabilities_json=? WHERE id=?").run(now, JSON.stringify(request.body.capabilities), request.params.id)
    : db.raw.prepare("UPDATE workers SET last_seen_at=? WHERE id=?").run(now, request.params.id);
  if (!result.changes) return reply.code(404).send({ error: "Worker not found" });
  const lease = new Date(Date.now() + 60_000).toISOString();
  db.raw.prepare("UPDATE jobs SET lease_expires_at=? WHERE assigned_worker_id=? AND status='running'").run(lease, request.params.id);
  assignQueuedJobs(db); void runner.pump();
  return { ok: true, serverTime: now };
});
app.post<{ Params: { id: string } }>("/api/workers/:id/jobs/claim", async (request, reply) => {
  releaseStaleAssignments(db);
  releaseUnavailableAssignments(db);
  assignQueuedJobs(db);
  void runner.pump();
  const job = db.raw.prepare("SELECT j.*,f.path,f.size FROM jobs j JOIN files f ON f.id=j.file_id WHERE j.assigned_worker_id=? AND j.status='queued' ORDER BY j.priority DESC,j.created_at LIMIT 1")
    .get(request.params.id) as Record<string, unknown> | undefined;
  if (!job) return reply.code(204).send();
  const now = new Date().toISOString(); const lease = new Date(Date.now() + 60_000).toISOString();
  const claimed = db.raw.prepare("UPDATE jobs SET status='running',started_at=?,lease_expires_at=? WHERE id=? AND status='queued'").run(now, lease, String(job.id));
  if (!claimed.changes) return reply.code(409).send({ error: "Job already claimed" });
  db.raw.prepare("UPDATE files SET status='processing',updated_at=? WHERE id=?").run(now, String(job.file_id));
  events.send("job", { id: String(job.id), status: "running", progress: 0, workerId: request.params.id });
  try {
    return {
      id: String(job.id), fileId: String(job.file_id), sourcePath: mapPathForWorker(db, request.params.id, String(job.path)),
      sourceSize: Number(job.size), graph: JSON.parse(String(job.flow_snapshot_json)) as FlowGraph
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.raw.prepare("UPDATE jobs SET status='failed',error=?,finished_at=? WHERE id=?").run(message, now, String(job.id));
    db.raw.prepare("UPDATE files SET status='failed',updated_at=? WHERE id=?").run(now, String(job.file_id));
    return reply.code(400).send({ error: message });
  }
});
app.post<{ Params: { id: string; jobId: string }; Body: { progress?: number; speed?: string | null } }>("/api/workers/:id/jobs/:jobId/progress", async (request, reply) => {
  const progress = Math.max(0, Math.min(99, Number(request.body.progress ?? 0)));
  const result = db.raw.prepare("UPDATE jobs SET progress=?,speed=?,lease_expires_at=? WHERE id=? AND assigned_worker_id=? AND status='running'")
    .run(progress, request.body.speed ?? null, new Date(Date.now() + 60_000).toISOString(), request.params.jobId, request.params.id);
  if (!result.changes) return reply.code(404).send({ error: "Active job not found" });
  events.send("job", { id: request.params.jobId, status: "running", progress, speed: request.body.speed ?? null });
  return { ok: true };
});
app.post<{ Params: { id: string; jobId: string }; Body: { status?: "succeeded" | "failed"; savingsBytes?: number; outputSize?: number; probe?: NormalizedProbe; error?: string } }>("/api/workers/:id/jobs/:jobId/complete", async (request, reply) => {
  const job = db.raw.prepare("SELECT file_id FROM jobs WHERE id=? AND assigned_worker_id=? AND status='running'").get(request.params.jobId, request.params.id) as { file_id: string } | undefined;
  if (!job) return reply.code(404).send({ error: "Active job not found" });
  const now = new Date().toISOString();
  if (request.body.status === "succeeded") {
    db.transaction(() => {
      db.raw.prepare("UPDATE jobs SET status='succeeded',progress=100,lease_expires_at=NULL,finished_at=? WHERE id=?").run(now, request.params.jobId);
      db.raw.prepare("UPDATE files SET status='processed',savings_bytes=?,size=COALESCE(?,size),probe_json=COALESCE(?,probe_json),updated_at=? WHERE id=?")
        .run(Math.max(0, Number(request.body.savingsBytes ?? 0)), request.body.outputSize ?? null, request.body.probe ? JSON.stringify(request.body.probe) : null, now, job.file_id);
    });
    events.send("job", { id: request.params.jobId, status: "succeeded", progress: 100 });
  } else {
    const message = request.body.error?.slice(0, 4000) || "Remote worker failed";
    db.transaction(() => {
      db.raw.prepare("UPDATE jobs SET status='failed',error=?,lease_expires_at=NULL,finished_at=? WHERE id=?").run(message, now, request.params.jobId);
      db.raw.prepare("UPDATE files SET status='failed',updated_at=? WHERE id=?").run(now, job.file_id);
      db.raw.prepare("INSERT INTO job_logs (job_id,level,message,created_at) VALUES (?,'ERROR',?,?)").run(request.params.jobId, message, now);
    });
    events.send("job", { id: request.params.jobId, status: "failed", error: message });
  }
  assignQueuedJobs(db); void runner.pump();
  return { ok: true };
});

app.get("/api/libraries", async () => db.listLibraries());
app.post<{ Body: { name?: string; path?: string; flowId?: string; extensions?: string[]; stabilitySeconds?: number } }>("/api/libraries", async (request, reply) => {
  const name = request.body.name?.trim(); const libraryPath = request.body.path?.trim(); const flowId = request.body.flowId?.trim();
  if (!name || !libraryPath || !flowId) return reply.code(400).send({ error: "Name, path and flow are required" });
  if (!db.getFlow(flowId)) return reply.code(400).send({ error: "Selected flow does not exist" });
  const id = randomUUID(); const now = new Date().toISOString();
  try {
    db.raw.prepare("INSERT INTO libraries (id,name,path,flow_id,extensions_json,stability_seconds,created_at) VALUES (?,?,?,?,?,?,?)").run(id, name, path.resolve(libraryPath), flowId, JSON.stringify(request.body.extensions ?? ["mkv", "mp4", "avi", "mov", "webm"]), Math.max(1, request.body.stabilitySeconds ?? 30), now);
    return reply.code(201).send(db.listLibraries().find((item) => item.id === id));
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.patch<{ Params: { id: string }; Body: { name?: string; path?: string; flowId?: string; extensions?: string[]; stabilitySeconds?: number; enabled?: boolean } }>("/api/libraries/:id", async (request, reply) => {
  try {
    const library = updateLibrary(db, request.params.id, request.body);
    return library ?? reply.code(404).send({ error: "Library not found" });
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.delete<{ Params: { id: string } }>("/api/libraries/:id", async (request, reply) => {
  const result = deleteLibrary(db, request.params.id);
  if (result === "not-found") return reply.code(404).send({ error: "Library not found" });
  if (result === "active-jobs") return reply.code(409).send({ error: "Wait for queued or running jobs from this library to finish before deleting it" });
  return reply.code(204).send();
});
app.post<{ Params: { id: string } }>("/api/libraries/:id/scan", async (request, reply) => {
  try { return await scanLibrary(db, request.params.id); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});

app.get<{ Querystring: { status?: string } }>("/api/files", async (request) => db.listFiles(request.query.status));
app.post<{ Params: { id: string } }>("/api/files/:id/process", async (request, reply) => {
  try { return reply.code(202).send({ jobId: runner.enqueue(request.params.id) }); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/jobs", async () => db.listJobs());
app.get<{ Params: { id: string } }>("/api/jobs/:id/logs", async (request) => db.raw.prepare("SELECT level,message,detail_json AS detail,created_at AS createdAt FROM job_logs WHERE job_id=? ORDER BY id").all(request.params.id));

app.get("/api/flows", async () => (db.raw.prepare("SELECT id,name,revision,updated_at AS updatedAt FROM flows ORDER BY name").all()));
app.get<{ Params: { id: string } }>("/api/flows/:id", async (request, reply) => db.getFlow(request.params.id) ?? reply.code(404).send({ error: "Flow not found" }));
app.post<{ Body: { graph?: FlowGraph; comment?: string } }>("/api/flows", async (request, reply) => {
  const graph = request.body.graph; if (!graph) return reply.code(400).send({ error: "Graph is required" });
  const id = randomUUID(); const errors = validateFlow(graph); if (errors.length) return reply.code(400).send({ error: "Invalid flow", problems: errors });
  try { materializeFlow(id, graph); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  const now = new Date().toISOString(); const json = JSON.stringify(graph);
  db.transaction(() => {
    db.raw.prepare("INSERT INTO flows (id,name,graph_json,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, graph.name, json, now, now);
    db.raw.prepare("INSERT INTO flow_revisions (id,flow_id,revision,graph_json,comment,created_at) VALUES (?,?,1,?,?,?)").run(randomUUID(), id, json, request.body.comment ?? null, now);
  }); return reply.code(201).send({ id, name: graph.name, graph, revision: 1 });
});
app.put<{ Params: { id: string }; Body: { graph?: FlowGraph; comment?: string } }>("/api/flows/:id", async (request, reply) => {
  const graph = request.body.graph; if (!graph) return reply.code(400).send({ error: "Graph is required" });
  const errors = validateFlow(graph); if (errors.length) return reply.code(400).send({ error: "Invalid flow", problems: errors });
  const current = db.getFlow(request.params.id); if (!current) return reply.code(404).send({ error: "Flow not found" });
  try { materializeFlow(request.params.id, graph); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  const revision = current.revision + 1; const now = new Date().toISOString(); const json = JSON.stringify(graph);
  db.transaction(() => {
    db.raw.prepare("UPDATE flows SET name=?,graph_json=?,revision=?,updated_at=? WHERE id=?").run(graph.name, json, revision, now, request.params.id);
    db.raw.prepare("INSERT INTO flow_revisions (id,flow_id,revision,graph_json,comment,created_at) VALUES (?,?,?,?,?,?)").run(randomUUID(), request.params.id, revision, json, request.body.comment ?? null, now);
  }); return { id: request.params.id, name: graph.name, graph, revision };
});
app.post<{ Params: { template: string } }>("/api/flows/templates/:template", async (request, reply) => {
  const templates = new Set<StarterFlowKind>(["blank", "hevc", "gpu", "audio"]);
  if (!templates.has(request.params.template as StarterFlowKind)) return reply.code(404).send({ error: "Flow template not found" });
  const graph = starterFlow(request.params.template as StarterFlowKind); const id = randomUUID(); const now = new Date().toISOString(); const json = JSON.stringify(graph);
  db.raw.prepare("INSERT INTO flows (id,name,graph_json,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, graph.name, json, now, now);
  db.raw.prepare("INSERT INTO flow_revisions (id,flow_id,revision,graph_json,comment,created_at) VALUES (?,?,1,?,'Starter template',?)").run(randomUUID(), id, json, now);
  return reply.code(201).send({ id, name: graph.name, graph, revision: 1 });
});
app.patch<{ Params: { id: string }; Body: { name?: string } }>("/api/flows/:id/name", async (request, reply) => {
  const name = request.body.name?.trim(); if (!name) return reply.code(400).send({ error: "Flow name is required" });
  if (name.length > 80) return reply.code(400).send({ error: "Flow name must be 80 characters or fewer" });
  const current = db.getFlow(request.params.id); if (!current) return reply.code(404).send({ error: "Flow not found" });
  const graph = { ...current.graph, name }; const now = new Date().toISOString();
  db.raw.prepare("UPDATE flows SET name=?,graph_json=?,updated_at=? WHERE id=?").run(name, JSON.stringify(graph), now, request.params.id);
  return { id: request.params.id, name, graph, revision: current.revision };
});
app.post<{ Params: { id: string }; Body: { fileId?: string; graph?: FlowGraph } }>("/api/flows/:id/test", async (request, reply) => {
  const current = db.getFlow(request.params.id); if (!current) return reply.code(404).send({ error: "Flow not found" });
  const graph = request.body.graph ?? current.graph;
  const problems = validateFlow(graph); if (problems.length) return reply.code(400).send({ error: "Invalid flow", problems });
  const file = db.raw.prepare("SELECT path,probe_json AS probeJson FROM files WHERE id=?").get(request.body.fileId ?? "") as { path: string; probeJson: string | null } | undefined;
  if (!file) return reply.code(404).send({ error: "Media file not found" });
  if (!file.probeJson) return reply.code(400).send({ error: "Media file has not been probed yet" });
  try {
    const expanded = materializeFlow(request.params.id, graph);
    const nodes = resolvePath(expanded, JSON.parse(file.probeJson) as NormalizedProbe);
    const executes = nodes.some((node) => node.kind === "ffmpeg-execute");
    const command = executes ? ["ffmpeg", ...ffmpegArgs(buildPlan(nodes, file.path, "{preview-output}"))] : null;
    return { path: nodes.map((node) => ({ id: node.id, kind: node.kind })), executes, command };
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});
app.delete<{ Params: { id: string } }>("/api/flows/:id", async (request, reply) => {
  const current = db.getFlow(request.params.id); if (!current) return reply.code(404).send({ error: "Flow not found" });
  const usage = db.raw.prepare("SELECT COUNT(*) AS count FROM libraries WHERE flow_id=?").get(request.params.id) as { count: number };
  if (Number(usage.count) > 0) {
    const suffix = Number(usage.count) === 1 ? "library" : "libraries";
    return reply.code(409).send({ error: `Flow is used by ${usage.count} ${suffix}. Reassign them before deleting it.` });
  }
  const reference = (db.raw.prepare("SELECT id,name,graph_json AS graphJson FROM flows WHERE id<>?").all(request.params.id) as Array<{ id: string; name: string; graphJson: string }>).find((flow) => (JSON.parse(flow.graphJson) as FlowGraph).nodes.some((node) => node.kind === "subflow" && node.config?.flowId === request.params.id));
  if (reference) return reply.code(409).send({ error: `Flow is used as a subflow by “${reference.name}”. Remove that block before deleting it.` });
  db.raw.prepare("DELETE FROM flows WHERE id=?").run(request.params.id);
  return reply.code(204).send();
});

app.get("/api/dashboard", async () => {
  const counts = db.raw.prepare("SELECT status,COUNT(*) AS count FROM jobs GROUP BY status").all();
  const savings = db.raw.prepare("SELECT COALESCE(SUM(savings_bytes),0) AS bytes FROM files").get() as { bytes: number };
  return { jobs: counts, bytesSaved: Number(savings.bytes), recent: db.listFiles().filter((file) => file.status === "processed").slice(0, 8), active: db.listJobs().filter((job) => job.status === "running") };
});
app.get<{ Querystring: { days?: string } }>("/api/statistics", async (request) => db.getStatistics(Number(request.query.days ?? 30)));
app.get("/api/events", async (request, reply) => {
  reply.hijack(); reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": "*" });
  reply.raw.write("event: ready\ndata: {}\n\n"); events.add(reply.raw);
});

const webDir = path.resolve(process.env.FLOWARR_WEB_DIR ?? "apps/web/dist");
if (existsSync(webDir)) {
  await app.register(fastifyStatic, { root: webDir, wildcard: false });
  app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html"));
}

const port = Number(process.env.FLOWARR_PORT ?? 3000); const host = process.env.FLOWARR_HOST ?? "127.0.0.1";
await app.listen({ port, host });
assignQueuedJobs(db);
void runner.pump();
setInterval(() => {
  refreshLocalWorker(db);
  expireWorkerLeases(db, events);
  releaseStaleAssignments(db);
  releaseUnavailableAssignments(db);
  assignQueuedJobs(db);
  void runner.pump();
}, 15_000).unref();
