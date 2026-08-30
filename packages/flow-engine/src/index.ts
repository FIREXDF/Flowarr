import type { FlowEdge, FlowGraph, FlowNode, NormalizedProbe } from "@flowarr/shared";

const terminalKinds = new Set(["success", "replace", "failure"]);

export function validateFlow(graph: FlowGraph): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) errors.push(`Duplicate node id: ${node.id}`);
    ids.add(node.id);
    if (node.kind === "failure" && !String(node.config?.message ?? "").trim()) errors.push(`Failure node ${node.id} needs a message`);
    if (node.kind === "failure" && String(node.config?.message ?? "").length > 500) errors.push(`Failure node ${node.id} message exceeds 500 characters`);
    if (node.kind === "subflow" && !String(node.config?.flowId ?? "").trim()) errors.push(`Subflow node ${node.id} needs a referenced flow`);
    if (node.kind === "plugin-node" && (!String(node.config?.pluginId ?? "").trim() || !String(node.config?.nodeType ?? "").trim())) errors.push(`Plugin node ${node.id} needs a plugin and node type`);
  }
  const inputs = graph.nodes.filter((node) => node.kind === "input");
  if (inputs.length !== 1) errors.push("Flow must contain exactly one input node");
  for (const edge of graph.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) errors.push(`Edge ${edge.id} references a missing node`);
    if (edge.source === edge.target) errors.push(`Node ${edge.source} cannot connect to itself`);
    if (graph.nodes.some((node) => node.id === edge.source && terminalKinds.has(node.kind))) errors.push(`Terminal node ${edge.source} cannot have outgoing edges`);
  }
  if (inputs[0]) {
    const reachable = new Set<string>();
    const visit = (id: string) => {
      if (reachable.has(id)) return;
      reachable.add(id);
      graph.edges.filter((edge) => edge.source === id).forEach((edge) => visit(edge.target));
    };
    visit(inputs[0].id);
    for (const node of graph.nodes) if (!reachable.has(node.id)) errors.push(`Node ${node.id} is unreachable`);
  }
  const hasTerminal = graph.nodes.some((node) => terminalKinds.has(node.kind));
  if (!hasTerminal) errors.push("Flow needs a terminal replace, success, or failure node");
  return errors;
}

export function nextNode(graph: FlowGraph, current: FlowNode, branch = "default"): FlowNode | null {
  const candidates = graph.edges.filter((edge) => edge.source === current.id);
  const edge = candidates.find((item) => (item.sourceHandle ?? "default") === branch)
    ?? candidates.find((item) => (item.sourceHandle ?? "default") === "default");
  return edge ? graph.nodes.find((node) => node.id === edge.target) ?? null : null;
}

const conditionKinds = new Set(["codec-check", "bit-depth-check", "hdr-check", "resolution-check"]);

export function resolvePath(graph: FlowGraph, media: NormalizedProbe): FlowNode[] {
  let current = graph.nodes.find((node) => node.kind === "input");
  if (!current) throw new Error("Flow has no input node");
  const path: FlowNode[] = [];
  const visits = new Map<string, number>();
  while (current) {
    path.push(current);
    const count = (visits.get(current.id) ?? 0) + 1;
    visits.set(current.id, count);
    if (count > 4 || path.length > 100) throw new Error("Flow loop exceeded safe execution limit");
    const branch: string = conditionKinds.has(current.kind) ? String(evaluateCondition(current, media)) : "default";
    const candidates: FlowEdge[] = graph.edges.filter((edge: FlowEdge) => edge.source === current?.id);
    const edge: FlowEdge | undefined = candidates.find((item: FlowEdge) => (item.sourceHandle ?? "default") === branch)
      ?? candidates.find((item) => (item.sourceHandle ?? "default") === "default");
    current = edge ? graph.nodes.find((node) => node.id === edge.target) : undefined;
  }
  return path;
}

export function failureReason(path: FlowNode[]): string | null {
  const terminal = path.at(-1);
  if (terminal?.kind !== "failure") return null;
  const message = String(terminal.config?.message ?? "").trim();
  return message || "Flow routed media to failure";
}

export type FlowGraphLoader = (flowId: string) => FlowGraph | null;

