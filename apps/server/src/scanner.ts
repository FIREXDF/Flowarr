import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Database } from "./database.js";

export async function scanLibrary(db: Database, libraryId: string): Promise<{ discovered: number; skipped: number }> {
  const library = db.listLibraries().find((item) => item.id === libraryId);
  if (!library) throw new Error("Library not found");
  const root = path.resolve(library.path);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error("Library path is not a directory");
  const extensions = new Set(library.extensions.map((ext) => ext.toLowerCase().replace(/^\./, "")));
  let discovered = 0; let skipped = 0;
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) { skipped++; continue; }
      const fullPath = path.resolve(directory, entry.name);
      if (fullPath !== root && !fullPath.startsWith(root + path.sep)) throw new Error("Scanner escaped library root");
      if (entry.isDirectory()) { await walk(fullPath); continue; }
      if (!entry.isFile() || !extensions.has(path.extname(entry.name).slice(1).toLowerCase())) continue;
      const fileStat = await stat(fullPath);
      if (Date.now() - fileStat.mtimeMs < library.stabilitySeconds * 1000) { skipped++; continue; }
      const now = new Date().toISOString();
      const result = db.raw.prepare("INSERT OR IGNORE INTO files (id, library_id, path, name, size, status, detected_at, updated_at) VALUES (?, ?, ?, ?, ?, 'detected', ?, ?)").run(randomUUID(), library.id, fullPath, entry.name, fileStat.size, now, now);
      discovered += Number(result.changes);
    }
  };
  await walk(root);
  return { discovered, skipped };
}
