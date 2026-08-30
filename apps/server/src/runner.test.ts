import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import type { FlowGraph, NormalizedProbe } from "@flowarr/shared";
import { buildPlan } from "@flowarr/ffmpeg";
import { resolvePath } from "@flowarr/flow-engine";
import { WebhookNotifier } from "./events.js";

test("webhook notifier signs completed-job payloads", async () => {
  let body = "";
  let signature = "";
  const request: typeof fetch = async (_input, init) => {
    body = String(init?.body);
    signature = new Headers(init?.headers).get("x-flowarr-signature") ?? "";
    return new Response(null, { status: 204 });
  };
  const notifier = new WebhookNotifier("https://example.test/flowarr", "webhook-secret", request);
  await notifier.notify({ id: "job-1", status: "succeeded", progress: 100 });
  const payload = JSON.parse(body) as { event: string; job: { id: string } };
  assert.equal(payload.event, "job.completed");
  assert.equal(payload.job.id, "job-1");
  assert.equal(signature, `sha256=${createHmac("sha256", "webhook-secret").update(body).digest("hex")}`);
});
const media: NormalizedProbe = {
  format: { name: "matroska", duration: 60, size: 1000, bitrate: 100 },
  video: [{ index: 0, codec: "hevc", width: 3840, height: 2160, pixelFormat: "yuv420p10le", bitDepth: 10, hdr: true, bitrate: 100, frameRate: 24 }],
  audio: [], subtitles: []
};

test("bit-depth condition follows true output", () => {
  const graph: FlowGraph = { version: 1, name: "10-bit", nodes: [
    { id: "input", kind: "input", position: { x: 0, y: 0 } },
    { id: "check", kind: "bit-depth-check", position: { x: 1, y: 0 }, config: { bitDepth: 10 } },
    { id: "yes", kind: "success", position: { x: 2, y: 0 } },
    { id: "no", kind: "success", position: { x: 2, y: 1 } }
  ], edges: [
    { id: "a", source: "input", target: "check" },
    { id: "b", source: "check", target: "yes", sourceHandle: "true" },
    { id: "c", source: "check", target: "no", sourceHandle: "false" }
  ] };
  assert.deepEqual(resolvePath(graph, media).map((node) => node.id), ["input", "check", "yes"]);
});

test("flow blocks build configurable FFmpeg plan", () => {
  const plan = buildPlan([
    { id: "video", kind: "video-encode", position: { x: 0, y: 0 }, config: { codec: "libsvtav1", quality: 30, preset: "slow" } },
    { id: "pixel", kind: "pixel-format", position: { x: 0, y: 0 }, config: { pixelFormat: "yuv420p10le" } },
    { id: "audio", kind: "audio-encode", position: { x: 0, y: 0 }, config: { codec: "libopus", bitrate: "160k" } },
    { id: "args", kind: "custom-args", position: { x: 0, y: 0 }, config: { outputArgs: ["-movflags", "+faststart"] } }
  ], "input.mkv", "output.mkv");
  assert.equal(plan.videoCodec, "libsvtav1");
  assert.equal(plan.pixelFormat, "yuv420p10le");
  assert.equal(plan.audioCodec, "libopus");
  assert.deepEqual(plan.outputArgs, ["-movflags", "+faststart"]);
});
test("custom FFmpeg block overrides generated arguments", () => {
  const args = ["-i", "{input}", "-map", "0", "-c", "copy", "{output}"];
  const plan = buildPlan([{ id: "custom", kind: "custom-ffmpeg", position: { x: 0, y: 0 }, config: { args } }], "input.mkv", "output.mkv");
  assert.deepEqual(plan.overrideArgs, args);
});
test("hardware encoder and adapter survive flow planning", () => {
  const plan = buildPlan([{ id: "gpu", kind: "video-encode", position: { x: 0, y: 0 }, config: { codec: "hevc_nvenc", quality: 22, preset: "p5", device: "1" } }], "input.mkv", "output.mkv");
  assert.equal(plan.videoCodec, "hevc_nvenc");
  assert.equal(plan.hardwareDevice, "1");
  assert.equal(plan.preset, "p5");
});
