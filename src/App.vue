<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import AudioCover from "./components/AudioCover.vue";
import VideoWorkspace from "./components/VideoWorkspace.vue";
import BilibiliLogin from "./components/BilibiliLogin.vue";
import SavedVideoDialog from "./components/SavedVideoDialog.vue";
import ExtractionDestination from "./components/ExtractionDestination.vue";
import TasksWorkspace from "./components/TasksWorkspace.vue";
import TaskRecovery from "./components/TaskRecovery.vue";
import shiyinIcon from "../desktop/icon.svg";
import SourceIcon from "./components/SourceIcon.vue";
import { hasExplicitOutputFormat, rememberOutputFormat, savedOutputFormat, setDefaultOutputFormat, type OutputFormat } from "./default-format";
import { lastSettingsSection, type SettingsSection } from "./settings-sections";
import { confirmPlaybackStopped, onDesktopAction } from "./desktop-preferences";
import SettingsWorkspace from "./components/SettingsWorkspace.vue";
import FileLocation from "./components/FileLocation.vue";
import SongOptions from "./components/SongOptions.vue";
import AudioEditor from "./components/AudioEditor.vue";
import QishuiDiscovery from "./components/QishuiDiscovery.vue";
import LocalBatchPanel from "./components/LocalBatchPanel.vue";
import LibraryWorkspace from "./components/LibraryWorkspace.vue";
import LibraryGroupDialog from "./components/LibraryGroupDialog.vue";
import { localBatch } from "./local-batch";
import { fileFormat } from "../shared/library-filters";
import { canBatchRetry } from "../shared/retry-policy";
import {
  AudioLines,
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  Info,
  ChevronDown,
  ChevronRight,
  Clipboard,
  FileAudio,
  FolderOpen,
  Layers, ListMusic, ListPlus, Ellipsis, ArrowRight,
  SquarePlay,
  Link2,
  LoaderCircle,
  Music2,
  Plus,
  Settings,
  ShieldCheck,
  Upload,
  X,
  AlertCircle,
  Play,
  Download,
  Clock3,
  ExternalLink,
  Scissors,
  Tags,
  Heart,
  SkipBack, SkipForward, Pause, Volume2, VolumeX, Repeat, Repeat1,
} from "@lucide/vue";
import type {
  AccountPlatform,
  AccountState,
  Resource,
  Job,
  AudioMetadata,
  AudioQueueState,
  VideoTask, VideoTaskAction,
} from "../shared/types";
const playlistNames = ref<string[]>([]);
const libraryUpdating=ref(false);
const groupJobIds=ref<string[] | null>(null);
let jobsRevision=0;
const groupKey = (name: string) => name.normalize("NFC").trim().toLocaleLowerCase("zh-CN");
const allGroups = computed(() => {
  const names = new Map(playlistNames.value.map(name => [groupKey(name), name]));
  for (const job of jobs.value) {
    if (job.status !== "completed") continue;
    for (const name of job.groups || []) if (!names.has(groupKey(name))) names.set(groupKey(name), name);
  }
  return [...names.values()];
});
const assignedGroups=computed(()=>{
  const chosen=new Set(groupJobIds.value||[]), seen=new Map<string,string>();
  for(const job of jobs.value) if(chosen.has(job.id)) for(const name of job.groups||[]) seen.set(name.normalize('NFC').toLocaleLowerCase('zh-CN'),name);
  return [...seen.values()];
});
async function updateLibrary(ids:string[],action:'favorite'|'add-group'|'remove-group',value:boolean|string) {
  if(libraryUpdating.value) throw new Error('正在整理音频，请稍候。');
  libraryUpdating.value=true; jobsRevision++;
  try {
    const result: { jobs: Job[]; playlists?: string[] } = await post('/api/library/organize', { ids, action, value });
    jobsRevision++;
    const byId=new Map(result.jobs.map(job=>[job.id,job]));
    jobs.value=jobs.value.map(job=>byId.get(job.id)||job);
    if (result.playlists) playlistNames.value = result.playlists;
  } finally { jobsRevision++;libraryUpdating.value=false; }
}
async function toggleFavorite(job:Job) {
  try {await updateLibrary([job.id],'favorite',!job.favorite);}
  catch(e){toast((e as Error).message);}
}
function groupChanged(message:string) { groupJobIds.value=null;toast(message); }

async function renameOrCreatePlaylist(action: "create" | "rename" | "remove", name: string, newName?: string) {
  if (libraryUpdating.value) throw new Error("正在整理音频，请稍候。");
  libraryUpdating.value = true;
  jobsRevision++;
  try {
    const result: { playlists: string[]; jobs: Job[] } = await post("/api/library/playlists", { action, name, newName });
    jobsRevision++;
    const updates = new Map(result.jobs.map(job => [job.id, job]));
    jobs.value = jobs.value.map(job => updates.get(job.id) || job);
    playlistNames.value = result.playlists;
  } finally {
    jobsRevision++;
    libraryUpdating.value = false;
  }
}

const localBatchMode = ref(localBatch.items.length > 0);
const localPanel = ref<InstanceType<typeof LocalBatchPanel>>();
async function uploadFiles(files: File[]) {
  if (!files.length) return;
  if (fileInput.value) fileInput.value.value = "";
  if (files.length === 1 && !localBatchMode.value) { await upload(files[0]); return; }
  localBatchMode.value = true;
  await nextTick();
  await localPanel.value?.addFiles(files);
}
const songMetadata = ref<AudioMetadata | undefined>();
const forceCopy = ref(false);

const editingJob = ref<Job | null>(null);
const removingAudio = new Set<string>();
async function removeAudio(job: Job) {
  if (removingAudio.has(job.id)) return;
  removingAudio.add(job.id);
  try {
    await post(`/api/jobs/${encodeURIComponent(job.id)}/remove`);
    if (playing.value === job.id) {
      playerAudio.value?.pause();
      playing.value = "";
    }
    jobsRevision++;
    jobs.value = jobs.value.filter(item => item.id !== job.id);
    playbackIds.value = playbackIds.value.filter(id => id !== job.id);
    await refresh();
    toast("已移除记录，音频文件仍在原处。");
  } catch (error) {
    toast((error as Error).message, 9000);
  } finally { removingAudio.delete(job.id); }
}
const editorMode = ref<"clip" | "organize">("clip");
function editClip(job: Job, mode: "clip" | "organize" = "clip") {
  playerAudio.value?.pause();
  editorMode.value = mode;
  editingJob.value = job;
}
async function clipSaved() {
  editingJob.value = null;
  toast("已加入任务，完成后可在文件中查看。");
  await refresh();
}
const page = ref("workspace"),
  mode = ref("link"),
  input = ref(""),
  busy = ref(false),
  uploading = ref(false),
  resource = ref<Resource | null>(null),
  jobs = ref<Job[]>([]),
  format = ref(savedOutputFormat()),
  choice = ref(""),
  error = ref(""),
  notice = ref(""),
  health = ref<any>(null),
  settings = ref<any>({}),
  settingsBusy = ref(false),
  fileInput = ref<HTMLInputElement | null>(null),
  shareLinkField = ref<HTMLTextAreaElement | null>(null),
  playing = ref("");
