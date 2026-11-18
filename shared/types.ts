export type Platform = "qishui" | "douyin" | "bilibili" | "local";
export type Completeness = "full" | "preview" | "unknown";
export type AccountPlatform = "qishui" | "douyin" | "bilibili";
export type AccountStatus =
  | "not_connected"
  | "unverified"
  | "checking"
  | "connected"
  | "expired"
  | "error"
  | "logging_in";
export interface AccountState {
  platform: AccountPlatform;
  status: AccountStatus;
  source: "none" | "manual" | "local" | "browser" | "qr";
  hasCredentials: boolean;
  message: string;
  checkedAt?: string;
  nickname?: string;
  vip?: boolean;
  loginWindowOpen?: boolean;
}
export interface MediaChoice {
  id: string;
  label: string;
  format: string;
  bitrate?: number;
  quality?: string;
}
export interface Resource {
  token: string;
  platform: Platform;
  sourceId: string;
  title: string;
  artist: string;
  cover?: string;
  album?: string;
  duration: number;
  expectedDuration?: number;
  completeness: Completeness;
  note: string;
  videoAudioMode?: "audio-only" | "combined";
  choices: MediaChoice[];
}
export interface Job {
  id: string;
  title: string;
  artist: string;
  platform: Platform;
  status:
    | "queued"
    | "downloading"
    | "processing"
    | "checking"
    | "completed"
    | "failed"
    | "cancelled";
  progress: number;
  message: string;
  failureKind?: "network";
  interrupted?: boolean;
  needsReview?: boolean;
  format: string;
  createdAt: string;
  completedAt?: string;
  filename?: string;
  favorite?: boolean;
  groups?: string[];
  size?: number;
  duration?: number;
  completeness: Completeness;
  resourceToken?: string;
  sourceId?: string;
  selection?: { quality?: string; bitrate?: number; format?: string };
  batchId?: string;
  requiresFullAudio?: boolean;
  fileExists?: boolean;
  outputDir?: string;
  filePath?: string;
  detached?: boolean;
  checksum?: string;
  metadata?: AudioMetadata;
  naming?: NamingStyle;
  embedCover?: boolean;
  cover?: string;
  warning?: string;
  parentJobId?: string;
  kind?: "clip" | "organized" | "vocals" | "instrumental" | "normalized";
  loudness?: LoudnessStats;
  clip?: ClipRange;
}

export interface LoudnessStats { inputI: number; inputTP: number; inputLRA: number; inputThresh: number; offset: number; }

export type NamingStyle = "artist-title" | "title-artist" | "title";
export interface AudioMetadata {
  title: string;
  artist: string;
  album?: string;
}
export interface ClipRange {
  start: number;
  end: number;
  fadeIn: number;
  fadeOut: number;
}
export interface LibrarySettings {
  naming: NamingStyle;
  embedCover: boolean;
}

export type StorageKind = "audio" | "video";
export interface StorageSettings {
  outputDir: string;
  defaultOutputDir: string;
  available: boolean;
  message: string;
  nativePicker: boolean;
}

export interface BatchItem {
  id: string;
  input: string;
  status:
    | "listed"
    | "waiting"
    | "resolving"
    | "ready"
    | "failed"
    | "cancelled"
    | "stale"
    | "duplicate"
    | "submitted";
  track?: PlaylistTrack;
  resource?: Resource;
  message: string;
  jobId?: string;
  duplicateOf?: string;
}
export type DiscoverySaveOptions = LibrarySettings & { format: "mp3" | "m4a" | "original"; outputDir: string };

export interface Batch {
  id: string;
  createdAt: string;
  status: "resolving" | "ready" | "cancelled" | "interrupted";
  duplicateInputs: number;
  items: BatchItem[];
  playlist?: PlaylistSource;
  discovery?: { title: string; autoSave?: DiscoverySaveOptions };
  playlistComparison?: { previousAt: string; addedIds: string[]; removed: PlaylistTrack[]; unchanged: number };
}
export interface PlaylistTrack {
  id: string;
  title: string;
  artist: string;
  duration: number;
}
export interface PlaylistSource {
  id: string;
  title: string;
  url: string;
  total?: number;
  reachedEnd: boolean;
  comparisonReady?: boolean;
  notice: string;
  retrievedAt: string;
}
export interface PlaylistImport {
  source: PlaylistSource;
  tracks: PlaylistTrack[];
}

export interface VideoMetadata {
  title?: string;
  artist?: string;
  platform?: "douyin" | "bilibili";
  cover?: string;
  duration?: number;
  sourceId?: string;
  videoAudioMode?: Resource["videoAudioMode"];
  height?: number;
}

export interface VideoPreview extends VideoMetadata {
  id: string;
}

export type VideoTaskAction = "play" | "retry" | "open-folder" | "cancel" | "remove" | "relocate";

export interface VideoTask extends VideoMetadata {
  id: string;
  status: "queued" | "working" | "completed" | "failed" | "cancelled";
  message: string;
  filePath?: string;
  detached?: boolean;
  checksum?: string;
  progress?: number;
  interrupted?: boolean;
  needsReview?: boolean;
  createdAt?: string;
  fileExists?: boolean;
}

export interface RecoveryItem {
  id: string;
  title: string;
  kind: "audio" | "video";
  action: "resume" | "file" | "review";
  message: string;
  canReviewSource?: boolean;
}

export interface AudioQueueState {
  paused: boolean;
  waiting: number;
  active: number;
  limit: number;
  lastSummary?: { completed: number; failed: number; at: string } | null;
}
