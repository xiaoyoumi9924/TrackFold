<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { AlertCircle, AudioLines, Check, ChevronDown, Clock3, Download, Ellipsis, FileAudio, FolderOpen, Layers, ListPlus, LoaderCircle, Pause, Play, Plus, RotateCw, Scissors, Search, Square, Tags, Trash2, X } from "@lucide/vue";
import type { AudioQueueState, Job, Resource, VideoTask, VideoTaskAction } from "../../shared/types";
import { fileFormat } from "../../shared/library-filters";
import { retryReason } from "../../shared/retry-policy";
import SourceIcon from "./SourceIcon.vue";
import AudioCover from "./AudioCover.vue";
import VideoCover from "./VideoCover.vue";
import FileLocation from "./FileLocation.vue";
import QishuiBatch from "./QishuiBatch.vue";
import "./tasks-workspace.css";

type TaskFilter = "all" | "active" | "completed" | "failed";
type TaskAction = "play" | "folder" | "reveal" | "clip" | "organize" | "separate" | "cancel" | "retry" | "remove-record" | "enqueue";
type TaskType = "all" | "audio" | "video";
type TaskRow = { kind: "audio"; task: Job } | { kind: "video"; task: VideoTask };

const props = defineProps<{
  jobs: Job[];
  videos: VideoTask[];
  videoBusy: string;
  videoLoadError: string;
  initialType: TaskType;
  initialDiscoveryBatch: string;
  queue: AudioQueueState | null;
  queueBusy: boolean;
  videoQueue: AudioQueueState | null;
  videoQueueBusy: boolean;
  recoverable: number;
  bulkBusy: boolean;
  bulkMessage: string;
  bulkErrors: { id: string; title: string; message: string }[];
  retrying: ReadonlySet<string>;
  separating: ReadonlySet<string>;
  nativePicker: boolean;
  playing: string;
  clear: (ids: string[]) => Promise<void>;
}>();
const emit = defineEmits<{
  pause: [paused: boolean];
  pauseVideo: [paused: boolean];
  retryAll: [];
  action: [action: TaskAction, job: Job];
  videoAction: [action: VideoTaskAction, task: VideoTask];
  recovery: [];
  refresh: [];
  create: [];
  reviewSong: [id: string, resource: Resource, batchId: string, itemId: string];
  discoveryComplete: [id: string];
}>();

const filters = [
  { id: "all", label: "所有状态", icon: Layers },
  { id: "active", label: "处理中", icon: LoaderCircle },
  { id: "completed", label: "已完成", icon: Check },
  { id: "failed", label: "失败", icon: X },
] as const;

const types: { id: TaskType; label: string }[] = [
  { id: "all", label: "全部任务" },
  { id: "audio", label: "音频" },
  { id: "video", label: "视频" },
];
const type = ref<TaskType>(props.initialType);
watch(() => props.initialType, value => { type.value = value; });
const filter = ref<TaskFilter>("all");
const query = ref("");
const toolsOpen = ref(false);
const discoveryOpen = ref(false);
const discoveryIssues = ref(0);
watch(() => props.initialDiscoveryBatch, () => {
  discoveryOpen.value = false;
  discoveryIssues.value = 0;
});
const list = ref<HTMLElement>();
const clearDialog = ref<HTMLDialogElement>();
const clearIds = ref<string[]>([]);
const clearTitle = ref("");
const clearBusy = ref(false);
const clearError = ref("");
const menu = ref<HTMLElement>();
const menuKey = ref("");
const rows = computed<TaskRow[]>(() => [
  ...props.jobs.map(task => ({ kind: "audio" as const, task })),
  ...props.videos.map(task => ({ kind: "video" as const, task })),
].sort((a, b) => (b.task.createdAt || "").localeCompare(a.task.createdAt || "")));
const keyOf = (row: TaskRow) => `${row.kind}:${row.task.id}`;
const menuRow = computed(() => rows.value.find(row => keyOf(row) === menuKey.value));
const menuJob = computed(() => menuRow.value?.kind === "audio" ? menuRow.value.task : undefined);
const menuVideo = computed(() => menuRow.value?.kind === "video" ? menuRow.value.task : undefined);

