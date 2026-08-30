import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Database } from "./database.js";
import { deleteLibrary, updateLibrary } from "./libraries.js";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "flowarr-libraries-"));
  const db = new Database(directory);
  const now = new Date().toISOString();
  db.raw.prepare("INSERT INTO flows (id,name,graph_json,created_at,updated_at) VALUES ('flow','Flow','{}',?,?)").run(now, now);
  db.raw.prepare("INSERT INTO libraries (id,name,path,flow_id,extensions_json,created_at) VALUES ('library','Media','/media','flow','[\"mkv\"]',?)").run(now);
  return { db, directory, now };
}

test("library settings can be updated", async () => {
  const { db, directory } = await fixture();
  try {
    const updated = updateLibrary(db, "library", { name: "Archive", path: "/srv/archive", extensions: [".MKV", "mp4", "mkv"], stabilitySeconds: 90, enabled: false });
    assert.equal(updated?.name, "Archive");
    assert.equal(updated?.path, path.resolve("/srv/archive"));
    assert.deepEqual(updated?.extensions, ["mkv", "mp4"]);
    assert.equal(updated?.stabilitySeconds, 90);
    assert.equal(updated?.enabled, false);
  } finally { db.raw.close(); await rm(directory, { recursive: true, force: true }); }
});

test("library deletion removes catalog history but blocks active jobs", async () => {
  const { db, directory, now } = await fixture();
  try {
    db.raw.prepare("INSERT INTO files (id,library_id,path,name,size,status,detected_at,updated_at) VALUES ('file','library','/media/movie.mkv','movie.mkv',1,'processing',?,?)").run(now, now);
    db.raw.prepare("INSERT INTO jobs (id,file_id,flow_snapshot_json,status,created_at) VALUES ('job','file','{}','running',?)").run(now);
    assert.equal(deleteLibrary(db, "library"), "active-jobs");
    db.raw.prepare("UPDATE jobs SET status='succeeded' WHERE id='job'").run();
    assert.equal(deleteLibrary(db, "library"), "deleted");
    assert.equal(db.listLibraries().length, 0);
    assert.equal(db.listFiles().length, 0);
    assert.equal(db.listJobs().length, 0);
  } finally { db.raw.close(); await rm(directory, { recursive: true, force: true }); }
});