const scrollByPage = new Map<string, number>();
watch(page, async (current, previous) => {
  scrollByPage.set(previous, window.scrollY);
  await nextTick();
  if (page.value === current) window.scrollTo(0, scrollByPage.get(current) ?? 0);
});
const settingsSection = ref<SettingsSection>(lastSettingsSection());
watch(settingsSection, section => localStorage.setItem("shiyin-settings-section", section));
let removeDesktopActions: (() => void) | undefined;
const defaultFormat = ref(savedOutputFormat());
function openSettings(section: SettingsSection = "general") {
  defaultFormat.value = savedOutputFormat();
  settingsSection.value = section;
  page.value = "settings";
}
function changeDefaultFormat(value: OutputFormat) {
  setDefaultOutputFormat(value);
  defaultFormat.value = savedOutputFormat();
  format.value = defaultFormat.value;
  if (!localBatch.items.length && !localBatch.busy) localBatch.format = defaultFormat.value;
}
const playerAudio = ref<HTMLAudioElement | null>(null);
const playerPaused = ref(true);
const playbackList = ref(false);
const queuePopover = ref<HTMLElement>();
const playbackIds = ref<string[]>([]);
type RepeatMode = "off" | "all" | "one";
const storedRepeat = localStorage.getItem("shiyin-repeat");
const repeatMode = ref<RepeatMode>(storedRepeat === "all" || storedRepeat === "one" ? storedRepeat : "off");
const repeatLabel = computed(() => ({ off: "顺序播放", all: "列表循环", one: "单曲循环" })[repeatMode.value]);
const repeatNotice = ref("");
let repeatNoticeTimer: ReturnType<typeof setTimeout> | undefined;
function cycleRepeat() {
  repeatMode.value = ({ off: "all", all: "one", one: "off" } as const)[repeatMode.value];
  localStorage.setItem("shiyin-repeat", repeatMode.value);
  repeatNotice.value = repeatLabel.value;
  clearTimeout(repeatNoticeTimer);
  repeatNoticeTimer = setTimeout(() => { repeatNotice.value = ""; }, 2000);
}
const playerPosition = ref(0);
const playerDuration = ref(0);
const storedVolume = localStorage.getItem("shiyin-player-volume");
const parsedVolume = storedVolume === null ? 1 : Number(storedVolume);
const playerVolume = ref(Number.isFinite(parsedVolume) ? Math.min(1, Math.max(0, parsedVolume)) : 1);
const playerMuted = ref(false);
const playerJob = computed(() => jobs.value.find(job => job.id === playing.value));
const availableAudio = computed(() => jobs.value.filter(job => job.status === "completed" && job.fileExists !== false));
const playableJobs = computed(() => {
  const byId = new Map(availableAudio.value.map(job => [job.id, job]));
  return playbackIds.value.flatMap(id => {
    const job = byId.get(id);
    return job ? [job] : [];
  });
});
function enqueueAudio(job: Job, feedback = true) {
  if (job.status !== "completed" || job.fileExists === false) return;
  if (playbackIds.value.includes(job.id)) {
    if (feedback) toast("歌曲已在播放队列中。");
    return;
  }
  playbackIds.value.push(job.id);
  if (feedback) toast("已加入播放队列。");
}
function removeFromQueue(job: Job) {
  const index = playableJobs.value.findIndex(item => item.id === job.id);
  const next = playableJobs.value[index + 1] ?? playableJobs.value[index - 1];
  playbackIds.value = playbackIds.value.filter(id => id !== job.id);
  if (playing.value !== job.id) return;
  const wasPlaying = !!playerAudio.value && !playerAudio.value.paused;
  playerAudio.value?.pause();
  playing.value = wasPlaying ? (next?.id ?? "") : "";
}
function playLibrary(jobs: Job[], start?: string) {
  if (!jobs.length) return;
  playbackIds.value = [...new Set(jobs.map(job => job.id))];
  const first = start || jobs[0].id;
  if (playing.value === first && playerAudio.value) {
    if (start) togglePlayer();
    else {
      playerAudio.value.currentTime = 0;
      void playerAudio.value.play().catch(() => toast("无法播放该音频，请检查文件是否存在。"));
    }
  } else playing.value = first;
}
function playSingle(job: Job) {
  enqueueAudio(job, false);
  if (playing.value === job.id) togglePlayer();
  else playing.value = job.id;
}
function finishPlayerTrack() {
  const list = playableJobs.value;
  const index = list.findIndex(job => job.id === playing.value);
  const next = repeatMode.value === "one" && index >= 0 ? list[index]
    : list[index + 1] ?? (repeatMode.value === "all" ? list[0] : undefined);
  if (next && playing.value !== next.id) {
    playing.value = next.id;
    return;
  }
  playerPaused.value = true;
  if (playerAudio.value) {
    playerAudio.value.currentTime = 0;
    if (next) void playerAudio.value.play().catch(() => toast("无法播放该音频，请检查文件是否存在。"));
  }
  playerPosition.value = 0;
}
async function refreshPlaylists() {
  const revision = jobsRevision;
  try {
    const result: { playlists?: string[] } = await api("/api/library/playlists");
    if (revision === jobsRevision && Array.isArray(result.playlists)) playlistNames.value = result.playlists;
  } catch (error) { toast((error as Error).message); }
}
watch(page, current => { if (current === "files") void refreshPlaylists(); });
watch(playing, () => { playerPosition.value = 0; playerDuration.value = 0; playerPaused.value = true; });
watch(playerJob, job => {
  if (playing.value && (!job || job.fileExists === false)) {
    playbackIds.value = playbackIds.value.filter(id => id !== playing.value);
    playing.value = "";
  }
});
function playerMove(direction: number) {
  const list = playableJobs.value;
  if (!list.length) return;
  const index = list.findIndex(job => job.id === playing.value);
  const next = index === -1 ? (direction < 0 ? list.length - 1 : 0) : (index + direction + list.length) % list.length;
  playing.value = list[next].id;
}
function togglePlayer() {
  const audio = playerAudio.value;
  if (!audio) { if (playableJobs.value.length) playing.value = playableJobs.value[0].id; return; }
  if (audio.paused) {
    if (audio.error) audio.load();
    void audio.play().catch(() => toast("无法播放该音频，请检查文件是否存在。"));
  } else audio.pause();
}
function seekPlayer(event: Event) { if (playerAudio.value) playerAudio.value.currentTime = Number((event.target as HTMLInputElement).value); }
function applyPlayerSound() {
  if (!playerAudio.value) return;
  playerAudio.value.volume = playerVolume.value;
  playerAudio.value.muted = playerMuted.value;
}
function changePlayerVolume(event: Event) {
  playerVolume.value = Number((event.target as HTMLInputElement).value);
  localStorage.setItem("shiyin-player-volume", String(playerVolume.value));
  playerMuted.value = false;
  applyPlayerSound();
}
function toggleMute() {
  if (playerVolume.value === 0) {
    playerVolume.value = 0.5;
    localStorage.setItem("shiyin-player-volume", "0.5");
    playerMuted.value = false;
  } else playerMuted.value = !playerMuted.value;
  applyPlayerSound();
}
function closePlaybackList() {
  if (queuePopover.value?.matches(":popover-open")) queuePopover.value.hidePopover();
}
function syncPlaybackList(event: Event) {
  playbackList.value = (event.currentTarget as HTMLElement).matches(":popover-open");
}
function playerMetadata(event: Event) {
  playerDuration.value = (event.target as HTMLAudioElement).duration;
  applyPlayerSound();
}
function pauseForPreview() {
  playerAudio.value?.pause();
}
const desktop = "shiyinDesktop" in window;
let timer: ReturnType<typeof setInterval> | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let resourceRequest = 0;
const queueState = ref<AudioQueueState | null>(null);
const queueBusy = ref(false);
let queueRevision = 0;
async function setQueuePaused(paused: boolean) {
  if (!queueState.value || queueState.value.paused === paused || queueBusy.value) return;
  queueBusy.value = true;
  queueRevision++;
  try {
    queueState.value = await post("/api/queue", {paused});
    queueRevision++;
    await refresh();
  } catch (e) { toast((e as Error).message); }
  finally { queueBusy.value = false; }
}