function canClear(task: Job | VideoTask) { return task.status === "failed" || task.status === "cancelled"; }
function isActive(task: Job | VideoTask) { return task.status !== "completed" && !canClear(task); }
const scope = computed(() => rows.value.filter(row => type.value === "all" || row.kind === type.value));
const groups = computed(() => ({
  all: scope.value,
  active: scope.value.filter(({ task }) => isActive(task)),
  completed: scope.value.filter(({ task }) => task.status === "completed"),
  failed: scope.value.filter(({ task }) => task.status === "failed" && !task.interrupted),
}));
const clearable = computed(() => props.jobs.filter(job => canClear(job) && !job.interrupted));
const term = computed(() => query.value.trim().toLowerCase());
const visibleRows = computed(() => groups.value[filter.value].filter(row => !term.value ||
  `${row.task.title || "视频任务"} ${row.task.artist || ""}`.toLowerCase().includes(term.value)));
const audioFailures = computed(() => props.jobs.filter(job => job.status === "failed" && !job.interrupted).length);
const platforms = { local: "本地文件", douyin: "抖音", qishui: "汽水音乐", bilibili: "B 站" };
const statusLabels = { queued: "等待中", downloading: "处理中", processing: "处理中", working: "处理中", checking: "核对文件", completed: "已完成", failed: "失败", cancelled: "已取消" };

function statusText(row: TaskRow) {
  const { task } = row;
  if (task.status === "completed" && task.fileExists === false) return "文件缺失";
  if (task.status === "failed" && task.interrupted) return "待恢复";
  if (row.kind === "audio" && row.task.status === "processing" && (row.task.kind === "vocals" || row.task.kind === "instrumental")) return "正在分离";
  if (row.kind === "video" && task.status === "working" && task.message) return task.message.replace(/[…。]+$/, "");
  return statusLabels[task.status];
}
function showProgress(row: TaskRow) {
  if (row.kind === "video") return row.task.status === "working" && row.task.progress !== undefined;
  const job = row.task;
  return isActive(job) && job.status !== "queued" && job.kind !== "vocals" && job.kind !== "instrumental";
}
watch([type, filter, term], () => {
  if (list.value) list.value.scrollTop = 0;
  closeMenu();
});

function confirmClear(jobs: Job[]) {
  closeMenu();
  clearIds.value = jobs.map(job => job.id);
  clearTitle.value = jobs.length === 1 ? jobs[0].title : "";
  clearError.value = "";
  clearDialog.value?.showModal();
}
async function clearRecords() {
  if (clearBusy.value) return;
  clearBusy.value = true;
  clearError.value = "";
  try {
    await props.clear(clearIds.value);
    clearDialog.value?.close();
  } catch (error) {
    clearError.value = (error as Error).message;
  } finally {
    clearBusy.value = false;
  }
}

function closeMenu() {
  if (menu.value?.matches(":popover-open")) menu.value.hidePopover();
}
async function openMenu(event: MouseEvent, row: TaskRow) {
  if (menuKey.value === keyOf(row) && menu.value?.matches(":popover-open")) { closeMenu(); return; }
  const anchor = event.currentTarget as HTMLElement;
  const rect = anchor.getBoundingClientRect();
  closeMenu();
  menuKey.value = keyOf(row);
  await nextTick();
  if (!menu.value || !anchor.isConnected) return;
  const popover = menu.value as HTMLElement & { showPopover(options: { source: HTMLElement }): void };
  popover.showPopover({ source: anchor });
  const { width, height } = menu.value.getBoundingClientRect();
  const top = rect.bottom + height + 8 > window.innerHeight ? rect.top - height - 6 : rect.bottom + 6;
  menu.value.style.left = Math.max(8, rect.right - width) + "px";
  menu.value.style.top = Math.max(8, top) + "px";
}
function runAction(action: TaskAction, job: Job) {
  closeMenu();
  emit("action", action, job);
}
function videoAction(action: VideoTaskAction, task: VideoTask) {
  closeMenu();
  emit("videoAction", action, task);
}
</script>

