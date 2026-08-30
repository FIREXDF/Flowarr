import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultHevcFlow } from "@flowarr/flow-engine";
import type { WorkerCapabilities, WorkerSchedule } from "@flowarr/shared";
import { Database } from "./database.js";
import { chooseWorker, createRegistrationToken, expireWorkerLeases, isWorkerScheduleActive, LOCAL_WORKER_ID, mapPathForWorker, registerWorker, releaseUnavailableAssignments, setWorkerPriority, setWorkerSchedule } from "./workers.js";
test("Prometheus metrics expose durable queue and worker state", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowarr-metrics-"));
  const database = new Database(directory);
  try {
    const now = "2026-08-28T12:00:00.000Z";
    database.raw.prepare("INSERT INTO flows (id,name,graph_json,created_at,updated_at) VALUES ('flow','Flow','{}',?,?)").run(now, now);
    database.raw.prepare("INSERT INTO libraries (id,name,path,flow_id,extensions_json,created_at) VALUES ('library','Media','D:\\Media','flow','[]',?)").run(now);
    database.raw.prepare("INSERT INTO files (id,library_id,path,name,size,status,savings_bytes,detected_at,updated_at) VALUES ('file','library','D:\\Media\\film.mkv','film.mkv',800,'processed',200,?,?)").run(now, now);
    database.raw.prepare("INSERT INTO jobs (id,file_id,flow_snapshot_json,status,created_at,started_at,finished_at) VALUES ('job','file','{}','succeeded',?,'2026-08-28T11:59:50.000Z',?)").run(now, now);
    database.raw.prepare("INSERT INTO workers (id,name,kind,capabilities_json,path_mappings_json,last_seen_at,created_at) VALUES ('worker','Remote','remote','{}','[]',?,?)").run(now, now);
    const output = database.collectMetrics(new Date(now));
    assert.match(output, /flowarr_jobs\{status="succeeded"\} 1/);
    assert.match(output, /flowarr_workers\{kind="remote",status="online"\} 1/);
    assert.match(output, /flowarr_bytes_saved 200/);
    assert.match(output, /flowarr_job_duration_seconds_sum 10(?:\.0+)?/);
  } finally { database.raw.close(); await rm(directory, { recursive: true, force: true }); }
});

const workerCapabilities: WorkerCapabilities = {
  platform: "win32", architecture: "x64", cpu: "test", logicalCpus: 8, totalMemory: 16_000, freeMemory: 8_000,
  ffmpeg: { available: true, version: "test", encoders: ["libx264", "libx265"] }
};

