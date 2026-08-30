import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Database } from "./database.js";

test("statistics aggregate jobs, savings, codecs, flows, libraries and workers", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowarr-statistics-"));
  const database = new Database(directory);
  try {
    const now = "2026-08-29T12:00:00.000Z";
    const graph = JSON.stringify({ version: 1, name: "HEVC archive", nodes: [], edges: [] });
    const probe = JSON.stringify({ format: { name: "matroska", duration: 120, size: 800, bitrate: 10 }, video: [{ index: 0, codec: "hevc", width: 1920, height: 1080, pixelFormat: "yuv420p", bitDepth: 8, hdr: false, bitrate: 8, frameRate: 24 }], audio: [], subtitles: [] });
    database.raw.prepare("INSERT INTO flows (id,name,graph_json,created_at,updated_at) VALUES ('flow','HEVC archive',?,?,?)").run(graph, now, now);
    database.raw.prepare("INSERT INTO libraries (id,name,path,flow_id,extensions_json,created_at) VALUES ('library','Movies','D:\\Media','flow','[\"mkv\"]',?)").run(now);
    database.raw.prepare("INSERT INTO files (id,library_id,path,name,size,status,probe_json,savings_bytes,detected_at,updated_at) VALUES ('file','library','D:\\Media\\movie.mkv','movie.mkv',800,'processed',?,200,?,?)").run(probe, now, now);
    database.raw.prepare("INSERT INTO workers (id,name,capabilities_json,path_mappings_json,last_seen_at,created_at) VALUES ('worker','Media node','{}','[]',?,?)").run(now, now);
    database.raw.prepare("INSERT INTO jobs (id,file_id,flow_snapshot_json,status,assigned_worker_id,created_at,started_at,finished_at) VALUES ('success','file',?,'succeeded','worker',?,'2026-08-29T11:59:40.000Z',?)").run(graph, now, now);
    database.raw.prepare("INSERT INTO jobs (id,file_id,flow_snapshot_json,status,assigned_worker_id,created_at,started_at,finished_at,error) VALUES ('failure','file',?,'failed','worker',?,'2026-08-29T11:59:50.000Z',?,'test')").run(graph, now, now);
    const stats = database.getStatistics(7, new Date(now));
    assert.equal(stats.summary.totalJobs, 2);
    assert.equal(stats.summary.successRate, 50);
    assert.equal(stats.summary.bytesSaved, 200);
    assert.equal(stats.summary.sourceBytes, 1000);
    assert.equal(stats.summary.averageDurationSeconds, 15);
    assert.deepEqual(stats.codecs, [{ codec: "hevc", count: 1 }]);
    assert.deepEqual(stats.libraries, [{ name: "Movies", files: 1, bytesSaved: 200 }]);
    assert.deepEqual(stats.flows, [{ name: "HEVC archive", jobs: 2, succeeded: 1 }]);
    assert.deepEqual(stats.workers, [{ name: "Media node", jobs: 2, succeeded: 1 }]);
    assert.deepEqual(stats.timeline.at(-1), { date: "2026-08-29", succeeded: 1, failed: 1, bytesSaved: 200 });
  } finally { database.raw.close(); await rm(directory, { recursive: true, force: true }); }
});
