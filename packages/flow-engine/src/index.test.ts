import assert from "node:assert/strict";
import test from "node:test";
import { defaultHevcFlow, expandSubflows, failureReason, starterFlow, validateFlow } from "./index.js";

test("default flow is valid", () => assert.deepEqual(validateFlow(defaultHevcFlow()), []));
test("missing input is rejected", () => {
  const flow = defaultHevcFlow();
  flow.nodes = flow.nodes.filter((node) => node.kind !== "input");
  assert.match(validateFlow(flow).join("\n"), /exactly one input/);
});
test("failure terminal carries an operator-facing reason", () => {
  const flow = defaultHevcFlow();
  flow.nodes = [
    { id: "input", kind: "input", position: { x: 0, y: 0 } },
    { id: "failure", kind: "failure", position: { x: 200, y: 0 }, config: { message: "Unsupported source profile" } }
  ];
  flow.edges = [{ id: "fail", source: "input", target: "failure" }];
  assert.deepEqual(validateFlow(flow), []);
  assert.equal(failureReason(flow.nodes), "Unsupported source profile");
});

test("terminal nodes cannot continue execution", () => {
  const flow = defaultHevcFlow();
  flow.nodes.push({ id: "after", kind: "success", position: { x: 1500, y: 40 } });
  flow.edges.push({ id: "invalid-terminal-edge", source: "replace", target: "after" });
  assert.match(validateFlow(flow).join("\n"), /Terminal node replace cannot have outgoing edges/);
});
test("failure terminals require a bounded message", () => {
  const flow = defaultHevcFlow();
  flow.nodes = [
    { id: "input", kind: "input", position: { x: 0, y: 0 } },
    { id: "failure", kind: "failure", position: { x: 200, y: 0 }, config: { message: " " } }
  ];
  flow.edges = [{ id: "fail", source: "input", target: "failure" }];
  assert.match(validateFlow(flow).join("\n"), /needs a message/);
  flow.nodes[1]!.config = { message: "x".repeat(501) };
  assert.match(validateFlow(flow).join("\n"), /exceeds 500 characters/);
});

test("starter templates provide valid ready-to-run flows and an empty draft", () => {
  for (const template of ["hevc", "gpu", "audio"] as const) {
    assert.deepEqual(validateFlow(starterFlow(template)), [], template);
  }
  const blank = starterFlow("blank");
  assert.equal(blank.name, "Untitled flow");
  assert.deepEqual(blank.nodes, []);
  assert.deepEqual(blank.edges, []);
});

test("subflows inline reusable routes and return through success", () => {
  const child = { version: 1 as const, name: "Normalize", nodes: [
    { id: "input", kind: "input" as const, position: { x: 0, y: 0 } },
    { id: "audio", kind: "audio-normalize" as const, position: { x: 200, y: 0 } },
    { id: "done", kind: "success" as const, position: { x: 400, y: 0 } }
  ], edges: [{ id: "a", source: "input", target: "audio" }, { id: "b", source: "audio", target: "done" }] };
  const parent = { version: 1 as const, name: "Parent", nodes: [
    { id: "input", kind: "input" as const, position: { x: 0, y: 0 } },
    { id: "call", kind: "subflow" as const, position: { x: 200, y: 0 }, config: { flowId: "child" } },
    { id: "done", kind: "success" as const, position: { x: 400, y: 0 } }
  ], edges: [{ id: "in", source: "input", target: "call" }, { id: "out", source: "call", target: "done" }] };
  const expanded = expandSubflows("parent", parent, (id) => id === "child" ? child : null);
  assert.deepEqual(expanded.nodes.map((node) => node.id), ["input", "done", "call::audio"]);
  assert.deepEqual(expanded.edges.map((edge) => [edge.source, edge.target]), [["input", "call::audio"], ["call::audio", "done"]]);
  assert.deepEqual(validateFlow(expanded), []);
});

test("subflow cycles and missing return nodes are rejected", () => {
  const parent = { version: 1 as const, name: "Parent", nodes: [
    { id: "input", kind: "input" as const, position: { x: 0, y: 0 } },
    { id: "call", kind: "subflow" as const, position: { x: 200, y: 0 }, config: { flowId: "parent" } },
    { id: "done", kind: "success" as const, position: { x: 400, y: 0 } }
  ], edges: [{ id: "in", source: "input", target: "call" }, { id: "out", source: "call", target: "done" }] };
  assert.throws(() => expandSubflows("parent", parent, () => parent), /Circular subflow reference/);
  const noReturn = defaultHevcFlow(); noReturn.nodes = noReturn.nodes.filter((node) => node.kind !== "success"); noReturn.edges = noReturn.edges.filter((edge) => edge.target !== "success");
  parent.nodes[1]!.config = { flowId: "child" };
  assert.throws(() => expandSubflows("parent", parent, () => noReturn), /needs a success node/);
});
