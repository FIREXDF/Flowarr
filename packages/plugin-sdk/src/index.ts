import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { FlowGraph, FlowNodeKind } from "@flowarr/shared";

export const FLOWARR_PLUGIN_SCHEMA_VERSION = 1;
const idPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const allowedTargets = new Set<FlowNodeKind>([
  "probe-media", "video-encode", "hevc-encode", "scale", "pixel-format", "frame-rate", "crop", "rotate", "deinterlace",
  "audio-encode", "audio-normalize", "subtitle-mode", "metadata-mode", "custom-args", "validate", "minimum-saving"
]);

export type PluginField =
  | { key: string; label: string; type: "string"; default?: string; placeholder?: string }
  | { key: string; label: string; type: "number"; default?: number; min?: number; max?: number; step?: number }
  | { key: string; label: string; type: "boolean"; default?: boolean }
  | { key: string; label: string; type: "select"; default?: string; options: Array<{ value: string; label: string }> };

export interface PluginNodeDefinition {
  id: string;
  label: string;
  description: string;
  category?: string;
  expandsTo: FlowNodeKind;
  defaults?: Record<string, unknown>;
  fields?: PluginField[];
}

export interface FlowarrPluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  nodes: PluginNodeDefinition[];
}

export interface PluginLoadError { file: string; error: string }
export interface PluginCatalog { plugins: FlowarrPluginManifest[]; errors: PluginLoadError[] }

export function definePlugin<const T extends FlowarrPluginManifest>(manifest: T): T {
  validatePluginManifest(manifest);
  return manifest;
}

export function validatePluginManifest(value: unknown): asserts value is FlowarrPluginManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Plugin manifest must be an object");
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== FLOWARR_PLUGIN_SCHEMA_VERSION) throw new Error("Unsupported plugin schemaVersion");
  requireText(manifest.id, "Plugin id", 80); if (!idPattern.test(String(manifest.id))) throw new Error("Plugin id must use lowercase letters, numbers, dots, or hyphens");
  requireText(manifest.name, "Plugin name", 100); requireText(manifest.version, "Plugin version", 40); requireText(manifest.description, "Plugin description", 500);
  if (!Array.isArray(manifest.nodes) || manifest.nodes.length === 0 || manifest.nodes.length > 100) throw new Error("Plugin must define 1 to 100 nodes");
  const nodeIds = new Set<string>();
  for (const raw of manifest.nodes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Plugin node must be an object");
    const node = raw as Record<string, unknown>; requireText(node.id, "Plugin node id", 80); requireText(node.label, "Plugin node label", 100); requireText(node.description, "Plugin node description", 500);
    if (!idPattern.test(String(node.id))) throw new Error(`Plugin node id ${node.id} is invalid`);
    if (nodeIds.has(String(node.id))) throw new Error(`Duplicate plugin node id: ${node.id}`); nodeIds.add(String(node.id));
    if (!allowedTargets.has(node.expandsTo as FlowNodeKind)) throw new Error(`Plugin node ${node.id} expands to unsupported core node ${String(node.expandsTo)}`);
    if (node.defaults !== undefined && (!node.defaults || typeof node.defaults !== "object" || Array.isArray(node.defaults))) throw new Error(`Plugin node ${node.id} defaults must be an object`);
    if (JSON.stringify(node.defaults ?? {}).length > 32_000) throw new Error(`Plugin node ${node.id} defaults are too large`);
    validateFields(node.id as string, node.fields);
  }
}

