import { spawn } from "node:child_process";
import { rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { FlowNode, NormalizedProbe } from "@flowarr/shared";

type RawStream = Record<string, unknown> & { codec_type?: string; index?: number; tags?: Record<string, string>; disposition?: Record<string, number> };
type RawProbe = { format?: Record<string, unknown>; streams?: RawStream[] };

function number(value: unknown): number { const result = Number(value ?? 0); return Number.isFinite(result) ? result : 0; }
function frameRate(value: unknown): number { if (typeof value !== "string") return 0; const [a, b = "1"] = value.split("/"); return number(a) / Math.max(1, number(b)); }
function bitDepth(stream: RawStream): number {
  const explicit = number(stream.bits_per_raw_sample || stream.bits_per_sample);
  if (explicit) return explicit;
  const match = String(stream.pix_fmt ?? "").match(/(?:p|le|be)(10|12|16)(?:le|be)?$/);
  return match?.[1] ? Number(match[1]) : 8;
}
function isHdr(stream: RawStream): boolean {
  return ["smpte2084", "arib-std-b67"].includes(String(stream.color_transfer ?? "").toLowerCase());
}

export function normalizeProbe(raw: RawProbe): NormalizedProbe {
  const streams = raw.streams ?? [];
  const format = raw.format ?? {};
  return {
    format: { name: String(format.format_name ?? ""), duration: number(format.duration), size: number(format.size), bitrate: number(format.bit_rate) },
    video: streams.filter((s) => s.codec_type === "video").map((s) => ({ index: number(s.index), codec: String(s.codec_name ?? ""), width: number(s.width), height: number(s.height), pixelFormat: String(s.pix_fmt ?? ""), bitDepth: bitDepth(s), hdr: isHdr(s), bitrate: number(s.bit_rate), frameRate: frameRate(s.avg_frame_rate) })),
    audio: streams.filter((s) => s.codec_type === "audio").map((s) => ({ index: number(s.index), codec: String(s.codec_name ?? ""), channels: number(s.channels), language: s.tags?.language ?? null })),
    subtitles: streams.filter((s) => s.codec_type === "subtitle").map((s) => ({ index: number(s.index), codec: String(s.codec_name ?? ""), language: s.tags?.language ?? null, forced: s.disposition?.forced === 1 }))
  };
}

function run(command: string, args: string[], onLine?: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { const text = String(chunk); stderr += text; text.split(/\r?\n/).forEach((line) => line && onLine?.(line)); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`)));
  });
}

export async function probe(filePath: string): Promise<{ raw: RawProbe; normalized: NormalizedProbe }> {
  const output = await run(process.env.FLOWARR_FFPROBE_PATH ?? "ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", filePath]);
  const raw = JSON.parse(output) as RawProbe;
  return { raw, normalized: normalizeProbe(raw) };
}

export type VideoEncoder = "copy" | "libx264" | "libx265" | "libsvtav1" | "libvpx-vp9"
  | "h264_nvenc" | "hevc_nvenc" | "av1_nvenc"
  | "h264_vaapi" | "hevc_vaapi" | "av1_vaapi"
  | "h264_qsv" | "hevc_qsv" | "av1_qsv"
  | "h264_amf" | "hevc_amf" | "av1_amf"
  | "h264_videotoolbox" | "hevc_videotoolbox";

export interface FfmpegPlan {
  input: string;
  output: string;
  videoCodec: VideoEncoder;
  quality?: number;
  preset?: string;
  hardwareDevice?: string;
  pixelFormat?: string;
  scale?: { width: number; height: number };
  frameRate?: number;
  crop?: { width: number; height: number; x: number; y: number };
  rotation?: "90cw" | "90ccw" | "180" | "hflip" | "vflip";
  deinterlace?: boolean;
  audioCodec: "copy" | "aac" | "libopus" | "ac3" | "eac3" | "flac" | "none";
  audioBitrate?: string;
  audioNormalize?: { targetLufs: number; truePeak: number };
  subtitles: "copy" | "none";
  metadata?: "copy" | "strip";
  inputArgs: string[];
  outputArgs: string[];
  overrideArgs?: string[];
}

function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }

export function buildPlan(nodes: FlowNode[], input: string, output: string): FfmpegPlan {
  const plan: FfmpegPlan = { input, output, videoCodec: "copy", audioCodec: "copy", subtitles: "copy", metadata: "copy", inputArgs: [], outputArgs: [] };
  const videoCodecs = new Set<VideoEncoder>(["copy", "libx264", "libx265", "libsvtav1", "libvpx-vp9", "h264_nvenc", "hevc_nvenc", "av1_nvenc", "h264_vaapi", "hevc_vaapi", "av1_vaapi", "h264_qsv", "hevc_qsv", "av1_qsv", "h264_amf", "hevc_amf", "av1_amf", "h264_videotoolbox", "hevc_videotoolbox"]);
  const audioCodecs = new Set<FfmpegPlan["audioCodec"]>(["copy", "aac", "libopus", "ac3", "eac3", "flac", "none"]);
  for (const node of nodes) {
    if (node.kind === "hevc-encode") { plan.videoCodec = "libx265"; plan.quality = Number(node.config?.crf ?? 24); plan.preset = String(node.config?.preset ?? "medium"); }
    if (node.kind === "video-encode") { const codec = String(node.config?.codec ?? "libx265") as VideoEncoder; if (!videoCodecs.has(codec)) throw new Error(`Unsupported video codec: ${codec}`); plan.videoCodec = codec; plan.quality = Number(node.config?.quality ?? 24); plan.preset = String(node.config?.preset ?? ""); plan.hardwareDevice = String(node.config?.device ?? "").trim() || undefined; }
    if (node.kind === "scale") plan.scale = { width: Number(node.config?.width ?? 1920), height: Number(node.config?.height ?? 0) };
    if (node.kind === "pixel-format") plan.pixelFormat = String(node.config?.pixelFormat ?? "yuv420p10le");
    if (node.kind === "frame-rate") plan.frameRate = Number(node.config?.fps ?? 30);
    if (node.kind === "crop") plan.crop = { width: Number(node.config?.width ?? 1920), height: Number(node.config?.height ?? 1080), x: Number(node.config?.x ?? 0), y: Number(node.config?.y ?? 0) };
    if (node.kind === "rotate") { const rotation = String(node.config?.rotation ?? "90cw"); if (!["90cw", "90ccw", "180", "hflip", "vflip"].includes(rotation)) throw new Error(`Unsupported rotation: ${rotation}`); plan.rotation = rotation as FfmpegPlan["rotation"]; }
    if (node.kind === "deinterlace") plan.deinterlace = true;
    if (node.kind === "audio-encode") { const codec = String(node.config?.codec ?? "copy") as FfmpegPlan["audioCodec"]; if (!audioCodecs.has(codec)) throw new Error(`Unsupported audio codec: ${codec}`); plan.audioCodec = codec; plan.audioBitrate = String(node.config?.bitrate ?? "192k"); }
    if (node.kind === "audio-normalize") plan.audioNormalize = { targetLufs: Number(node.config?.targetLufs ?? -16), truePeak: Number(node.config?.truePeak ?? -1.5) };
    if (node.kind === "subtitle-mode") plan.subtitles = node.config?.mode === "none" ? "none" : "copy";
    if (node.kind === "metadata-mode") plan.metadata = node.config?.mode === "strip" ? "strip" : "copy";
    if (node.kind === "custom-args") { plan.inputArgs.push(...stringArray(node.config?.inputArgs)); plan.outputArgs.push(...stringArray(node.config?.outputArgs)); }
    if (node.kind === "custom-ffmpeg") plan.overrideArgs = stringArray(node.config?.args);
  }
  if ((plan.scale || plan.pixelFormat || plan.frameRate || plan.crop || plan.rotation || plan.deinterlace) && plan.videoCodec === "copy") { plan.videoCodec = "libx264"; plan.quality = 24; plan.preset = "medium"; }
  if (plan.audioNormalize && plan.audioCodec === "copy") { plan.audioCodec = "aac"; plan.audioBitrate = "192k"; }
  return plan;
}

function validateCustomArgs(args: string[]): string[] {
  if (args.length > 128) throw new Error("Custom FFmpeg arguments exceed 128 entries");
  return args.map((arg) => {
    if (!arg || arg.length > 1024 || arg.includes("\0") || arg.includes("\r") || arg.includes("\n")) throw new Error("Invalid custom FFmpeg argument");
    return arg;
  });
}

export function ffmpegArgs(plan: FfmpegPlan): string[] {
  if (plan.overrideArgs) {
    const template = validateCustomArgs(plan.overrideArgs);
    if (template[0]?.toLowerCase() === "ffmpeg") throw new Error("Custom FFmpeg command must contain arguments only, without the ffmpeg executable");
    if (!template.includes("{input}") || !template.includes("{output}")) throw new Error("Custom FFmpeg command requires {input} and {output} placeholders");
    return template.flatMap((arg) => arg === "{input}" ? [plan.input] : arg === "{output}" ? ["-progress", "pipe:2", "-nostats", plan.output] : [arg]);
  }
  const device = validateHardwareDevice(plan.videoCodec, plan.hardwareDevice);
  const hardwareInputArgs: string[] = [];
  if (plan.videoCodec.endsWith("_vaapi") && device) hardwareInputArgs.push("-vaapi_device", device);
  if (plan.videoCodec.endsWith("_qsv") && device) hardwareInputArgs.push("-qsv_device", device);
  const args = ["-hide_banner", "-y", ...hardwareInputArgs, ...validateCustomArgs(plan.inputArgs), "-i", plan.input, "-map", "0"];
  args.push("-c:v", plan.videoCodec);
  if (plan.videoCodec !== "copy") {
    const quality = String(Math.max(0, Math.min(63, Number(plan.quality ?? 24))));
    if (plan.videoCodec.endsWith("_nvenc")) args.push("-cq:v", quality);
    else if (plan.videoCodec.endsWith("_vaapi")) args.push("-qp", quality);
    else if (plan.videoCodec.endsWith("_qsv")) args.push("-global_quality", quality);
    else if (plan.videoCodec.endsWith("_amf")) args.push("-qp_i", quality, "-qp_p", quality);
    else if (plan.videoCodec.endsWith("_videotoolbox")) args.push("-q:v", quality);
    else args.push("-crf", quality);
    if (plan.preset) args.push("-preset", plan.preset);
    if (plan.videoCodec.endsWith("_nvenc") && device) args.push("-gpu", device);
    const filters: string[] = [];
    if (plan.deinterlace) filters.push("yadif");
    if (plan.crop) filters.push(`crop=${boundedInteger(plan.crop.width, 2, 16384)}:${boundedInteger(plan.crop.height, 2, 16384)}:${boundedInteger(plan.crop.x, 0, 16384)}:${boundedInteger(plan.crop.y, 0, 16384)}`);
    if (plan.scale) filters.push(`scale=${plan.scale.width || -2}:${plan.scale.height || -2}`);
    if (plan.frameRate) filters.push(`fps=${boundedNumber(plan.frameRate, 1, 240)}`);
    if (plan.rotation === "90cw") filters.push("transpose=clock");
    if (plan.rotation === "90ccw") filters.push("transpose=cclock");
    if (plan.rotation === "180") filters.push("hflip", "vflip");
    if (plan.rotation === "hflip" || plan.rotation === "vflip") filters.push(plan.rotation);
    if (plan.videoCodec.endsWith("_vaapi")) filters.push(`format=${plan.pixelFormat?.includes("10") ? "p010" : "nv12"}`, "hwupload");
    else if (plan.pixelFormat) args.push("-pix_fmt", plan.pixelFormat);
    if (filters.length) args.push("-vf", filters.join(","));
  }
  if (plan.audioCodec === "none") args.push("-an");
  else {
    args.push("-c:a", plan.audioCodec);
    if (plan.audioCodec !== "copy" && plan.audioBitrate) args.push("-b:a", plan.audioBitrate);
    if (plan.audioNormalize) args.push("-af", `loudnorm=I=${boundedNumber(plan.audioNormalize.targetLufs, -70, -5)}:TP=${boundedNumber(plan.audioNormalize.truePeak, -9, 0)}:LRA=11`);
  }
  if (plan.subtitles === "none") args.push("-sn"); else args.push("-c:s", "copy");
  if (plan.metadata === "strip") args.push("-map_metadata", "-1", "-map_chapters", "-1");
  args.push(...validateCustomArgs(plan.outputArgs), "-progress", "pipe:2", "-nostats", plan.output);
  return args;
}

function boundedNumber(value: number, minimum: number, maximum: number): string {
  if (!Number.isFinite(value)) throw new Error("Media filter value must be a finite number");
  return String(Math.max(minimum, Math.min(maximum, value)));
}

function boundedInteger(value: number, minimum: number, maximum: number): string {
  return String(Math.round(Number(boundedNumber(value, minimum, maximum))));
}

function validateHardwareDevice(codec: VideoEncoder, device?: string): string | undefined {
  if (!device) return undefined;
  if (device.length > 260 || device.includes("\0") || device.includes("\r") || device.includes("\n")) throw new Error("Invalid hardware device");
  if (codec.endsWith("_nvenc") && !/^(?:\d+|any)$/.test(device)) throw new Error("NVENC GPU must be a numeric index or any");
  return device;
}

export async function transcode(plan: FfmpegPlan, duration: number, update: (progress: number, speed: string | null) => void): Promise<void> {
  let outTimeSeconds = 0; let speed: string | null = null;
  await run(process.env.FLOWARR_FFMPEG_PATH ?? "ffmpeg", ffmpegArgs(plan), (line) => {
    const index = line.indexOf("="); if (index < 0) return;
    const key = line.slice(0, index); const value = line.slice(index + 1);
    if (key === "out_time_us") outTimeSeconds = number(value) / 1_000_000;
    if (key === "speed") speed = value;
    if (key === "progress") update(Math.min(99, Math.round(outTimeSeconds / Math.max(1, duration) * 100)), speed);
  });
}

export interface HevcPlan { input: string; output: string; crf: number; preset: string }
export function hevcArgs(plan: HevcPlan): string[] { return ffmpegArgs({ input: plan.input, output: plan.output, videoCodec: "libx265", quality: plan.crf, preset: plan.preset, audioCodec: "copy", subtitles: "copy", metadata: "copy", inputArgs: [], outputArgs: [] }); }
export async function transcodeHevc(plan: HevcPlan, duration: number, update: (progress: number, speed: string | null) => void): Promise<void> { return transcode({ input: plan.input, output: plan.output, videoCodec: "libx265", quality: plan.crf, preset: plan.preset, audioCodec: "copy", subtitles: "copy", metadata: "copy", inputArgs: [], outputArgs: [] }, duration, update); }

export async function validateOutput(source: NormalizedProbe, outputPath: string): Promise<NormalizedProbe> {
  const output = (await probe(outputPath)).normalized;
  if (!output.video.length) throw new Error("Output has no video stream");
  const tolerance = Math.max(2, source.format.duration * 0.02);
  if (Math.abs(output.format.duration - source.format.duration) > tolerance) throw new Error("Output duration outside 2% tolerance");
  const outputStat = await stat(outputPath);
  if (outputStat.size < 1024) throw new Error("Output is unexpectedly small");
  return output;
}

export function temporaryOutput(source: string, jobId: string): string {
  const parsed = path.parse(source);
  return path.join(parsed.dir, `${parsed.name}.processing-${jobId}${parsed.ext}`);
}

export async function safeReplace(source: string, temporary: string, jobId: string): Promise<void> {
  const backup = `${source}.flowarr-backup-${jobId}`;
  await rename(source, backup);
  try {
    await rename(temporary, source);
    await rm(backup, { force: true });
  } catch (error) {
    await rename(backup, source).catch(() => undefined);
    throw error;
  }
}