const pendingPlaylistInput = ref("");
const reviewingBatchItem = ref<{ batchId: string; itemId: string }>();
function selectDiscoveredSong(id: string, parsed?: Resource, batchId?: string, itemId?: string) {
  invalidateResource();
  page.value = "workspace";
  input.value = `https://music.douyin.com/qishui/share/track?track_id=${id}`;
  mode.value = "link";
  error.value = "";
  if (parsed) showResource(parsed);
  if (batchId && itemId) reviewingBatchItem.value = { batchId, itemId };
}
function openDiscovery(playlist = "") {
  pendingPlaylistInput.value = playlist;
  mode.value = "discovery";
  error.value = "";
}
const qishuiQr = ref<{
  id: string;
  image: string;
  expiresAt: number;
  phase: string;
  message: string;
  verificationRequired?: boolean;
} | null>(null);
const verificationBusy = ref(false);
async function openQishuiVerification() {
  if (!qishuiQr.value || verificationBusy.value) return;
  verificationBusy.value = true;
  try {
    await post(`/api/login/qishui/qr/${qishuiQr.value.id}/verification/open`);
  } catch (e) {
    toast((e as Error).message);
  } finally {
    verificationBusy.value = false;
  }
}
const qrBusy = ref(false);
const settingsError = ref("");
let qrPolling = false;
async function createQishuiQr() {
  if (qrBusy.value) return;
  qrBusy.value = true;
  settingsError.value = "";
  invalidateResource();
  try {
    const data = await post("/api/login/qishui/qr");
    qishuiQr.value = data.qr;
    settings.value = data;
    toast("请使用手机抖音 App 扫码，并在手机上确认。");
  } catch (e) {
    toast((e as Error).message);
  } finally {
    qrBusy.value = false;
  }
}
async function pollQishuiQr() {
  if (
    !qishuiQr.value ||
    qrPolling ||
    ["confirmed", "expired"].includes(qishuiQr.value.phase)
  )
    return;
  qrPolling = true;
  const id = qishuiQr.value.id;
  try {
    const data = await api(`/api/login/qishui/qr/${id}`);
    if (qishuiQr.value?.id !== id) return;
    qishuiQr.value = data.qr;
    settings.value = data;
    if (
      data.qr.phase !== "new" &&
      notice.value === "请使用手机抖音 App 扫码，并在手机上确认。"
    )
      notice.value = "";
    if (
      data.qr.phase === "confirmed" &&
      account("qishui").status === "connected"
    ) {
      if (
        resource.value?.platform === "qishui" ||
        /qishui|music\.douyin/.test(input.value)
      )
        invalidateResource();
      toast("汽水账号已登录，请重新解析歌曲。");
    }
  } catch (e) {
    if (qishuiQr.value?.id === id)
      qishuiQr.value = {
        ...qishuiQr.value,
        phase: "error",
        message: (e as Error).message,
      };
  } finally {
    qrPolling = false;
  }
}
async function cancelQishuiQr() {
  const current = qishuiQr.value;
  qishuiQr.value = null;
  if (!current) return;
  try {
    settings.value = await api(`/api/login/qishui/qr/${current.id}`, {
      method: "DELETE",
    });
  } catch (e) {
    toast((e as Error).message);
  }
}
const checkingAccount = ref<AccountPlatform | "">("");
const retryingJobs = ref(new Set<string>());
const account = (platform: AccountPlatform): AccountState =>
  settings.value.accounts?.[platform] || {
    platform,
    status: "not_connected",
    source: "none",
    hasCredentials: false,
    message: "尚未连接。公开资源可以先直接解析。",
  };
const accountLabel = (platform: AccountPlatform) =>
  ({
    not_connected: "未连接",
    unverified: "等待检查",
    checking: "正在检查",
    connected: "已登录",
    expired: "登录已失效",
    error: "检查暂未成功",
    logging_in:
      platform === "qishui"
        ? qishuiQr.value?.verificationRequired
          ? "等待电脑验证"
          : ["scanned", "cooldown"].includes(qishuiQr.value?.phase || "")
            ? "连接确认中"
            : "等待扫码"
        : "等待窗口登录",
  })[account(platform).status];
const recoveryJobId = ref("");
const audioDestinationReady = ref(false);
const songOptionsOpen = ref(false);
const recoveryDestination = computed(() => jobs.value.find(job => job.id === recoveryJobId.value)?.outputDir);
watch(() => resource.value?.token, () => {
  audioDestinationReady.value = false;
  songOptionsOpen.value = false;
  songMetadata.value = undefined;
  forceCopy.value = false;
}, { flush: "sync" });

function invalidateResource() {
  const previous = resource.value;
  resourceRequest++;
  resource.value = null;
  recoveryJobId.value = "";
  reviewingBatchItem.value = undefined;
  if (previous?.platform === "local" && !busy.value) discardUpload(previous);
}
function discardUpload(uploaded: Resource) {
  void api(`/api/uploads/${encodeURIComponent(uploaded.token)}`, { method: "DELETE" }).catch(() => {});
}
const activeJobs = computed(() =>
  jobs.value.filter(
    (j) => !["completed", "failed", "cancelled"].includes(j.status),
  ),
);
watch(input, () => {
  invalidateResource();
  error.value = "";
}, { flush: "sync" });
watch(mode, () => {
  invalidateResource();
  error.value = "";
}, { flush: "sync" });
watch(localBatchMode, () => {
  if (mode.value !== "file") return;
  invalidateResource();
  error.value = "";
}, { flush: "sync" });
const failedJobs = computed(() => jobs.value.filter(job => job.status === "failed"));
const recoverableJobs = computed(() => failedJobs.value.filter(canBatchRetry));
const bulkRetryBusy = ref(false);
const bulkRetryMessage = ref("");
const bulkRetryErrors = ref<{id:string; title:string; message:string}[]>([]);
async function retryFailedJobs() {
  if (bulkRetryBusy.value || queueState.value?.paused || !recoverableJobs.value.length) return;
  const selected = recoverableJobs.value.slice(0, 20);
  bulkRetryBusy.value = true; bulkRetryMessage.value = ""; bulkRetryErrors.value = [];
  try {
    const data: {results: {id:string; status:"started"|"skipped"|"failed"; message:string}[]} = await post("/api/jobs/retry-failed", {ids:selected.map(job=>job.id)});
    const count = (status:string) => data.results.filter(item=>item.status===status).length;
    bulkRetryMessage.value = `已重新发起 ${count("started")} 项，未能重新发起 ${count("failed")} 项，状态变化或暂停而跳过 ${count("skipped")} 项。结果以任务状态为准。`;
    bulkRetryErrors.value = data.results.filter(item=>item.status!=="started").map(item=>({id:item.id,title:selected.find(job=>job.id===item.id)?.title || "任务",message:item.message}));
    await refresh();
  } catch(error) { bulkRetryMessage.value = (error as Error).message; await refresh(); }
  finally { bulkRetryBusy.value = false; }
}
const completeJobs = computed(() =>
  jobs.value.filter((j) => j.status === "completed"),
);
const platformName = (p: string) =>
  ({ qishui: "汽水音乐", douyin: "抖音视频", local: "本地文件", bilibili: "B 站" })[p] || p;
const statusName = (s: string) =>
  ({
    queued: "等待处理",
    downloading: "获取资源",
    processing: "提取音频",
    checking: "核对文件",
    completed: "已完成",
    failed: "未完成",
    cancelled: "已取消",
  })[s] || s;
const time = (n: number) =>
  !Number.isFinite(n) || !n
    ? "时长未知"
    : `${Math.floor(n / 60)
        .toString()
        .padStart(2, "0")}:${Math.floor(n % 60)
        .toString()
        .padStart(2, "0")}`;
