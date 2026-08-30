import path from "node:path";
import type { Library } from "@flowarr/shared";
import type { Database } from "./database.js";

export interface LibraryUpdate {
  name?: string;
  path?: string;
  flowId?: string;
  extensions?: string[];
  stabilitySeconds?: number;
  enabled?: boolean;
}

export function updateLibrary(db: Database, id: string, input: LibraryUpdate): Library | null {
  const current = db.listLibraries().find((library) => library.id === id);
  if (!current) return null;
  const name = input.name === undefined ? current.name : input.name.trim();
  const libraryPath = input.path === undefined ? current.path : input.path.trim();
  const flowId = input.flowId === undefined ? current.flowId : input.flowId.trim();
  const extensions = input.extensions === undefined ? current.extensions : normalizeExtensions(input.extensions);
  const stabilitySeconds = input.stabilitySeconds === undefined ? current.stabilitySeconds : Number(input.stabilitySeconds);
  const enabled = input.enabled === undefined ? current.enabled : input.enabled;
  if (!name) throw new Error("Library name is required");
  if (!libraryPath) throw new Error("Library path is required");
  if (!flowId || !db.getFlow(flowId)) throw new Error("Selected flow does not exist");
  if (!Number.isInteger(stabilitySeconds) || stabilitySeconds < 1 || stabilitySeconds > 86_400) throw new Error("Stability delay must be between 1 and 86400 seconds");
  db.raw.prepare("UPDATE libraries SET name=?,path=?,flow_id=?,extensions_json=?,stability_seconds=?,enabled=? WHERE id=?")
    .run(name, path.resolve(libraryPath), flowId, JSON.stringify(extensions), stabilitySeconds, enabled ? 1 : 0, id);
  return db.listLibraries().find((library) => library.id === id) ?? null;
}

export function deleteLibrary(db: Database, id: string): "deleted" | "not-found" | "active-jobs" {
  if (!db.listLibraries().some((library) => library.id === id)) return "not-found";
  const active = db.raw.prepare("SELECT COUNT(*) AS count FROM jobs j JOIN files f ON f.id=j.file_id WHERE f.library_id=? AND j.status IN ('queued','running')").get(id) as { count: number };
  if (Number(active.count) > 0) return "active-jobs";
  db.transaction(() => {
    db.raw.prepare("DELETE FROM jobs WHERE file_id IN (SELECT id FROM files WHERE library_id=?)").run(id);
    db.raw.prepare("DELETE FROM files WHERE library_id=?").run(id);
    db.raw.prepare("DELETE FROM libraries WHERE id=?").run(id);
  });
  return "deleted";
}

function normalizeExtensions(values: string[]): string[] {
  const extensions = [...new Set(values.map((value) => value.trim().toLowerCase().replace(/^\./, "")).filter(Boolean))];
  if (!extensions.length) throw new Error("At least one file extension is required");
  if (extensions.some((extension) => !/^[a-z0-9]+$/.test(extension))) throw new Error("Extensions may contain only letters and numbers");
  return extensions;
}
