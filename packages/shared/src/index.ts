export type FileStatus = "detected" | "queued" | "processing" | "processed" | "failed" | "ignored";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Library {
  id: string;
  name: string;
  path: string;
  flowId: string | null;
  enabled: boolean;
  priority: number;
  extensions: string[];
  stabilitySeconds: number;
  createdAt: string;
}

export interface MediaFile {
  id: string;
  libraryId: string;
  path: string;
  name: string;
  size: number;
  status: FileStatus;
  probe: NormalizedProbe | null;
  savingsBytes: number;
  detectedAt: string;
  failureJobId?: string | null;
}

export interface NormalizedProbe {
  format: { name: string; duration: number; size: number; bitrate: number };
  video: Array<{ index: number; codec: string; width: number; height: number; pixelFormat: string; bitDepth: number; hdr: boolean; bitrate: number; frameRate: number }>;
  audio: Array<{ index: number; codec: string; channels: number; language: string | null }>;
  subtitles: Array<{ index: number; codec: string; language: string | null; forced: boolean }>;
}

export type FlowNodeKind =
  | "input" | "probe-media"
  | "codec-check" | "bit-depth-check" | "hdr-check" | "resolution-check" | "subflow" | "plugin-node"
  | "ffmpeg-start" | "hevc-encode" | "video-encode" | "scale" | "pixel-format"
  | "frame-rate" | "crop" | "rotate" | "deinterlace"
  | "audio-encode" | "audio-normalize" | "subtitle-mode" | "metadata-mode" | "custom-args" | "custom-ffmpeg" | "ffmpeg-execute"
  | "validate" | "minimum-saving" | "replace" | "success" | "failure";
export interface FlowNode { id: string; kind: FlowNodeKind; position: { x: number; y: number }; config?: Record<string, unknown> }
export interface FlowEdge { id: string; source: string; target: string; sourceHandle?: string }
export interface FlowGraph { version: 1; name: string; nodes: FlowNode[]; edges: FlowEdge[] }

export interface Job {
  id: string;
  fileId: string;
  status: JobStatus;
  progress: number;
  speed: string | null;
  etaSeconds: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  workerId: string | null;
}

export interface WorkerCapabilities {
  platform: string;
  architecture: string;
  cpu: string;
  logicalCpus: number;
  totalMemory: number;
  freeMemory: number;
  ffmpeg: { available: boolean; version?: string; encoders: string[]; error?: string };
}

export interface PathMapping { serverPath: string; workerPath: string }

export interface WorkerSchedule {
  mode: "always" | "scheduled" | "disabled";
  timezone: string;
  days: number[];
  start: string;
  end: string;
}

export interface WorkerInfo {
  id: string;
  name: string;
  kind: "local" | "remote";
  priority: number;
  schedule: WorkerSchedule;
  scheduleActive: boolean;
  status: "online" | "offline";
  capabilities: WorkerCapabilities;
  pathMappings: PathMapping[];
  lastSeenAt: string;
  createdAt: string;
}

export interface RemoteJob {
  id: string;
  fileId: string;
  sourcePath: string;
  sourceSize: number;
  graph: FlowGraph;
}
export type IntegrationKind = "sonarr" | "radarr" | "jellyfin";
export interface Integration {
  id: string;
  kind: IntegrationKind;
  name: string;
  baseUrl: string;
  enabled: boolean;
  syncOnSuccess: boolean;
  hasApiKey: boolean;
  lastTestAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
