import assert from "node:assert/strict";
import test from "node:test";
import { buildPlan, ffmpegArgs, hevcArgs, normalizeProbe, temporaryOutput } from "./index.js";

test("normalizes probe", () => {
  const probe = normalizeProbe({ format: { duration: "10", size: "200" }, streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1080, pix_fmt: "yuv420p10le", color_transfer: "smpte2084" }] });
  assert.equal(probe.video[0]?.codec, "h264");
  assert.equal(probe.video[0]?.bitDepth, 10);
  assert.equal(probe.video[0]?.hdr, true);
  assert.equal(probe.format.duration, 10);
});
test("arguments preserve paths as isolated values", () => assert.ok(hevcArgs({ input: "a b.mkv", output: "c.mkv", crf: 24, preset: "medium" }).includes("a b.mkv")));
test("temporary output stays beside source", () => assert.match(temporaryOutput("C:\\media\\film.mkv", "123"), /processing-123\.mkv$/));
test("builds configurable command as isolated arguments", () => {
  const args = ffmpegArgs({ input: "input movie.mkv", output: "output movie.mkv", videoCodec: "libsvtav1", quality: 28, preset: "slow", pixelFormat: "yuv420p10le", scale: { width: 1920, height: 0 }, audioCodec: "libopus", audioBitrate: "160k", subtitles: "none", metadata: "copy", inputArgs: ["-hwaccel", "auto"], outputArgs: ["-metadata", "title=Flowarr output"] });
  assert.deepEqual(args.slice(2, 6), ["-hwaccel", "auto", "-i", "input movie.mkv"]);
  assert.ok(args.includes("libsvtav1"));
  assert.ok(args.includes("scale=1920:-2"));
  assert.ok(args.includes("yuv420p10le"));
  assert.ok(args.includes("-sn"));
});
test("custom command replaces placeholders and keeps progress tracking", () => {
  const args = ffmpegArgs({ input: "source file.mkv", output: "target file.mkv", videoCodec: "copy", audioCodec: "copy", subtitles: "copy", metadata: "copy", inputArgs: [], outputArgs: [], overrideArgs: ["-y", "-i", "{input}", "-c", "copy", "{output}"] });
  assert.deepEqual(args, ["-y", "-i", "source file.mkv", "-c", "copy", "-progress", "pipe:2", "-nostats", "target file.mkv"]);
});
test("custom command requires safe path placeholders", () => {
  assert.throws(() => ffmpegArgs({ input: "in", output: "out", videoCodec: "copy", audioCodec: "copy", subtitles: "copy", metadata: "copy", inputArgs: [], outputArgs: [], overrideArgs: ["-i", "other.mkv"] }), /requires \{input\} and \{output\}/);
});
test("NVENC uses GPU selection and hardware quality flags", () => {
  const args = ffmpegArgs({ input: "in.mkv", output: "out.mkv", videoCodec: "hevc_nvenc", quality: 23, preset: "p5", hardwareDevice: "1", audioCodec: "copy", subtitles: "copy", metadata: "copy", inputArgs: [], outputArgs: [] });
  assert.ok(args.includes("hevc_nvenc"));
  assert.deepEqual(args.slice(args.indexOf("-cq:v"), args.indexOf("-cq:v") + 2), ["-cq:v", "23"]);
  assert.deepEqual(args.slice(args.indexOf("-gpu"), args.indexOf("-gpu") + 2), ["-gpu", "1"]);
  assert.ok(!args.includes("-crf"));
});
test("VAAPI initializes its render device and uploads frames", () => {
  const args = ffmpegArgs({ input: "in.mkv", output: "out.mkv", videoCodec: "hevc_vaapi", quality: 25, hardwareDevice: "/dev/dri/renderD129", pixelFormat: "yuv420p10le", scale: { width: 1920, height: 0 }, audioCodec: "copy", subtitles: "copy", metadata: "copy", inputArgs: [], outputArgs: [] });
  assert.deepEqual(args.slice(args.indexOf("-vaapi_device"), args.indexOf("-vaapi_device") + 2), ["-vaapi_device", "/dev/dri/renderD129"]);
  assert.ok(args.includes("scale=1920:-2,format=p010,hwupload"));
  assert.ok(!args.includes("-pix_fmt"));
});
test("invalid NVENC adapter values are rejected", () => {
  assert.throws(() => ffmpegArgs({ input: "in", output: "out", videoCodec: "h264_nvenc", hardwareDevice: "gpu;1", audioCodec: "copy", subtitles: "copy", metadata: "copy", inputArgs: [], outputArgs: [] }), /NVENC GPU/);
});
test("rich media nodes build bounded video, audio and metadata filters", () => {
  const plan = buildPlan([
    { id: "fps", kind: "frame-rate", position: { x: 0, y: 0 }, config: { fps: 30 } },
    { id: "crop", kind: "crop", position: { x: 0, y: 0 }, config: { width: 1280, height: 720, x: 8, y: 4 } },
    { id: "rotate", kind: "rotate", position: { x: 0, y: 0 }, config: { rotation: "90cw" } },
    { id: "deinterlace", kind: "deinterlace", position: { x: 0, y: 0 } },
    { id: "normalize", kind: "audio-normalize", position: { x: 0, y: 0 }, config: { targetLufs: -16, truePeak: -1.5 } },
    { id: "metadata", kind: "metadata-mode", position: { x: 0, y: 0 }, config: { mode: "strip" } }
  ], "in.mkv", "out.mkv");
  const args = ffmpegArgs(plan);
  assert.equal(plan.videoCodec, "libx264");
  assert.equal(plan.audioCodec, "aac");
  assert.ok(args.includes("yadif,crop=1280:720:8:4,fps=30,transpose=clock"));
  assert.ok(args.includes("loudnorm=I=-16:TP=-1.5:LRA=11"));
  assert.deepEqual(args.slice(args.indexOf("-map_metadata"), args.indexOf("-map_metadata") + 4), ["-map_metadata", "-1", "-map_chapters", "-1"]);
});