<template>
  <div class="tasks-workspace">
    <div class="page-heading">
      <h1>任务</h1>
    </div>

    <div class="task-type-toolbar">
      <div class="task-types" role="group" aria-label="按文件类型筛选任务">
        <button v-for="item in types" :key="item.id" type="button" :aria-pressed="type === item.id" @click="type = item.id">{{ item.label }}</button>
      </div>
      <label class="task-search"><Search :size="16" aria-hidden="true" /><input v-model="query" aria-label="搜索任务" placeholder="搜索标题或作者" /><button v-if="query" class="icon-button" aria-label="清空搜索" @click="query = ''"><X :size="16" /></button></label>
    </div>

    <div class="tasks-toolbar">
      <div class="task-filters" role="group" aria-label="按状态筛选任务">
        <button v-for="item in filters" :key="item.id" type="button" :aria-pressed="filter === item.id" :class="item.id" @click="filter = item.id">
          <component :is="item.icon" :size="21" class="task-filter-icon" aria-hidden="true" />
          {{ item.label }} <span>{{ groups[item.id].length }}</span>
        </button>
      </div>
      <div class="task-queue">
        <div v-if="type !== 'video'" class="task-queue-meter">
          <span v-if="queue" role="status">
            音频队列 {{ queue.active }}/{{ queue.limit }}<template v-if="queue.paused"> · 已暂停</template>
            <template v-if="queue.waiting"> · {{ queue.waiting }} 项等待</template>
          </span>
          <span v-else>音频队列 —</span>
        </div>
        <div v-if="type !== 'audio'" class="task-queue-meter">
          <span v-if="videoQueue" role="status" :title="`${videoQueue.waiting} 项视频等待中`">
            视频队列 {{ videoQueue.active }}/{{ videoQueue.limit }}<template v-if="videoQueue.paused"> · 已暂停</template>
            <span class="sr-only">，{{ videoQueue.waiting }} 项视频等待中</span>
          </span>
          <span v-else>视频队列 —</span>
        </div>
        <button class="secondary" type="button" aria-controls="tasks-tools" :aria-expanded="toolsOpen" @click="toolsOpen = !toolsOpen">队列操作</button>
      </div>
    </div>

    <section v-if="toolsOpen" id="tasks-tools" class="tasks-tools" aria-label="队列操作">
      <div v-if="type !== 'video'" class="tasks-tools-row">
        <p v-if="queue">{{ queue.waiting }} 项音频等待中</p>
        <button v-if="queue?.paused" class="secondary" :disabled="queueBusy" aria-label="继续队列" @click="emit('pause', false)"><Play :size="16" fill="currentColor" />继续音频队列</button>
        <button v-else class="secondary" :disabled="!queue || queueBusy" aria-label="暂停后续任务" title="正在处理的任务会继续" @click="emit('pause', true)"><Pause :size="16" fill="currentColor" />暂停音频队列</button>
        <button class="secondary" :disabled="!clearable.length || clearBusy" title="只移除失败和已取消的音频任务记录" @click="confirmClear(clearable)"><Trash2 :size="16" />清理音频任务</button>
      </div>
      <div v-if="type !== 'audio'" class="tasks-tools-row">
        <p v-if="videoQueue">{{ videoQueue.waiting }} 项视频等待中</p>
        <button v-if="videoQueue" class="secondary" :disabled="videoQueueBusy" @click="emit('pauseVideo', !videoQueue.paused)">
          <Play v-if="videoQueue.paused" :size="16" fill="currentColor" /><Pause v-else :size="16" fill="currentColor" />
          {{ videoQueue.paused ? "继续视频队列" : "暂停视频队列" }}
        </button>
      </div>
      <div v-if="type !== 'video' && audioFailures" class="tasks-tools-row">
        <p>{{ audioFailures }} 项音频失败 · {{ recoverable }} 项可批量重试</p>
        <button class="secondary" :disabled="bulkBusy || !recoverable || !queue || queue.paused" @click="emit('retryAll')">
          <RotateCw :size="16" />{{ bulkBusy ? "正在重新发起…" : `重试网络异常（最多 ${Math.min(recoverable, 20)} 项）` }}
        </button>
        <p v-if="queue?.paused && recoverable">队列已暂停，请先继续队列。</p>
      </div>
    </section>
    <div v-if="bulkMessage" class="task-feedback" role="status">
      <p>{{ bulkMessage }}</p>
      <ul v-if="bulkErrors.length"><li v-for="item in bulkErrors" :key="item.id">{{ item.title }}：{{ item.message }}</li></ul>
    </div>

    <slot name="recovery" />
    <section v-if="initialDiscoveryBatch" v-show="type === 'audio'" class="tasks-tools task-discovery" aria-labelledby="task-discovery-toggle">
      <h2>
        <button id="task-discovery-toggle" type="button" aria-label="汽水批次" :aria-expanded="discoveryOpen" aria-controls="task-discovery-content" @click="discoveryOpen = !discoveryOpen">
          <span>汽水批次 <small v-if="discoveryIssues" class="task-discovery-issues" role="status">{{ discoveryIssues }} 首未保存</small></span><ChevronDown :size="17" aria-hidden="true" />
        </button>
      </h2>
      <div v-show="discoveryOpen" id="task-discovery-content">
        <QishuiBatch :key="initialDiscoveryBatch" :initial-id="initialDiscoveryBatch" :jobs="jobs"
          @song="(id, resource, batchId, itemId) => emit('reviewSong', id, resource, batchId, itemId)"
          @issues="discoveryIssues = $event"
          @complete="emit('discoveryComplete', $event)" />
      </div>
    </section>
    <p v-if="videoLoadError && type !== 'audio'" class="task-feedback" role="alert">{{ videoLoadError }}</p>
    <div class="task-results">
      <section ref="list" class="task-list" aria-label="提取任务" tabindex="0" @scroll="closeMenu">
        <div class="task-table-head" aria-hidden="true"><span>文件</span><span>来源</span><span>输出</span><span>状态</span><span>操作</span></div>
        <div v-if="!visibleRows.length" class="task-empty">
          <FileAudio :size="27" :stroke-width="1.5" aria-hidden="true" />
          <div>
            <h2>{{ rows.length ? "没有匹配的任务" : "还没有提取任务" }}</h2>
            <p>{{ rows.length ? "切换类型或状态，或清空搜索。" : "添加分享链接或本地文件，开始第一次提取。" }}</p>
          </div>
          <button v-if="!rows.length" class="secondary" @click="emit('create')"><Plus :size="17" />新建提取</button>
          <button v-else class="secondary" @click="type = 'all'; filter = 'all'; query = ''">查看全部</button>
        </div>
        <article v-for="row in visibleRows" :key="keyOf(row)" class="job-row task-row" :class="{ 'is-playing': row.kind === 'audio' && playing === row.task.id }">
          <div class="task-track">
            <button v-if="row.kind === 'audio' && row.task.status === 'completed' && row.task.fileExists !== false" class="task-track-play" :aria-label="playing === row.task.id ? `暂停播放 ${row.task.title}` : `播放音频 ${row.task.title}`" @click="runAction('play', row.task)">
              <span class="task-track-art">
                <AudioCover :src="row.task.cover" />
                <span class="task-track-play-icon" aria-hidden="true"><Pause v-if="playing === row.task.id" :size="16" fill="currentColor" /><Play v-else :size="17" fill="currentColor" /></span>
              </span>
              <span class="task-track-text">
                <span class="task-track-name">
                  <strong :title="row.task.title">{{ row.task.title || "音频任务" }}</strong>
                  <span v-if="row.task.completeness === 'preview'" class="preview-badge">{{ row.task.audioSource === 'douyin' ? '抖音原声' : '试听' }}</span>
                </span>
                <span v-if="row.task.artist" class="task-track-artist">{{ row.task.artist }}</span>
              </span>
            </button>
            <template v-else>
              <AudioCover v-if="row.kind === 'audio'" :src="row.task.cover" />
              <VideoCover v-else :src="row.task.cover" />
              <div class="task-track-text">
                <div class="task-track-name">
                  <h3 :title="row.task.title">{{ row.task.title || "视频任务" }}</h3>
                  <span v-if="row.kind === 'audio' && row.task.completeness === 'preview'" class="preview-badge">{{ row.task.audioSource === 'douyin' ? '抖音原声' : '试听' }}</span>
                </div>
                <p v-if="row.task.artist">{{ row.task.artist }}</p>
              </div>
            </template>
          </div>
          <div class="task-source">
            <SourceIcon v-if="row.task.platform" :platform="row.task.platform" />
            {{ row.task.platform ? platforms[row.task.platform] : "—" }}
          </div>
          <div class="task-format">
            {{ row.kind === "video" ? "视频 · MP4" : '音频 · ' + (fileFormat(row.task).toUpperCase() || (row.task.format === "original" ? "原音轨" : "—")) }}
          </div>
          <div class="task-state" :class="[row.task.status, { 'task-missing': row.task.fileExists === false }]">
            <div class="task-state-line">
              <Clock3 v-if="row.task.interrupted || row.task.status === 'queued' || row.task.status === 'cancelled'" :size="22" class="task-state-icon" aria-hidden="true" />
              <Check v-else-if="row.task.status === 'completed' && row.task.fileExists !== false" :size="22" class="task-state-icon task-check" aria-hidden="true" />
              <X v-else-if="row.task.status === 'failed'" :size="22" class="task-state-icon task-failure" aria-hidden="true" />
              <AlertCircle v-else-if="row.task.status === 'completed'" :size="22" class="task-state-icon" aria-hidden="true" />
              <LoaderCircle v-else :size="22" class="task-state-icon spin" aria-hidden="true" />
              <span>{{ statusText(row) }}</span>
              <span v-if="showProgress(row)" class="task-progress-value">{{ row.task.progress }}%</span>
            </div>
            <progress v-if="showProgress(row)" :value="row.task.progress" max="100" aria-label="提取进度"></progress>
            <p v-else-if="row.task.status === 'failed'" class="task-failure-message" :title="row.task.message">{{ row.task.message }}</p>
          </div>
          <div class="task-actions">
            <button v-if="row.task.interrupted && row.task.status === 'failed'" class="secondary" @click="emit('recovery')">查看恢复</button>
            <template v-else-if="row.kind === 'audio'">
              <template v-if="canClear(row.task)">
                <button class="secondary task-retry" :disabled="retrying.has(row.task.id)" @click="runAction('retry', row.task)"><RotateCw :size="18" />重试</button>
                <button class="secondary task-remove" :disabled="clearBusy" @click="confirmClear([row.task])"><Trash2 :size="18" />删除</button>
              </template>
              <button v-else-if="row.task.status === 'completed'" class="secondary task-folder" @click="runAction('folder', row.task)">
                <FolderOpen :size="21" />{{ row.task.fileExists === false ? "打开原目录" : "打开文件夹" }}
              </button>
              <button v-else class="secondary task-stop" aria-label="取消任务" title="取消任务" @click="runAction('cancel', row.task)"><Square :size="15" fill="currentColor" />停止</button>
            </template>
            <template v-else>
              <button v-if="row.task.status === 'failed'" class="secondary task-retry" :disabled="!!videoBusy" @click="videoAction('retry', row.task)"><RotateCw :size="18" />重试</button>
              <button v-else-if="row.task.status === 'completed' && row.task.fileExists === false && nativePicker" class="secondary" :disabled="!!videoBusy" @click="videoAction('relocate', row.task)">重新关联视频</button>
              <button v-else-if="row.task.status === 'completed' && row.task.fileExists !== false" class="secondary task-folder" :disabled="!!videoBusy" @click="videoAction('open-folder', row.task)"><FolderOpen :size="21" />打开文件夹</button>
              <button v-else-if="isActive(row.task)" class="secondary task-stop" aria-label="取消视频任务" :disabled="!!videoBusy" @click="videoAction('cancel', row.task)"><Square :size="15" fill="currentColor" />停止</button>
            </template>
            <button class="icon-button task-menu-button" :aria-label="row.kind === 'video' ? '更多视频操作' : '更多任务操作'" aria-controls="task-row-menu" @click="openMenu($event, row)"><Ellipsis :size="23" /></button>
          </div>
          <FileLocation v-if="row.kind === 'audio' && row.task.status === 'completed' && row.task.fileExists === false" :job="row.task" :native-picker="nativePicker" @changed="emit('refresh')" />
        </article>
      </section>
    </div>

    <div id="task-row-menu" ref="menu" popover class="task-row-menu" aria-label="任务操作">
      <template v-if="menuJob">
        <template v-if="menuJob.status === 'completed' && menuJob.fileExists !== false">
          <button @click="runAction('play', menuJob)"><Play :size="16" />{{ playing === menuJob.id ? "暂停播放" : "播放音频" }}</button>
          <button @click="runAction('enqueue', menuJob)"><ListPlus :size="16" />加入播放队列</button>
          <button @click="runAction('reveal', menuJob)"><FolderOpen :size="16" />在文件夹中显示</button>
          <a :href="`/api/jobs/${encodeURIComponent(menuJob.id)}/file`" @click="closeMenu"><Download :size="16" />下载音频文件</a>
          <button @click="runAction('clip', menuJob)"><Scissors :size="16" />截取音频片段</button>
          <button @click="runAction('organize', menuJob)"><Tags :size="16" />整理歌曲信息</button>
          <button :disabled="separating.has(menuJob.id)" @click="runAction('separate', menuJob)"><AudioLines :size="16" />分离人声和伴奏</button>
        </template>
        <button v-if="menuJob.status === 'completed'" @click="runAction('remove-record', menuJob)"><X :size="16" />移除记录</button>
        <p v-if="menuJob.status !== 'completed' && menuJob.message">{{ menuJob.message }}</p>
        <p v-if="menuJob.status === 'failed'">{{ retryReason(menuJob) }}</p>
        <p v-if="menuJob.warning">{{ menuJob.warning }}</p>
      </template>
      <template v-else-if="menuVideo">
        <button v-if="menuVideo.status === 'completed' && menuVideo.fileExists !== false" @click="videoAction('play', menuVideo)"><Play :size="16" />播放视频</button>
        <button v-if="canClear(menuVideo) || menuVideo.status === 'completed'" :disabled="!!videoBusy" @click="videoAction('remove', menuVideo)"><X :size="16" />移除记录</button>
        <button v-if="menuVideo.interrupted" :disabled="!!videoBusy" @click="videoAction('cancel', menuVideo)"><X :size="16" />取消恢复</button>
        <button v-if="isActive(menuVideo)" :disabled="!!videoBusy" @click="videoAction('cancel', menuVideo)"><Square :size="15" />取消视频任务</button>
        <p v-if="menuVideo.status !== 'completed'">{{ menuVideo.message }}</p>
      </template>
    </div>

    <dialog ref="clearDialog" class="task-clear-dialog" aria-labelledby="task-clear-title" @cancel.prevent="!clearBusy && clearDialog?.close()">
      <h2 id="task-clear-title">{{ clearTitle ? "删除任务记录" : "清理任务记录" }}</h2>
      <p v-if="clearTitle">{{ clearTitle }}</p>
      <p v-else>将移除 {{ clearIds.length }} 条失败或已取消的任务记录。</p>
      <p>已完成的记录和本地音频文件会保留。</p>
      <p v-if="clearError" role="alert" class="task-clear-error">{{ clearError }}</p>
      <div class="task-clear-actions">
        <button autofocus class="secondary" :disabled="clearBusy" @click="clearDialog?.close()">取消</button>
        <button class="primary" :disabled="clearBusy" @click="clearRecords">{{ clearBusy ? "正在清理…" : "移除记录" }}</button>
      </div>
    </dialog>
  </div>
</template>