function toast(message: string, duration = 4500) {
  notice.value = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ""), duration);
}
async function api(url: string, options?: RequestInit) {
  const r = await fetch(url, options);
  const data = await r.json();
  if (!r.ok) {
    if (r.status === 404 && (url === "/api/video" || url === "/api/videos") && data.error === "接口不存在。")
      throw new Error("后台版本过旧，请关闭旧的拾音网页服务，然后重新运行“启动拾音.command”。");
    throw new Error(data.error || "操作未完成，请重试。");
  }
  return data;
}
const post = (url: string, body: any = {}) =>
  api(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const videos = ref<VideoTask[]>([]);
const videoLoadError = ref("");
const videoBusy = ref("");
const playingVideo = ref<VideoTask | null>(null);
const recoveryOpen = ref(false);
const initialTaskType = ref<"all" | "audio" | "video">("all");
const initialDiscoveryBatch = ref("");
const videoQueueState = ref<AudioQueueState | null>(null);
const videoQueueBusy = ref(false);
let videoQueueRevision = 0;
let videoRefreshing = false;
let videoRevision = 0;

async function refreshVideos() {
  if (videoRefreshing) return;
  videoRefreshing = true;
  const revision = videoRevision;
  const queueRevision = videoQueueRevision;
  const queueRequest = api("/api/video/queue").then(data => {
    if (queueRevision === videoQueueRevision && !videoQueueBusy.value) videoQueueState.value = data;
  }).catch(() => {});
  try {
    const list = await api("/api/videos");
    if (!Array.isArray(list)) throw new Error("暂时无法读取视频任务。");
    if (revision === videoRevision) videos.value = list;
    videoLoadError.value = "";
  } catch (cause) { videoLoadError.value = (cause as Error).message; }
  finally { await queueRequest; videoRefreshing = false; }
}
async function setVideoQueuePaused(paused: boolean) {
  if (videoQueueBusy.value || !videoQueueState.value || videoQueueState.value.paused === paused) return;
  videoQueueBusy.value = true;
  videoQueueRevision++;
  try { videoQueueState.value = await post("/api/video/queue", { paused }); }
  catch (cause) { toast((cause as Error).message); }
  finally { videoQueueBusy.value = false; }
}
function updateVideoTask(task: VideoTask) {
  videoRevision++;
  const index = videos.value.findIndex(item => item.id === task.id);
  if (index < 0) videos.value = [task, ...videos.value];
  else videos.value = videos.value.map(item => item.id === task.id ? task : item);
}
async function videoAction(action: VideoTaskAction, task: VideoTask) {
  if (action === "play") {
    pauseForPreview();
    playingVideo.value = task;
    return;
  }
  if (videoBusy.value) return;
  videoBusy.value = task.id;
  try {
    const result = await post(`/api/video/${encodeURIComponent(task.id)}/${action}`);
    if (action === "relocate" && !result) return;
    if (action === "remove") {
      videoRevision++;
      videos.value = videos.value.filter(item => item.id !== task.id);
      if (playingVideo.value?.id === task.id) playingVideo.value = null;
      toast("已移除记录，视频文件仍在原处。");
    } else if (action !== "open-folder") updateVideoTask(result as VideoTask);
  } catch (cause) { toast((cause as Error).message); }
  finally { videoBusy.value = ""; }
}
function showTasks(type: typeof initialTaskType.value = "all", recover = false) {
  initialTaskType.value = type;
  recoveryOpen.value = recover;
  page.value = "tasks";
}
function showDiscoveryBatch(id: string) {
  showTasks("audio");
  initialDiscoveryBatch.value = id;
}
function finishDiscoveryBatch(id: string) {
  if (initialDiscoveryBatch.value === id) initialDiscoveryBatch.value = "";
}
const watchingVideos = computed(() => page.value === "tasks" || page.value === "video");
watch(watchingVideos, active => { if (active) void refreshVideos(); });

async function refresh() {
  const revision = queueRevision;
  const jobRevision = jobsRevision;
  const [jobResult, queueResult] = await Promise.allSettled([api("/api/jobs"), api("/api/queue")]);
  if (jobResult.status === "fulfilled" && jobRevision === jobsRevision && !libraryUpdating.value) jobs.value = jobResult.value;
  if (queueResult.status === "fulfilled" && revision === queueRevision && !queueBusy.value) queueState.value = queueResult.value;
}
async function loadSettings() {
  settings.value = await api("/api/settings");
}
function showResource(result: Resource) {
  resource.value = result;
  songOptionsOpen.value = result.platform === "local";
  if (hasExplicitOutputFormat()) format.value = savedOutputFormat();
  const losslessRank = (quality?: string) => quality === "hi_res" ? 2 : quality === "lossless" ? 1 : 0;
  choice.value = result.choices.slice().sort((a, b) =>
    losslessRank(b.quality) - losslessRank(a.quality) || (b.bitrate ?? 0) - (a.bitrate ?? 0)
  )[0]?.id || "";
}
function openVideoAudio(result: Resource, source: string) {
  invalidateResource();
  page.value = "workspace";
  mode.value = "link";
  input.value = source;
  error.value = "";
  showResource(result);
}
function reviewRecoverySource(result: Resource, id: string) {
  openVideoAudio(result, "");
  recoveryJobId.value = id;
  const oldFormat = jobs.value.find(job => job.id === id)?.format;
  if (oldFormat === "mp3" || oldFormat === "m4a" || oldFormat === "original") format.value = oldFormat;
}
async function resolve() {
  if (busy.value || !input.value.trim()) return;
  const request = ++resourceRequest;
  const source = input.value;
  busy.value = true;
  error.value = "";
  resource.value = null;
  reviewingBatchItem.value = undefined;
  try {
    const result = await post("/api/resolve", { input: source });
    if (request !== resourceRequest || input.value !== source) return;
    showResource(result);
  } catch (e) {
    if (request === resourceRequest) error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function paste() {
  try {
    const text = await navigator.clipboard.readText();
    if (text.trim()) {
      input.value = text;
      error.value = "";
    } else toast("剪贴板没有可粘贴的文字。");
  } catch {
    toast("请直接在输入框中粘贴分享链接。");
  } finally { shareLinkField.value?.focus(); }
}
async function upload(file?: File) {
  if (!file || uploading.value) return;
  invalidateResource();
  const request = resourceRequest;
  uploading.value = true;
  error.value = "";
  try {
    const body = new FormData();
    body.append("file", file);
    const result: Resource = await api("/api/upload", { method: "POST", body });
    if (request !== resourceRequest) {
      discardUpload(result);
      return;
    }
    showResource(result);
  } catch (e) {
    if (request === resourceRequest) error.value = (e as Error).message;
  } finally {
    uploading.value = false;
    if (fileInput.value) fileInput.value.value = "";
  }
}
function drop(event: DragEvent) {
  event.preventDefault();
  void uploadFiles(Array.from(event.dataTransfer?.files || []));
}
async function createJob() {
  const current = resource.value;
  if (!current || busy.value || !audioDestinationReady.value) return;
  const requestedFormat = format.value;
  const recoveryId = recoveryJobId.value;
  const reviewed = reviewingBatchItem.value;
  const endpoint = recoveryId ? `/api/recovery/${encodeURIComponent(recoveryId)}/confirm`
    : reviewed ? `/api/batches/${encodeURIComponent(reviewed.batchId)}/items/${encodeURIComponent(reviewed.itemId)}/submit`
    : "/api/jobs";
  busy.value = true;
  error.value = "";
  try {
    await post(endpoint, {
      ...(recoveryId ? {} : {
        metadata: songMetadata.value,
        forceCopy: forceCopy.value,
      }),
      token: current.token,
      format: requestedFormat,
      choice: choice.value,
      allowPreview: current.completeness === "preview",
    });
    if (!recoveryId) rememberOutputFormat(requestedFormat);
    if (resource.value === current && (recoveryId || reviewed || current.platform === "local")) invalidateResource();
    if (reviewed) showDiscoveryBatch(reviewed.batchId);
    if (recoveryId) toast("已继续上次任务。");
    await refresh();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
const separating = ref(new Set<string>());
async function separateJob(job: Job, kind?: "vocals" | "instrumental") {
  if (separating.value.has(job.id)) return;
  separating.value.add(job.id);
  try {
    await post(`/api/jobs/${job.id}/separate`, kind ? { kind } : {});
    toast("正在本机分离人声和伴奏，可在任务列表查看。");
    await refresh();
  } catch (e) { toast((e as Error).message); }
  finally { separating.value.delete(job.id); }
}
async function retry(job: Job) {
  if (retryingJobs.value.has(job.id)) return;
  if (job.interrupted) {
    page.value = "tasks";
    await nextTick();
    document.getElementById("task-recovery-title")?.scrollIntoView({ block: "nearest" });
    return;
  }
  if (job.parentJobId) {
    const parent = jobs.value.find((item) => item.id === job.parentJobId);
    if (parent && parent.fileExists !== false) {
      if (job.kind === "vocals" || job.kind === "instrumental") await separateJob(parent, job.kind);
      else if (job.kind === "normalized") toast("这条旧任务的音量处理功能已移除。");
      else editClip(parent, job.kind === "organized" ? "organize" : "clip");
    }
    else toast("原音频已移走，请先重新定位原文件再处理。");
    return;
  }
  if (job.platform === "local") {
    page.value = "workspace";
    mode.value = "file";
    toast("请重新选择本地文件。");
    return;
  }
  try {
    retryingJobs.value.add(job.id);
    toast("正在重新获取资源…");
    await post(`/api/jobs/${job.id}/retry`);
    await refresh();
  } catch (e) {
    toast((e as Error).message);
  } finally {
    retryingJobs.value.delete(job.id);
  }
}
async function cancel(id: string) {
  try {
    await post(`/api/jobs/${id}/cancel`);
    await refresh();
  } catch (e) {
    toast((e as Error).message);
  }
}
async function clearTaskRecords(ids: string[]) {
  jobsRevision++;
  try {
    const result: { removed: number } = await post("/api/jobs/clear-incomplete", { ids });
    jobsRevision++;
    const cleared = new Set(ids);
    jobs.value = jobs.value.filter(job => !cleared.has(job.id));
    toast(`已移除 ${result.removed} 条任务记录。`);
  } finally {
    await refresh();
  }
}
function taskAction(action: "play" | "folder" | "reveal" | "clip" | "organize" | "separate" | "cancel" | "retry" | "remove-record" | "enqueue", job: Job) {
  switch (action) {
    case "play": playSingle(job); break;
    case "folder": void openJobFolder(job); break;
    case "reveal": void revealJob(job); break;
    case "clip": editClip(job); break;
    case "organize": editClip(job, "organize"); break;
    case "separate": void separateJob(job); break;
    case "cancel": void cancel(job.id); break;
    case "retry": void retry(job); break;
    case "remove-record": void removeAudio(job); break;
    case "enqueue": enqueueAudio(job); break;
  }
}
function libraryAction(action: "favorite" | "group" | "clip" | "organize" | "separate" | "remove-record" | "reveal" | "folder" | "enqueue", job: Job) {
  switch (action) {
    case "favorite": void toggleFavorite(job); break;
    case "group": groupJobIds.value = [job.id]; break;
    case "clip": editClip(job); break;
    case "organize": editClip(job, "organize"); break;
    case "separate": void separateJob(job); break;
    case "remove-record": void removeAudio(job); break;
    case "enqueue": enqueueAudio(job); break;
    case "reveal": void revealJob(job); break;
    case "folder": void openJobFolder(job); break;
  }
}
async function revealJob(job: Job) {
  try {
    await post(`/api/jobs/${job.id}/reveal`);
  } catch (e) {
    toast((e as Error).message);
    await refresh();
  }
}
async function openJobFolder(job: Job) {
  try {
    await post(`/api/jobs/${job.id}/open-folder`);
  } catch (e) {
    toast((e as Error).message);
  }
}
async function clearAccount(platform: AccountPlatform) {
  settingsBusy.value = true;
  invalidateResource();
  try {
    settings.value = await api(`/api/accounts/${platform}`, {
      method: "DELETE",
    });
    if (platform === "qishui") qishuiQr.value = null;
    toast("已断开本工具中的账号连接。");
  } catch (e) {
    toast((e as Error).message);
  } finally {
    settingsBusy.value = false;
  }
}
async function checkAccount(platform: AccountPlatform) {
  if (checkingAccount.value) return;
  checkingAccount.value = platform;
  invalidateResource();
  try {
    settings.value = await post(`/api/accounts/${platform}/check`);
    toast(accountLabel(platform));
  } catch (e) {
    toast((e as Error).message);
  } finally {
    checkingAccount.value = "";
  }
}
async function connectDouyin() {
  settingsError.value = "";
  settingsBusy.value = true;
  invalidateResource();
  try {
    settings.value = await post("/api/login/douyin");
  } catch (e) {
    settingsError.value = (e as Error).message;
  } finally {
    settingsBusy.value = false;
  }
}
async function resolveAgain() {
  page.value = "workspace";
  mode.value = "link";
  await resolve();
}
async function stopPlaybackForShutdown() {
  const active = Array.from(document.querySelectorAll<HTMLMediaElement>("audio, video")).filter(media => !media.paused);
  await Promise.all(active.map(media => new Promise<void>(resolve => {
    media.addEventListener("pause", () => resolve(), { once: true });
    media.pause();
  })));
  playingVideo.value = null;
  confirmPlaybackStopped();
}
onMounted(async () => {
  removeDesktopActions = onDesktopAction(action => {
    if (action.type === "settings") openSettings(lastSettingsSection());
    if (action.type === "paste" && action.text) {
      page.value = "workspace";
      mode.value = "link";
      input.value = action.text;
      void nextTick(() => shareLinkField.value?.focus());
    }
    if (action.type === "stop-playback") void stopPlaybackForShutdown();
  });
  try {
    [health.value] = await Promise.all([api("/api/health"), loadSettings()]);
    const login = await api("/api/login/qishui/qr");
    qishuiQr.value = login.qr;
    settings.value = login;
  } catch {
    error.value = "本地服务未连接，请重新启动工具。";
  }
  await refresh();
  void api("/api/discovery/batches").then((history: { id: string; needsAttention?: boolean }[]) => {
    if (!initialDiscoveryBatch.value) initialDiscoveryBatch.value = history.find(batch => batch.needsAttention)?.id || "";
  }).catch(() => {});
  timer = setInterval(() => {
    void refresh();
    if (watchingVideos.value) void refreshVideos();
    void pollQishuiQr();
    if (page.value === "settings") {
      void loadSettings().catch(() => {});
    }
  }, 1500);
});
onUnmounted(() => {
  removeDesktopActions?.();
  clearInterval(timer);
  clearTimeout(noticeTimer);
  clearTimeout(repeatNoticeTimer);
});
</script>

<template>
  <div class="app-shell workspace-theme">
    <a href="#main-content" class="skip-content">跳到当前页面内容</a>
    <aside class="sidebar">
      <div v-if="desktop" class="window-drag-area" aria-hidden="true"></div>
      <a
        href="#"
        class="brand"
        @click.prevent="page = 'workspace'"
        aria-label="拾音首页"
      >
        <span class="brand-mark" aria-hidden="true"><img :src="shiyinIcon" alt="" /></span>
        <span>拾音</span>
      </a>
      <nav aria-label="主导航">
        <button
          aria-label="音频提取"
          :class="{ active: page === 'workspace' }" :aria-current="page === 'workspace' ? 'page' : undefined"
          @click="page = 'workspace'"
        >
          <ArrowDownToLine :size="24" /><span>音频提取</span>
        </button>
        <button aria-label="视频提取" :class="{ active: page === 'video' }" :aria-current="page === 'video' ? 'page' : undefined" @click="page = 'video'">
          <SquarePlay :size="24" /><span>视频提取</span>
        </button>
        <button
          aria-label="任务"
          :class="{ active: page === 'tasks' }" :aria-current="page === 'tasks' ? 'page' : undefined"
          @click="showTasks()"
        >
          <Layers :size="24" /><span>任务</span
          ><span v-if="activeJobs.length" class="count">{{
            activeJobs.length
          }}</span>
        </button>
        <button
          aria-label="歌单"
          :class="{ active: page === 'files' }" :aria-current="page === 'files' ? 'page' : undefined"
          @click="page = 'files'"
        >
          <ListMusic :size="24" /><span>歌单</span>
        </button>
        <button aria-label="设置" :class="{ active: page === 'settings' }" :aria-current="page === 'settings' ? 'page' : undefined" @click="openSettings()">
          <Settings :size="24" /><span>设置</span>
        </button>
      </nav>
    </aside>
    <div class="app-main">
      <main id="main-content" tabindex="-1">
        <VideoWorkspace :active="page === 'video'" :request="api" :tasks="videos" :busy-task="videoBusy" :load-error="videoLoadError"
          @notice="toast" @audio="openVideoAudio" @updated="updateVideoTask" @action="videoAction" @tasks="showTasks('video')" @recovery="showTasks('video', true)" />
        <template v-if="page === 'workspace'">
          <div class="page-heading">
            <h1>音频提取</h1>
          </div>
          <div
            class="workspace-grid"
            :class="{ 'batch-workspace': mode === 'discovery' || (mode === 'file' && localBatchMode) }"
          >
            <section class="input-section" :aria-labelledby="mode === 'discovery' ? 'qishui-discovery-title' : 'input-title'">
              <div v-if="mode !== 'discovery'" class="section-heading">
                <h2 id="input-title">{{ mode === "file" ? "添加本地文件" : "添加音频" }}</h2>
              </div>
              <div class="tabs audio-entry-tabs" role="tablist" aria-label="添加方式">
                <button
                  role="tab"
                  :aria-selected="mode === 'link'"
                  :class="{ selected: mode === 'link' }"
                  @click="mode = 'link'"
                >
                  <Link2 :size="23" />分享链接</button
                ><button
                  role="tab"
                  :aria-selected="mode === 'file'"
                  :class="{ selected: mode === 'file' }"
                  @click="mode = 'file'"
                >
                  <FolderOpen :size="23" />本地文件</button
                </button>
                <button type="button" role="tab" :aria-selected="mode === 'discovery'" :class="{ selected: mode === 'discovery' }" @click="mode !== 'discovery' && openDiscovery()">
                  <SourceIcon platform="qishui" />汽水音乐
                </button>
              </div>
              <QishuiDiscovery v-if="mode === 'discovery'" :initial-playlist="pendingPlaylistInput" :local-playing="!playerPaused" @song="selectDiscoveredSong" @batch="showDiscoveryBatch" @playback="pauseForPreview" @settings="openSettings('accounts')" />
              <div v-else-if="mode === 'link'" class="link-entry">
                <div class="share-field">
                  <Link2 :size="23" aria-hidden="true" />
                  <label for="share-link" class="sr-only">歌曲或视频分享链接</label>
                  <textarea
                    id="share-link"
                    ref="shareLinkField"
                    v-model="input"
                    rows="1"
                    placeholder="粘贴汽水音乐、抖音或 B 站分享链接"
                    :disabled="busy"
                    @keydown.meta.enter.prevent="resolve"
                    @keydown.ctrl.enter.prevent="resolve"
                  ></textarea>
                  <button class="icon-button" aria-label="从剪贴板粘贴" title="从剪贴板粘贴" :disabled="busy" @click="paste">
                    <Clipboard :size="22" />
                  </button>
                </div>
                <div class="resolve-row">
                  <p>支持汽水音乐、抖音和 B 站</p>
                  <button class="primary resolve-button" :disabled="busy || !input.trim()" @click="resolve">
                    <LoaderCircle v-if="busy" class="spin" :size="17" />
                    {{ busy ? "正在获取资源…" : "解析链接" }}
                  </button>
                </div>
              </div>
              <LocalBatchPanel v-else-if="mode === 'file' && localBatchMode" ref="localPanel" :jobs="jobs" @refresh="refresh" @single="localBatchMode = false" />
              <div v-else class="upload-entry" @dragover.prevent @drop="drop">
                <input
                  ref="fileInput"
                  class="sr-only"
                  type="file"
                  multiple
                  accept="video/*,audio/*,.mkv,.flac,.m4a"
                  @change="
                    uploadFiles(Array.from(($event.target as HTMLInputElement).files || []))
                  "
                />
                <div class="upload-icon">
                  <Upload :size="26" :stroke-width="1.5" />
                </div>
                <h3>
                  {{ uploading ? "正在读取音轨…" : "将音频或视频拖到这里" }}
                </h3>
                <p>MP4、MOV、MP3、M4A 等 · 单个最大 500 MB · 支持多选</p>
                <button
                  class="secondary"
                  :disabled="uploading"
                  @click="fileInput?.click()"
                >
                  <LoaderCircle v-if="uploading" :size="16" class="spin" /><Plus
                    v-else
                    :size="16"
                  />选择本地文件
                </button>
                <button class="text-button" @click="localBatchMode = true">批量处理文件</button>
              </div>
              <div v-if="error" class="error-message" role="alert">
                <AlertCircle :size="18" />
                <div>
                  <strong>这次没有完成</strong>
                  <p>{{ error }}</p>
                  <button
                    v-if="error.includes('登录') || error.includes('验证')"
                    class="text-button"
                    @click="openSettings('accounts')"
                  >
                    前往连接账号<ChevronRight :size="14" />
                  </button>
                  <button
                    v-if="error.includes('这是汽水歌单')"
                    class="text-button"
                    @click="openDiscovery(input)"
                  >
                    打开歌单<ChevronRight :size="14" />
                  </button>
                </div>
              </div>
            </section>
            <section
              v-if="mode !== 'discovery' && !(mode === 'file' && localBatchMode)"
              class="result-section"
              aria-labelledby="result-title"
            >
              <div class="section-heading">
                <h2 id="result-title">解析结果</h2>
              </div>
              <template v-if="resource">
                <div class="resource-summary">
                  <AudioCover :src="resource.cover" />
                  <div class="resource-identity">
                    <h3 :title="resource.title">{{ resource.title }}</h3>
                    <p v-if="resource.artist" :title="resource.artist">{{ resource.artist }}</p>
                    <span class="resource-duration">
                      {{ time(resource.duration) }}<template v-if="resource.completeness === 'preview' && resource.expectedDuration"> / 全曲 {{ time(resource.expectedDuration) }}</template>
                    </span>
                  </div>
                  <div class="resource-actions">
                    <span class="completeness-chip" :class="resource.completeness">
                      <AudioLines :size="15" aria-hidden="true" />{{ resource.audioSource === 'douyin' ? '抖音原声' : resource.videoAudioMode ? '视频音轨' : resource.completeness === 'preview' ? '平台试听' : resource.completeness === 'full' ? '完整音频' : '完整性未知' }}
                    </span>
                    <label class="result-format">
                      <span class="sr-only">保存格式</span>
                      <select v-model="format" :disabled="busy">
                        <option value="original">原音轨</option>
                        <option value="mp3">MP3</option>
                        <option value="m4a">M4A</option>
                      </select>
                    </label>
                    <button class="primary save-button" :disabled="busy || !audioDestinationReady" @click="createJob">
                      <ArrowDownToLine :size="17" aria-hidden="true" />{{ recoveryJobId ? '确认并继续' : resource.audioSource === 'douyin' ? '保存原声' : resource.completeness === 'preview' ? '保存试听片段' : '提取并保存' }}
                    </button>
                  </div>
                </div>
                <p v-if="resource.videoAudioMode === 'combined'" class="format-note">{{ resource.note }}</p>
                <div class="resource-secondary">
                  <ExtractionDestination
                    :key="resource.token + recoveryJobId"
                    v-model:ready="audioDestinationReady"
                    kind="audio" read-only :original="recoveryJobId ? (recoveryDestination || '沿用任务原目录') : undefined"
                    :request="api"
                  />
                  <button v-if="!recoveryJobId" type="button" class="text-button song-options-toggle"
                    :aria-expanded="songOptionsOpen" aria-controls="extraction-song-options" @click="songOptionsOpen = !songOptionsOpen">
                    <Tags :size="15" aria-hidden="true" />整理歌曲信息<ChevronDown :size="13" aria-hidden="true" />
                  </button>
                </div>
                <SongOptions v-if="!recoveryJobId" :key="resource.token"
                  :resource="resource" :choice="choice" :format="format" :revision="completeJobs.length"
                  :expanded="songOptionsOpen" @metadata="songMetadata = $event" @force="forceCopy = $event"
                />
              </template>
              <div v-else class="result-empty">
                <div class="record-symbol" aria-hidden="true">
                  <span></span>
                </div>
                <h3>{{ mode === 'file' ? (uploading ? '正在读取本地文件…' : '等待添加本地文件') : '等待添加一段声音' }}</h3>
                <p v-if="mode === 'file' && !uploading">选择或拖入文件后，即可查看音轨。</p>
                <p v-else-if="mode === 'link'">解析链接后，即可提取音频。</p>
                <div v-if="mode === 'link'" class="supported">
                  <span><SourceIcon platform="qishui" />汽水音乐</span>
                  <span><SourceIcon platform="douyin" />抖音原声</span>
                  <span><SourceIcon platform="bilibili" />B 站</span>
                </div>
              </div>
            </section>
          </div>
        </template>
        <TasksWorkspace
          v-if="page === 'tasks'"
          :jobs="jobs"
          :videos="videos" :video-busy="videoBusy" :video-load-error="videoLoadError" :initial-type="initialTaskType"
          :initial-discovery-batch="initialDiscoveryBatch"
          :queue="queueState" :video-queue="videoQueueState" :video-queue-busy="videoQueueBusy"
          :queue-busy="queueBusy"
          :recoverable="recoverableJobs.length"
          :bulk-busy="bulkRetryBusy"
          :bulk-message="bulkRetryMessage"
          :bulk-errors="bulkRetryErrors"
          :retrying="retryingJobs"
          :separating="separating"
          :native-picker="!!health?.nativePicker"
          :playing="playerPaused ? '' : playing"
          :clear="clearTaskRecords"
          @pause="setQueuePaused"
          @pause-video="setVideoQueuePaused"
          @retry-all="retryFailedJobs"
          @action="taskAction"
          @video-action="videoAction"
          @recovery="recoveryOpen = true"
          @refresh="refresh"
          @create="page = 'workspace'"
          @review-song="selectDiscoveredSong"
          @discovery-complete="finishDiscoveryBatch"
        >
          <template #recovery><TaskRecovery v-model:expanded="recoveryOpen" :request="api" @changed="refresh(); refreshVideos()" @review="reviewRecoverySource" /></template>
        </TasksWorkspace>
        <KeepAlive>
          <LibraryWorkspace
            v-if="page === 'files'"
            :jobs="jobs"
            :groups="allGroups"
            :updating="libraryUpdating"
            :separating="separating"
            :playing="playing"
            :paused="playerPaused"
            :native-picker="!!health?.nativePicker"
            :request="api"
            :edit-playlist="renameOrCreatePlaylist"
            :add-to-group="updateLibrary"
            @action="libraryAction"
            @play="playLibrary"
            @group="groupJobIds = $event"
            @create-audio="page = 'workspace'"
            @refresh="refresh"
            @notice="toast"
          />
        </KeepAlive>
        <section v-if="page === 'workspace'" class="jobs-section" aria-labelledby="jobs-title">
          <div class="section-heading">
            <div class="title-with-count"><h2 id="jobs-title">最近提取</h2><span>共 {{ jobs.length }} 项</span></div>
            <button v-if="jobs.length" class="text-button" @click="showTasks('audio')">查看全部<ArrowRight :size="20" /></button>
          </div>
          <div v-if="!jobs.length" class="jobs-empty">
            <span class="empty-icon"><FileAudio :size="23" :stroke-width="1.5" /></span>
            <div><h3>还没有提取任务</h3><p>添加一个分享链接或本地文件，开始第一次提取。</p></div>
          </div>
          <div v-if="jobs.length" class="recent-columns" aria-hidden="true"><span>歌曲</span><span>来源</span><span>格式</span><span>状态</span><span>操作</span></div>
          <div v-for="job in jobs.slice(0, 5)" :key="job.id" class="job-row" :class="{ 'missing-file': job.status === 'completed' && job.fileExists === false }">
            <div class="job-info">
              <AudioCover class="recent-cover" :src="job.cover" />
              <div class="job-title"><h3>{{ job.title }}</h3><span v-if="job.completeness === 'preview'" class="preview-badge">试听</span></div>
              <p class="recent-artist">{{ job.artist || (job.fileExists === false ? "文件已移走或删除" : "") }}</p>
              <p v-if="job.clip" class="format-note">截取片段 · {{ job.clip.start.toFixed(2) }}—{{ job.clip.end.toFixed(2) }} 秒 · 原文件保留</p>
              <p v-if="job.warning" class="format-note" role="status">{{ job.warning }}</p>
            </div>
            <div class="recent-source">
              <SourceIcon :platform="job.platform" />
              {{ job.platform === 'douyin' ? '抖音' : platformName(job.platform) }}
            </div>
            <div class="recent-format">{{ fileFormat(job).toUpperCase() || '—' }}</div>
            <div :class="['job-state', job.status]">
              <div class="job-state-label">
                <template>
                  <Check v-if="job.status === 'completed' && job.fileExists !== false" class="status-check" :size="22" />
                  <LoaderCircle v-else-if="['downloading', 'processing', 'checking'].includes(job.status)" class="spin" :size="22" />
                </template>
                {{ job.status === 'completed' && job.fileExists === false ? '文件缺失' : job.status === 'processing' && ['vocals', 'instrumental'].includes(job.kind || '') ? '正在分离' : job.status === 'processing' ? '处理中' : statusName(job.status) }}
                <span v-if="!['completed', 'failed', 'cancelled'].includes(job.status) && !['vocals', 'instrumental'].includes(job.kind || '')">{{ job.progress }}%</span>
              </div>
              <div
                v-if="!['completed', 'failed', 'cancelled'].includes(job.status) && !['vocals', 'instrumental'].includes(job.kind || '')"
                class="progress-track"
                role="progressbar"
                :aria-valuenow="job.progress"
                aria-valuemin="0"
                aria-valuemax="100"
                aria-label="提取进度"
              ><span :style="{ width: job.progress + '%' }"></span></div>
              <p v-if="job.status === 'failed'" class="recent-failure">{{ job.message }}</p>
            </div>
            <div v-if="job.status === 'completed' && job.fileExists !== false" class="recent-actions">
              <button class="recent-play" :aria-label="playing === job.id && !playerPaused ? '暂停播放' : '播放音频'" @click="playSingle(job)">
                <Pause v-if="playing === job.id && !playerPaused" :size="17" /><Play v-else :size="18" />
                {{ playing === job.id && !playerPaused ? '暂停播放' : job.completeness === 'preview' ? '试听片段' : '播放音频' }}
              </button>
              <button class="icon-button" aria-label="在文件夹中显示" title="在文件夹中显示" @click="revealJob(job)"><FolderOpen :size="24" /></button>
              <details class="recent-menu">
                <summary aria-label="更多音频操作" title="更多音频操作"><Ellipsis :size="24" /></summary>
                <div class="recent-menu-content" @click="($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')">
                  <button @click="enqueueAudio(job)"><ListPlus :size="16" />加入播放队列</button>
                  <a :href="'/api/jobs/' + job.id + '/file'"><Download :size="16" />下载音频文件</a>
                  <button @click="editClip(job)"><Scissors :size="16" />截取音频片段</button>
                  <button @click="editClip(job, 'organize')"><Tags :size="16" />整理歌曲信息</button>
                  <button :disabled="separating.has(job.id)" @click="separateJob(job)"><AudioLines :size="16" />分离人声和伴奏</button>
                  <button @click="removeAudio(job)"><X :size="16" />移除记录</button>
                </div>
              </details>
            </div>
            <div v-else-if="!['completed', 'failed', 'cancelled'].includes(job.status)" class="recent-actions">
              <button class="recent-play" disabled><Play :size="18" />播放音频</button>
              <button class="icon-button" aria-label="在文件夹中显示" disabled><FolderOpen :size="24" /></button>
              <details class="recent-menu">
                <summary aria-label="更多任务操作" title="更多任务操作"><Ellipsis :size="24" /></summary>
                <div class="recent-menu-content">
                  <button @click="cancel(job.id)"><X :size="16" />取消任务</button>
                </div>
              </details>
            </div>
            <div v-else class="job-actions">
              <button v-if="job.status === 'completed'" class="text-button" @click="openJobFolder(job)">打开原目录</button>
              <button v-else class="text-button" :disabled="retryingJobs.has(job.id)" @click="retry(job)">重新提取</button>
            </div>
            <FileLocation v-if="job.status === 'completed' && job.fileExists === false" :job="job" :native-picker="!!health?.nativePicker" @changed="refresh" />
          </div>
        </section>
        <SettingsWorkspace
          v-if="page === 'settings'"
          v-model:section="settingsSection"
          :desktop="!!desktop"
          :default-format="defaultFormat"
          :request="api"
          @format="changeDefaultFormat"
          @directory="settings.outputDir = $event"
          @restored="refresh(); refreshVideos(); refreshPlaylists()"
        >
          <template #accounts>
          <section class="settings-card settings-account-card">
            <div v-if="settingsError" class="error-message" role="alert">
              <AlertCircle :size="18" />
              <p>{{ settingsError }}</p>
            </div>
            <div
              v-for="platform in ['qishui', 'douyin', 'bilibili'] as const"
              :key="platform"
              :id="'account-' + platform"
              class="account-block"
            >
              <div class="account-title">
                <SourceIcon :platform="platform" />
                <div>
                  <h3>{{ platform === "qishui" ? "汽水音乐" : platform === "bilibili" ? "B 站" : "抖音" }}</h3>
                  <p v-if="account(platform).status === 'connected' && account(platform).nickname">{{ account(platform).nickname }}</p>
                </div>
                <span
                  :class="['account-badge', account(platform).status]"
                  role="status"
                  >{{ accountLabel(platform) }}</span
                >
              </div>
              <p v-if="account(platform).status !== 'not_connected'" class="account-message">{{ account(platform).message }}</p>
              <p v-if="platform === 'douyin' && health?.browserReady === false" class="account-detail">请安装 Google Chrome 或 Microsoft Edge，再打开拾音。</p>
              <p
                v-if="
                  account(platform).status === 'connected' &&
                  platform === 'qishui'
                "
                class="account-detail"
              >
                {{
                  account(platform).vip === true
                    ? "平台确认：会员账号"
                    : account(platform).vip === false
                      ? "平台确认：非会员账号"
                      : "平台未明确返回会员状态"
                }}
                · 完整歌曲与音质按每首资源实际返回判断
              </p>
              <p v-if="account(platform).checkedAt" class="account-detail">
                最近检查：{{
                  new Date(account(platform).checkedAt!).toLocaleString("zh-CN")
                }}
              </p>
              <div class="account-actions">
                <BilibiliLogin v-if="platform === 'bilibili'" :request="api" :disabled="settingsBusy || !!checkingAccount" @connected="loadSettings().catch(error => toast(error.message))" :key="account(platform).hasCredentials ? 'connected' : 'disconnected'" />
                <button v-if="platform === 'qishui'" class="primary" :disabled="qrBusy || settingsBusy || !!checkingAccount" @click="createQishuiQr">
                  <LoaderCircle v-if="qrBusy" :size="16" class="spin" /><Link2 v-else :size="16" />{{ qrBusy ? "正在获取二维码…" : "扫码登录汽水" }}
                </button>
                <button v-if="platform === 'douyin'" class="secondary" :disabled="settingsBusy || !!checkingAccount" @click="connectDouyin">
                  <ExternalLink :size="16" />打开抖音登录窗口
                </button>
                <button class="secondary" :disabled="settingsBusy || !!checkingAccount" @click="checkAccount(platform)">
                  <LoaderCircle v-if="checkingAccount === platform" :size="16" class="spin" /><ShieldCheck v-else :size="16" />{{ checkingAccount === platform ? "正在检查…" : "检查登录状态" }}
                </button>
                <button
                  v-if="
                    account(platform).hasCredentials ||
                    account(platform).loginWindowOpen
                  "
                  class="text-button"
                  :disabled="settingsBusy || !!checkingAccount"
                  @click="clearAccount(platform)"
                >
                  断开连接
                </button>
              </div>
              <div
                v-if="platform === 'qishui' && qishuiQr"
                class="qr-login-panel"
                aria-live="polite"
              >
                <div class="qr-image-wrap">
                  <img
                    :src="qishuiQr.image"
                    alt="汽水账号登录二维码，请使用手机抖音 App 扫描"
                    width="190"
                    height="190"
                    :class="{ expired: qishuiQr.phase === 'expired' }"
                  />
                </div>
                <div class="qr-instructions">
                  <h4>
                    {{
                      qishuiQr.phase === "confirmed"
                        ? "扫码确认完成"
                        : qishuiQr.phase === "cooldown"
                          ? "平台正在确认登录"
                          : qishuiQr.phase === "verification"
                            ? "连接暂未完成"
                            : qishuiQr.phase === "expired"
                              ? "二维码已过期"
                              : qishuiQr.phase === "scanned"
                                ? "扫码已收到"
                                : "使用手机抖音 App 扫码"
                    }}
                  </h4>
                  <p>{{ qishuiQr.message }}</p>
                  <button v-if="qishuiQr.verificationRequired" class="primary" :disabled="verificationBusy" @click="openQishuiVerification">
                    <ShieldCheck :size="16" />{{ verificationBusy ? "正在打开验证…" : "继续完成账号验证" }}
                  </button>
                  <span class="account-detail"
                    >有效至
                    {{
                      new Date(qishuiQr.expiresAt).toLocaleTimeString("zh-CN")
                    }}</span
                  >
                  <div class="account-actions">
                    <button
                      class="text-button"
                      :disabled="qrBusy"
                      @click="createQishuiQr"
                    >
                      刷新二维码</button
                    ><button class="text-button" @click="cancelQishuiQr">
                      关闭扫码
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div v-if="input.trim()" class="account-return">
              <button
                class="text-button"
                :disabled="settingsBusy || !!checkingAccount || busy"
                @click="resolveAgain"
              >
                重新解析刚才的链接<ArrowUpRight :size="14" />
              </button>
            </div>
          </section>
          </template>
        </SettingsWorkspace>
      </main>
    </div>
    <div class="bottom-player" aria-label="音频播放器">
      <div class="player-track">
        <AudioCover :src="playerJob?.cover" />
        <div class="player-track-info"><strong>{{ playerJob?.title || '选择音频播放' }}</strong><p v-if="playerJob?.artist">{{ playerJob.artist }}</p></div>
        <button v-if="playerJob" class="player-favorite" :aria-label="playerJob.favorite ? '取消收藏' : '收藏音频'" :aria-pressed="!!playerJob.favorite" :disabled="libraryUpdating" @click="toggleFavorite(playerJob)">
          <Heart :size="22" :fill="playerJob.favorite ? 'currentColor' : 'none'" />
        </button>
      </div>
      <div class="player-controls">
        <button aria-label="上一首" :disabled="!playableJobs.length" @click="playerMove(-1)"><SkipBack :size="20" /></button>
        <button class="player-toggle" :aria-label="playerPaused ? '播放' : '暂停'" :disabled="!playableJobs.length" @click="togglePlayer"><Play v-if="playerPaused" :size="21" /><Pause v-else :size="21" /></button>
        <button aria-label="下一首" :disabled="!playableJobs.length" @click="playerMove(1)"><SkipForward :size="20" /></button>
      </div>
      <div class="player-progress"><span>{{ playerPosition ? time(playerPosition) : '00:00' }} / {{ playerDuration ? time(playerDuration) : '00:00' }}</span><input type="range" aria-label="播放进度" min="0" :max="playerDuration || 0" step="0.1" :value="playerPosition" :style="{ '--range-fill': (playerDuration ? playerPosition / playerDuration * 100 : 0) + '%' }" :disabled="!playerDuration" @input="seekPlayer" /></div>
      <div class="player-volume">
        <button class="icon-button" :aria-label="playerMuted || playerVolume === 0 ? '恢复声音' : '静音'" @click="toggleMute">
          <VolumeX v-if="playerMuted || playerVolume === 0" :size="21" /><Volume2 v-else :size="21" />
        </button>
        <input type="range" aria-label="音量" min="0" max="1" step="0.01" :value="playerVolume" :style="{ '--range-fill': (playerMuted ? 0 : playerVolume * 100) + '%' }" @input="changePlayerVolume" />
      </div>
      <div class="player-tools">
        <div class="player-repeat-control">
          <button type="button" class="player-repeat" :class="{ enabled: repeatMode !== 'off' }"
            :aria-label="'播放模式：' + repeatLabel" :title="repeatLabel" @click="cycleRepeat">
            <Repeat1 v-if="repeatMode === 'one'" :size="21" aria-hidden="true" /><Repeat v-else :size="21" aria-hidden="true" />
          </button>
          <span class="player-repeat-notice" role="status">{{ repeatNotice }}</span>
        </div>
        <button class="player-queue-toggle" aria-label="播放队列" :aria-expanded="playbackList" popovertarget="playback-list"><ListMusic :size="24" /></button>
      </div>
      <section id="playback-list" ref="queuePopover" popover class="player-queue" aria-label="播放队列" @toggle="syncPlaybackList">
        <div class="section-heading"><h2>播放队列</h2><button aria-label="关闭播放队列" @click="closePlaybackList"><X :size="18" /></button></div>
        <div class="player-queue-volume">
          <button class="icon-button" :aria-label="playerMuted || playerVolume === 0 ? '恢复声音' : '静音'" @click="toggleMute">
            <VolumeX v-if="playerMuted || playerVolume === 0" :size="21" /><Volume2 v-else :size="21" />
          </button>
          <input type="range" aria-label="音量" min="0" max="1" step="0.01" :value="playerVolume" :style="{ '--range-fill': (playerMuted ? 0 : playerVolume * 100) + '%' }" @input="changePlayerVolume" />
        </div>
        <p v-if="!playableJobs.length" class="player-queue-empty">队列为空。从歌曲菜单加入播放队列。</p>
        <div v-for="job in playableJobs" :key="job.id" class="player-queue-row" :class="{ current: playing === job.id }">
          <button class="queue-track" :aria-current="playing === job.id ? 'true' : undefined" @click="playing === job.id ? togglePlayer() : playing = job.id">
            <Music2 :size="16" /> <span class="queue-track-title" :title="job.title">{{ job.title }}</span><span v-if="job.completeness === 'preview'" class="queue-track-badge">试听</span>
          </button>
          <button class="queue-remove" :aria-label="'从播放队列移除 ' + job.title" title="从播放队列移除" @click="removeFromQueue(job)"><X :size="16" /></button>
        </div>
      </section>
      <audio v-if="playing" :key="playing" ref="playerAudio" :src="`/api/jobs/${playing}/audio`" autoplay :loop="repeatMode === 'one'" @play="playerPaused = false" @pause="playerPaused = true" @timeupdate="playerPosition = ($event.target as HTMLAudioElement).currentTime" @loadedmetadata="playerMetadata" @ended="finishPlayerTrack" @error="playerPaused = true; toast('无法播放该音频，请检查文件是否存在。')" />
    </div>
    <div v-if="notice" class="toast" role="status">
      <Info :size="17" aria-hidden="true" /><span>{{ notice }}</span
      ><button aria-label="关闭提示" @click="notice = ''">
        <X :size="15" />
      </button>
    </div>
    <SavedVideoDialog v-if="playingVideo" :task="playingVideo" @close="playingVideo = null" />
    <LibraryGroupDialog v-if="groupJobIds" :ids="groupJobIds" :groups="allGroups" :assigned="assignedGroups" :update="updateLibrary" @close="groupJobIds = null" @changed="groupChanged" />
    <AudioEditor
      v-if="editingJob"
      :key="editingJob.id + editorMode"
      :job="editingJob"
      :mode="editorMode"
      @close="editingJob = null"
      @saved="clipSaved"
    />
  </div>
</template>
