import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginRegistry, definePlugin, loadPluginDirectory } from "./index.js";

const manifest = definePlugin({
  schemaVersion: 1,
  id: "example.media",
  name: "Example media tools",
  version: "1.0.0",
  description: "Safe declarative media nodes.",
  nodes: [{ id: "cinema-crop", label: "Cinema crop", description: "Crop letterboxing.", expandsTo: "crop", defaults: { width: 1920, height: 800, x: 0, y: 140 }, fields: [{ key: "height", label: "Height", type: "number", default: 800, min: 2 }] }]
});

test("manifest helper validates safe declarative nodes", () => {
  assert.equal(manifest.id, "example.media");
  assert.throws(() => definePlugin({ ...manifest, nodes: [{ ...manifest.nodes[0]!, expandsTo: "ffmpeg-execute" }] }), /unsupported core node/);
});

test("registry loads manifests and expands plugin nodes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowarr-plugins-"));
  try {
    await mkdir(path.join(directory, "example"));
    await writeFile(path.join(directory, "example", "flowarr.plugin.json"), JSON.stringify(manifest));
    const registry = new PluginRegistry(directory);
    assert.equal(registry.snapshot().plugins.length, 1);
    const graph = registry.expandGraph({ version: 1, name: "Plugin flow", nodes: [{ id: "plugin", kind: "plugin-node", position: { x: 0, y: 0 }, config: { pluginId: "example.media", nodeType: "cinema-crop", options: { height: 900 } } }], edges: [] });
    assert.equal(graph.nodes[0]?.kind, "crop");
    assert.deepEqual(graph.nodes[0]?.config, { width: 1920, height: 900, x: 0, y: 140 });
    assert.throws(() => registry.expandGraph({ version: 1, name: "Invalid", nodes: [{ id: "plugin", kind: "plugin-node", position: { x: 0, y: 0 }, config: { pluginId: "example.media", nodeType: "cinema-crop", options: { height: -1 } } }], edges: [] }), /at least 2/);
    assert.throws(() => registry.expandGraph({ version: 1, name: "Invalid", nodes: [{ id: "plugin", kind: "plugin-node", position: { x: 0, y: 0 }, config: { pluginId: "example.media", nodeType: "cinema-crop", options: { hidden: true } } }], edges: [] }), /unknown option/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("invalid manifests are isolated as load errors", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowarr-plugins-"));
  try {
    await writeFile(path.join(directory, "broken.flowarr-plugin.json"), "{}");
    const result = loadPluginDirectory(directory);
    assert.equal(result.plugins.length, 0); assert.match(result.errors[0]?.error ?? "", /schemaVersion/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