export function expandSubflows(rootFlowId: string, graph: FlowGraph, loadGraph: FlowGraphLoader): FlowGraph {
  const expand = (flowId: string, current: FlowGraph, stack: string[]): FlowGraph => {
    let expanded = current;
    while (true) {
      const call = expanded.nodes.find((node) => node.kind === "subflow");
      if (!call) return expanded;
      const targetId = String(call.config?.flowId ?? "").trim();
      if (!targetId) throw new Error(`Subflow node ${call.id} has no referenced flow`);
      if (stack.includes(targetId)) throw new Error(`Circular subflow reference: ${[...stack, targetId].join(" -> ")}`);
      const target = loadGraph(targetId);
      if (!target) throw new Error(`Subflow node ${call.id} references missing flow ${targetId}`);
      const problems = validateFlow(target);
      if (problems.length) throw new Error(`Referenced flow ${target.name} is invalid: ${problems[0]}`);
      if (!target.nodes.some((node) => node.kind === "success")) throw new Error(`Referenced flow ${target.name} needs a success node to return to its parent`);
      expanded = inlineSubflow(expanded, call, expand(targetId, target, [...stack, targetId]));
    }
  };
  return expand(rootFlowId, graph, [rootFlowId]);
}

function inlineSubflow(parent: FlowGraph, call: FlowNode, child: FlowGraph): FlowGraph {
  const input = child.nodes.find((node) => node.kind === "input");
  if (!input) throw new Error(`Referenced flow ${child.name} has no input node`);
  const returns = new Set(child.nodes.filter((node) => node.kind === "success").map((node) => node.id));
  const prefix = (id: string) => `${call.id}::${id}`;
  const incoming = parent.edges.filter((edge) => edge.target === call.id);
  const outgoing = parent.edges.filter((edge) => edge.source === call.id);
  const untouched = parent.edges.filter((edge) => edge.target !== call.id && edge.source !== call.id);
  const entries = child.edges.filter((edge) => edge.source === input.id);
  const exits = child.edges.filter((edge) => returns.has(edge.target));
  const inner = child.edges.filter((edge) => edge.source !== input.id && !returns.has(edge.target))
    .map((edge) => ({ ...edge, id: prefix(edge.id), source: prefix(edge.source), target: prefix(edge.target) }));
  const entryEdges: FlowEdge[] = [];
  for (const parentEdge of incoming) {
    for (const childEdge of entries) {
      if (returns.has(childEdge.target)) {
        for (const next of outgoing) entryEdges.push({ id: `${parentEdge.id}::${childEdge.id}::${next.id}`, source: parentEdge.source, target: next.target, sourceHandle: parentEdge.sourceHandle });
      } else {
        entryEdges.push({ id: `${parentEdge.id}::${childEdge.id}`, source: parentEdge.source, target: prefix(childEdge.target), sourceHandle: parentEdge.sourceHandle });
      }
    }
  }
  const exitEdges: FlowEdge[] = [];
  for (const childEdge of exits) {
    if (childEdge.source === input.id) continue;
    for (const next of outgoing) exitEdges.push({ id: `${childEdge.id}::${next.id}`, source: prefix(childEdge.source), target: next.target, sourceHandle: childEdge.sourceHandle });
  }
  const childNodes = child.nodes.filter((node) => node.id !== input.id && !returns.has(node.id)).map((node) => ({
    ...node,
    id: prefix(node.id),
    position: { x: call.position.x + node.position.x - input.position.x, y: call.position.y + node.position.y - input.position.y }
  }));
  return { ...parent, nodes: [...parent.nodes.filter((node) => node.id !== call.id), ...childNodes], edges: [...untouched, ...inner, ...entryEdges, ...exitEdges] };
}
function evaluateCondition(node: FlowNode, media: NormalizedProbe): boolean {
  const video = media.video[0];
  if (!video) return false;
  if (node.kind === "codec-check") return video.codec === String(node.config?.codec ?? "h264");
  if (node.kind === "bit-depth-check") return video.bitDepth === Number(node.config?.bitDepth ?? 10);
  if (node.kind === "hdr-check") return video.hdr === Boolean(node.config?.hdr ?? true);
  if (node.kind === "resolution-check") return video.width >= Number(node.config?.minWidth ?? 3840) && video.height >= Number(node.config?.minHeight ?? 2160);
  return true;
}

