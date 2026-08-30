import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { promisify } from "node:util";
import { probe, transcode, validateOutput } from "./index.js";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static") as string;
const ffprobePath = (require("ffprobe-static") as { path: string }).path;
process.env.FLOWARR_FFMPEG_PATH = ffmpegPath;
process.env.FLOWARR_FFPROBE_PATH = ffprobePath;
const run = promisify(execFile);
const ffmpegAvailable = spawnSync(ffmpegPath, ["-version"], { windowsHide: true }).status === 0
  && spawnSync(ffprobePath, ["-version"], { windowsHide: true }).status === 0;

test("generated video survives a real FFmpeg transcode", { skip: !ffmpegAvailable }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flowarr-ffmpeg-"));
  const source = path.join(directory, "generated.mp4");
  const output = path.join(directory, "transcoded.mp4");
  try {
    await run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=128x72:rate=10", "-t", "1", "-pix_fmt", "yuv420p", "-c:v", "libx264", source]);
    const sourceProbe = (await probe(source)).normalized;
    await transcode({ input: source, output, videoCodec: "libx264", quality: 30, preset: "ultrafast", audioCodec: "none", subtitles: "none", inputArgs: [], outputArgs: [] }, sourceProbe.format.duration, () => undefined);
    const outputProbe = await validateOutput(sourceProbe, output);
    assert.equal(outputProbe.video[0]?.codec, "h264");
    assert.ok((await stat(output)).size > 1024);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
