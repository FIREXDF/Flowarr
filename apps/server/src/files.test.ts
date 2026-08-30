import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Database } from "./database.js";

test("failed files expose their latest failed job for log lookup", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowarr-files-"));
  const db = new Database(directory);
  try {
    const now = new Date().toISOString();
    db.raw.prepare("INSERT INTO libraries (id,name,path,extensions_json,created_at) VALUES ('library','Media','/media','[\"mkv\"]',?)").run(now);
    db.raw.prepare("INSERT INTO files (id,library_id,path,name,size,status,detected_at,updated_at) VALUES ('file','library','/media/movie.mkv','movie.mkv',1,'failed',?,?)").run(now, now);
    db.raw.prepare("INSERT INTO jobs (id,file_id,flow_snapshot_json,status,error,created_at) VALUES ('old-job','file','{}','failed','old failure','2026-08-29T10:00:00.000Z')").run();
    db.raw.prepare("INSERT INTO jobs (id,file_id,flow_snapshot_json,status,error,created_at) VALUES ('latest-job','file','{}','failed','latest failure','2026-08-30T10:00:00.000Z')").run();
    assert.equal(db.listFiles("failed")[0]?.failureJobId, "latest-job");
  } finally { db.raw.close(); await rm(directory, { recursive: true, force: true }); }
});