test("registration tokens are one-use and compatible workers are scheduled", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowarr-workers-"));
  const database = new Database(directory);
  try {
    const registration = createRegistrationToken(database, 1);
    const worker = registerWorker(database, registration.token, "encoder-1", workerCapabilities, [{ serverPath: "D:\\Media", workerPath: "E:\\Library" }]);
    assert.throws(() => registerWorker(database, registration.token, "encoder-2", workerCapabilities, [{ serverPath: "D:\\Media", workerPath: "E:\\Library" }]), /Invalid or expired/);
    assert.equal(chooseWorker(database, "D:\\Media\\Movies\\film.mkv", defaultHevcFlow()), worker.id);
    assert.equal(mapPathForWorker(database, worker.id, "D:\\Media\\Movies\\film.mkv"), "E:\\Library\\Movies\\film.mkv");
    assert.equal(chooseWorker(database, "D:\\Private\\film.mkv", defaultHevcFlow()), null);
  } finally {
    database.raw.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("scheduler rejects a worker missing the required encoder", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowarr-workers-"));
  const database = new Database(directory);
  try {
    const registration = createRegistrationToken(database, 1);
    registerWorker(database, registration.token, "h264-only", { ...workerCapabilities, ffmpeg: { available: true, encoders: ["libx264"] } }, [{ serverPath: "D:\\Media", workerPath: "D:\\Media" }]);
    assert.equal(chooseWorker(database, "D:\\Media\\film.mkv", defaultHevcFlow()), null);
  } finally {
    database.raw.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("weekly schedules support daytime and overnight working windows", () => {
  assert.equal(isWorkerScheduleActive({ mode: "disabled", timezone: "UTC", days: [], start: "00:00", end: "23:59" }), false);
  const daytime: WorkerSchedule = { mode: "scheduled", timezone: "UTC", days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00" };
  assert.equal(isWorkerScheduleActive(daytime, new Date("2026-08-24T09:00:00Z")), true);
  assert.equal(isWorkerScheduleActive(daytime, new Date("2026-08-23T09:00:00Z")), false);
  const overnight: WorkerSchedule = { mode: "scheduled", timezone: "UTC", days: [1], start: "22:00", end: "06:00" };
  assert.equal(isWorkerScheduleActive(overnight, new Date("2026-08-24T23:00:00Z")), true);
  assert.equal(isWorkerScheduleActive(overnight, new Date("2026-08-25T02:00:00Z")), true);
  assert.equal(isWorkerScheduleActive(overnight, new Date("2026-08-25T07:00:00Z")), false);
});

test("scheduler does not assign jobs to a node outside its working window", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowarr-workers-"));
  const database = new Database(directory);
  try {
    const worker = registerWorker(database, createRegistrationToken(database, 1).token, "scheduled", workerCapabilities, [{ serverPath: "D:\\Media", workerPath: "D:\\Media" }]);
    setWorkerSchedule(database, worker.id, { mode: "scheduled", timezone: "UTC", days: [(new Date().getUTCDay() + 1) % 7], start: "00:00", end: "23:59" });
    assert.equal(chooseWorker(database, "D:\\Media\\film.mkv", defaultHevcFlow()), null);
    const now = new Date().toISOString();
    database.raw.prepare("INSERT INTO libraries (id,name,path,extensions_json,stability_seconds,created_at) VALUES ('library','Media','D:\\Media','[\"mkv\"]',1,?)").run(now);
    database.raw.prepare("INSERT INTO files (id,library_id,path,name,size,status,detected_at,updated_at) VALUES ('file','library','D:\\Media\\film.mkv','film.mkv',1000,'queued',?,?)").run(now, now);
    database.raw.prepare("INSERT INTO jobs (id,file_id,flow_snapshot_json,status,assigned_worker_id,created_at) VALUES ('job','file',?,'queued',?,?)").run(JSON.stringify(defaultHevcFlow()), worker.id, now);
    assert.equal(releaseUnavailableAssignments(database), 1);
    assert.equal((database.raw.prepare("SELECT assigned_worker_id AS workerId FROM jobs WHERE id='job'").get() as { workerId: string | null }).workerId, null);
  } finally {
    database.raw.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("scheduler chooses the highest-priority compatible node", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowarr-workers-"));
  const database = new Database(directory);
  try {
    const first = registerWorker(database, createRegistrationToken(database, 1).token, "powerful", { ...workerCapabilities, freeMemory: 64_000 }, [{ serverPath: "D:\\Media", workerPath: "D:\\Media" }]);
    const second = registerWorker(database, createRegistrationToken(database, 1).token, "preferred", { ...workerCapabilities, freeMemory: 1_000 }, [{ serverPath: "D:\\Media", workerPath: "D:\\Media" }]);
    setWorkerPriority(database, first.id, 10);
    setWorkerPriority(database, second.id, 80);
    assert.equal(chooseWorker(database, "D:\\Media\\film.mkv", defaultHevcFlow()), second.id);
    const now = new Date().toISOString();
    database.raw.prepare("INSERT INTO libraries (id,name,path,extensions_json,stability_seconds,created_at) VALUES ('library','Media','D:\\Media','[\"mkv\"]',1,?)").run(now);
    database.raw.prepare("INSERT INTO files (id,library_id,path,name,size,status,detected_at,updated_at) VALUES ('file','library','D:\\Media\\first.mkv','first.mkv',1000,'queued',?,?)").run(now, now);
    database.raw.prepare("INSERT INTO jobs (id,file_id,flow_snapshot_json,status,assigned_worker_id,created_at) VALUES ('job','file',?,'queued',?,?)")
      .run(JSON.stringify(defaultHevcFlow()), second.id, now);
    assert.equal(chooseWorker(database, "D:\\Media\\second.mkv", defaultHevcFlow()), first.id);
  } finally {
    database.raw.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local node uses server paths directly without mappings", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowarr-workers-"));
  const database = new Database(directory);
  try {
    const now = new Date().toISOString();
    database.raw.prepare("INSERT INTO workers (id,name,kind,priority,capabilities_json,path_mappings_json,last_seen_at,created_at) VALUES (?,?,'local',50,?,'[]',?,?)")
      .run(LOCAL_WORKER_ID, "server (local)", JSON.stringify(workerCapabilities), now, now);
    const source = "D:\\Unmapped\\film.mkv";
    assert.equal(chooseWorker(database, source, defaultHevcFlow()), LOCAL_WORKER_ID);
    assert.equal(mapPathForWorker(database, LOCAL_WORKER_ID, source), source);
  } finally {
    database.raw.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired remote leases fail safely instead of running a job twice", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowarr-workers-"));
  const database = new Database(directory);
  try {
    const now = new Date().toISOString();
    const registration = createRegistrationToken(database, 1);
    const worker = registerWorker(database, registration.token, "expired-worker", workerCapabilities, [{ serverPath: "D:\\Media", workerPath: "D:\\Media" }]);
    database.raw.prepare("INSERT INTO libraries (id,name,path,extensions_json,stability_seconds,created_at) VALUES ('library','Media','D:\\Media','[\"mkv\"]',1,?)").run(now);
    database.raw.prepare("INSERT INTO files (id,library_id,path,name,size,status,detected_at,updated_at) VALUES ('file','library','D:\\Media\\film.mkv','film.mkv',1000,'processing',?,?)").run(now, now);
    database.raw.prepare("INSERT INTO jobs (id,file_id,flow_snapshot_json,status,assigned_worker_id,lease_expires_at,created_at) VALUES ('job','file','{}','running',?,? ,?)")
      .run(worker.id, new Date(Date.now() - 1_000).toISOString(), now);
    assert.equal(expireWorkerLeases(database), 1);
    const job = database.raw.prepare("SELECT status,error FROM jobs WHERE id='job'").get() as { status: string; error: string };
    assert.equal(job.status, "failed");
    assert.match(job.error, /lease expired/);
  } finally {
    database.raw.close();
    await rm(directory, { recursive: true, force: true });
  }
});