export function defaultHevcFlow(): FlowGraph {
  return {
    version: 1,
    name: "Convert H.264 to HEVC",
    nodes: [
      { id: "input", kind: "input", position: { x: 0, y: 120 } },
      { id: "check", kind: "codec-check", position: { x: 220, y: 120 }, config: { codec: "h264" } },
      { id: "start", kind: "ffmpeg-start", position: { x: 440, y: 40 } },
      { id: "encode", kind: "hevc-encode", position: { x: 660, y: 40 }, config: { crf: 24, preset: "medium" } },
      { id: "execute", kind: "ffmpeg-execute", position: { x: 880, y: 40 } },
      { id: "validate", kind: "validate", position: { x: 1100, y: 40 } },
      { id: "replace", kind: "replace", position: { x: 1320, y: 40 } },
      { id: "success", kind: "success", position: { x: 440, y: 220 } }
    ],
    edges: [
      { id: "e1", source: "input", target: "check" },
      { id: "e2", source: "check", target: "start", sourceHandle: "true" },
      { id: "e3", source: "check", target: "success", sourceHandle: "false" },
      { id: "e4", source: "start", target: "encode" },
      { id: "e5", source: "encode", target: "execute" },
      { id: "e6", source: "execute", target: "validate" },
      { id: "e7", source: "validate", target: "replace" }
    ]
  };
}

export type StarterFlowKind = "blank" | "hevc" | "gpu" | "audio";

export function starterFlow(kind: StarterFlowKind): FlowGraph {
  if (kind === "blank") return { version: 1, name: "Untitled flow", nodes: [], edges: [] };
  if (kind === "hevc") return defaultHevcFlow();
  if (kind === "gpu") {
    return {
      version: 1,
      name: "GPU HEVC encode",
      nodes: [
        { id: "input", kind: "input", position: { x: 0, y: 100 } },
        { id: "probe", kind: "probe-media", position: { x: 220, y: 100 } },
        { id: "start", kind: "ffmpeg-start", position: { x: 440, y: 100 } },
        { id: "video", kind: "video-encode", position: { x: 660, y: 40 }, config: { codec: "hevc_nvenc", quality: 24, preset: "p5", device: "0" } },
        { id: "audio", kind: "audio-encode", position: { x: 660, y: 160 }, config: { codec: "copy", bitrate: "192k" } },
        { id: "execute", kind: "ffmpeg-execute", position: { x: 880, y: 100 } },
        { id: "validate", kind: "validate", position: { x: 1100, y: 100 } },
        { id: "replace", kind: "replace", position: { x: 1320, y: 100 } }
      ],
      edges: [
        { id: "e1", source: "input", target: "probe" },
        { id: "e2", source: "probe", target: "start" },
        { id: "e3", source: "start", target: "video" },
        { id: "e4", source: "video", target: "audio" },
        { id: "e5", source: "audio", target: "execute" },
        { id: "e6", source: "execute", target: "validate" },
        { id: "e7", source: "validate", target: "replace" }
      ]
    };
  }
  return {
    version: 1,
    name: "AAC audio encode",
    nodes: [
      { id: "input", kind: "input", position: { x: 0, y: 100 } },
      { id: "start", kind: "ffmpeg-start", position: { x: 220, y: 100 } },
      { id: "audio", kind: "audio-encode", position: { x: 440, y: 100 }, config: { codec: "aac", bitrate: "192k" } },
      { id: "execute", kind: "ffmpeg-execute", position: { x: 660, y: 100 } },
      { id: "validate", kind: "validate", position: { x: 880, y: 100 } },
      { id: "replace", kind: "replace", position: { x: 1100, y: 100 } }
    ],
    edges: [
      { id: "e1", source: "input", target: "start" },
      { id: "e2", source: "start", target: "audio" },
      { id: "e3", source: "audio", target: "execute" },
      { id: "e4", source: "execute", target: "validate" },
      { id: "e5", source: "validate", target: "replace" }
    ]
  };
}