export function loadPluginDirectory(directory: string): PluginCatalog {
  const plugins: FlowarrPluginManifest[] = []; const errors: PluginLoadError[] = [];
  if (!existsSync(directory)) return { plugins, errors };
  const files = readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isFile() && entry.name.endsWith(".flowarr-plugin.json")) return [path.join(directory, entry.name)];
    if (entry.isDirectory()) {
      const manifest = path.join(directory, entry.name, "flowarr.plugin.json");
      return existsSync(manifest) ? [manifest] : [];
    }
    return [];
  });
  const ids = new Set<string>();
  for (const file of files.sort()) {
    try {
      if (statSync(file).size > 256_000) throw new Error("Plugin manifest exceeds 256 KB");
      const manifest: unknown = JSON.parse(readFileSync(file, "utf8")); validatePluginManifest(manifest);
      if (ids.has(manifest.id)) throw new Error(`Duplicate plugin id: ${manifest.id}`);
      ids.add(manifest.id); plugins.push(manifest);
    } catch (error) { errors.push({ file, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { plugins, errors };
}

export class PluginRegistry {
  private catalog: PluginCatalog = { plugins: [], errors: [] };
  constructor(readonly directory: string) { this.reload(); }
  reload(): PluginCatalog { this.catalog = loadPluginDirectory(this.directory); return this.snapshot(); }
  snapshot(): PluginCatalog { return { plugins: structuredClone(this.catalog.plugins), errors: structuredClone(this.catalog.errors) }; }
  expandGraph(graph: FlowGraph): FlowGraph {
    const plugins = new Map(this.catalog.plugins.map((plugin) => [plugin.id, plugin]));
    return { ...graph, nodes: graph.nodes.map((node) => {
      if (node.kind !== "plugin-node") return node;
      const pluginId = String(node.config?.pluginId ?? ""); const nodeType = String(node.config?.nodeType ?? "");
      const plugin = plugins.get(pluginId); if (!plugin) throw new Error(`Plugin node ${node.id} references unavailable plugin ${pluginId || "(empty)"}`);
      const definition = plugin.nodes.find((item) => item.id === nodeType); if (!definition) throw new Error(`Plugin ${plugin.name} has no node ${nodeType || "(empty)"}`);
      const options = node.config?.options;
      if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options))) throw new Error(`Plugin node ${node.id} options must be an object`);
      return { ...node, kind: definition.expandsTo, config: { ...(definition.defaults ?? {}), ...validateOptions(node.id, definition, (options as Record<string, unknown> | undefined) ?? {}) } };
    }) };
  }
}

function requireText(value: unknown, label: string, maximum: number): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
}

function validateFields(nodeId: string, value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 40) throw new Error(`Plugin node ${nodeId} fields must be an array of at most 40 items`);
  const keys = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Plugin node ${nodeId} field must be an object`);
    const field = raw as Record<string, unknown>; requireText(field.key, "Plugin field key", 80); requireText(field.label, "Plugin field label", 100);
    if (!idPattern.test(String(field.key))) throw new Error(`Plugin field key ${field.key} is invalid`);
    if (keys.has(String(field.key))) throw new Error(`Duplicate plugin field key: ${field.key}`); keys.add(String(field.key));
    if (!["string", "number", "boolean", "select"].includes(String(field.type))) throw new Error(`Plugin field ${field.key} has unsupported type`);
    if (field.type === "select" && (!Array.isArray(field.options) || field.options.length === 0 || field.options.length > 100)) throw new Error(`Select field ${field.key} needs 1 to 100 options`);
  }
}

function validateOptions(nodeId: string, definition: PluginNodeDefinition, options: Record<string, unknown>): Record<string, unknown> {
  const fields = new Map((definition.fields ?? []).map((field) => [field.key, field]));
  const validated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    const field = fields.get(key); if (!field) throw new Error(`Plugin node ${nodeId} has unknown option ${key}`);
    if (field.type === "string") {
      if (typeof value !== "string" || value.length > 2_000) throw new Error(`Plugin option ${key} must be a string of at most 2000 characters`);
    } else if (field.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Plugin option ${key} must be a finite number`);
      if (field.min !== undefined && value < field.min) throw new Error(`Plugin option ${key} must be at least ${field.min}`);
      if (field.max !== undefined && value > field.max) throw new Error(`Plugin option ${key} must be at most ${field.max}`);
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") throw new Error(`Plugin option ${key} must be boolean`);
    } else if (typeof value !== "string" || !field.options.some((option) => option.value === value)) {
      throw new Error(`Plugin option ${key} must use an allowed value`);
    }
    validated[key] = value;
  }
  return validated;
}
