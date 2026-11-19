<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { AudioLines, Clipboard, Download, Ellipsis, Film, Folder, Link2, LoaderCircle, Pause, Play, RotateCw, Square, Video, X } from "@lucide/vue";
import type { AudioQueueState, Resource, VideoPreview, VideoTask, VideoTaskAction } from "../../shared/types";
import ExtractionDestination from "./ExtractionDestination.vue";
import VideoCover from "./VideoCover.vue";
import "./video-workspace.css";

const props = defineProps<{
  active: boolean;
  tasks: VideoTask[];
  busyTask: string;
  loadError: string;
  queue: AudioQueueState | null;
  queueBusy: boolean;
  request: (url: string, options?: RequestInit) => Promise<unknown>;
}>();
const emit = defineEmits<{
  notice: [message: string];
  updated: [task: VideoTask];
  action: [action: VideoTaskAction, task: VideoTask];
  audio: [resource: Resource, input: string];
  tasks: [];
  pauseQueue: [paused: boolean];
  recovery: [];
}>();

const input = ref("");
const shareField = ref<HTMLTextAreaElement>();
const result = ref<VideoPreview | null>(null);
const error = ref("");
const resolving = ref(false);
const submitting = ref(false);
const openingAudio = ref(false);
const submittedId = ref("");
const videoDestination = ref("");
const videoDestinationReady = ref(false);
const currentTask = computed(() => props.tasks.find(task => task.id === submittedId.value));
watch(() => result.value?.id, () => {
  videoDestination.value = "";
  videoDestinationReady.value = false;
}, { flush: "sync" });
watch(() => props.tasks, tasks => {
  if (submittedId.value && !tasks.some(task => task.id === submittedId.value)) submittedId.value = "";
});
const statusLabels = { queued: "等待处理", working: "处理中", completed: "已完成", failed: "失败", cancelled: "已取消" };
const platformLabels = { douyin: "抖音", bilibili: "B 站" };

function post(url: string, body: object = {}) {
  return props.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
function time(seconds: number) {
  const total = Math.floor(seconds);
  return [Math.floor(total / 60), total % 60].map(part => String(part).padStart(2, "0")).join(":");
}
watch(input, () => {
  result.value = null;
  submittedId.value = "";
  error.value = "";
});

async function paste() {
  try {
    const text = await navigator.clipboard.readText();
    if (text.trim()) input.value = text;
    else emit("notice", "剪贴板没有可粘贴的文字。");
  } catch {
    emit("notice", "请直接在输入框中粘贴分享链接。");
  }
  shareField.value?.focus();
}
async function resolve() {
  const source = input.value.trim();
  if (!source || resolving.value || submitting.value) return;
  resolving.value = true;
  result.value = null;
  submittedId.value = "";
  error.value = "";
  try {
    const preview = await post("/api/video/resolve", { input: source }) as VideoPreview;
    if (input.value.trim() === source) result.value = preview;
  } catch (cause) {
    if (input.value.trim() === source) error.value = (cause as Error).message;
  } finally {
    resolving.value = false;
  }
}
async function save() {
  if (!result.value || submitting.value || submittedId.value || !videoDestinationReady.value) return;
  submitting.value = true;
  error.value = "";
  try {
    const task = await post("/api/video", { previewId: result.value.id, outputDir: videoDestination.value || undefined }) as VideoTask;
    submittedId.value = task.id;
    emit("updated", task);
  } catch (cause) {
    error.value = (cause as Error).message;
    if (error.value.includes("已过期")) result.value = null;
  } finally {
    submitting.value = false;
  }
}
async function openAudio() {
  const preview = result.value;
  const source = input.value;
  if (!preview || openingAudio.value) return;
  openingAudio.value = true;
  error.value = "";
  try {
    const resource = await post("/api/video/resolve-audio", { previewId: preview.id }) as Resource;
    if (result.value?.id === preview.id) emit("audio", resource, source);
  } catch (cause) {
    if (result.value?.id === preview.id) error.value = (cause as Error).message;
  } finally { openingAudio.value = false; }
}
</script>

<template>
  <div v-show="active" class="video-workspace">
    <div class="page-heading">
      <h1>视频提取</h1>
    </div>

    <div class="video-board">
      <section class="video-entry" aria-labelledby="video-link-title">
        <div class="section-heading"><h2 id="video-link-title">添加视频链接</h2></div>
        <form @submit.prevent="resolve">
          <div class="share-field video-share-field">
            <Link2 :size="23" aria-hidden="true" />
            <label for="video-link" class="sr-only">分享链接或分享文案</label>
            <textarea
              id="video-link"
              ref="shareField"
              v-model="input"
              rows="1"
              maxlength="10000"
              placeholder="粘贴抖音或 B 站视频分享链接"
              :disabled="submitting"
              @keydown.meta.enter.prevent="resolve"
              @keydown.ctrl.enter.prevent="resolve"
            ></textarea>
            <button class="icon-button" type="button" aria-label="从剪贴板粘贴视频链接" title="从剪贴板粘贴" :disabled="submitting" @click="paste">
              <Clipboard :size="22" aria-hidden="true" />
            </button>
          </div>
          <div class="video-entry-action">
            <button class="primary video-primary" :disabled="resolving || submitting || !input.trim()">
              <LoaderCircle v-if="resolving" class="spin" :size="17" aria-hidden="true" />{{ resolving ? "正在解析…" : "解析链接" }}
            </button>
          </div>
        </form>
        <p v-if="error" class="error-message" role="alert">{{ error }}</p>
      </section>

      <section class="video-resolution" aria-labelledby="video-resolution-title" :aria-busy="resolving">
        <div class="section-heading"><h2 id="video-resolution-title">解析结果</h2></div>
        <div v-if="result" class="video-preview-card">
          <button
            v-if="currentTask?.status === 'completed' && currentTask.fileExists !== false"
            type="button"
            class="video-preview-cover"
            :aria-label="'播放视频 ' + (result.title || '已保存视频')"
            @click="$emit('action', 'play', currentTask)"
          >
            <VideoCover :src="result.cover" />
            <span class="video-play-mark"><Play :size="21" fill="currentColor" aria-hidden="true" /></span>
          </button>
          <div v-else class="video-preview-cover"><VideoCover :src="result.cover" /></div>
          <div class="video-preview-info">
            <h3>{{ result.title || "视频" }}</h3>
            <p>
              <span v-if="result.duration">{{ time(result.duration) }}</span>
              <span v-if="result.duration && result.platform" aria-hidden="true"> · </span>
              <span v-if="result.platform">{{ platformLabels[result.platform] }}</span>
            </p>
          </div>
        </div>
        <div v-if="result" class="extraction-options">
          <div class="extraction-controls video-output-specs">
            <span>保存格式 <strong>MP4</strong></span>
            <span>来源画质 <strong>{{ result.height ? `${result.height}p` : "由平台提供" }}</strong></span>
          </div>
          <div class="extraction-save-row">
            <ExtractionDestination v-if="active && !submittedId" v-model="videoDestination" v-model:ready="videoDestinationReady"
              kind="video" :disabled="submitting" :request="request" />
            <div class="video-save-action">
              <button
                v-if="currentTask?.status === 'failed'"
                class="secondary"
                type="button"
                :disabled="!!busyTask"
                @click="currentTask.interrupted ? $emit('recovery') : $emit('action', 'retry', currentTask)"
              ><RotateCw :size="19" aria-hidden="true" />{{ currentTask.interrupted ? "查看恢复" : "重试" }}</button>
              <button
                v-else
                class="primary video-primary"
                type="button"
                :disabled="submitting || !!submittedId || !videoDestinationReady"
                @click="save"
              >
                <Download :size="22" aria-hidden="true" />
                {{ submitting ? "正在添加…" : currentTask?.status === "completed" ? "已保存" : currentTask?.status === "cancelled" ? "已取消" : submittedId ? "已加入任务" : "保存视频" }}
              </button>
              <button v-if="result.platform === 'bilibili'" type="button" class="secondary" :disabled="openingAudio" @click="openAudio">
                <AudioLines :size="19" aria-hidden="true" />{{ openingAudio ? "正在打开…" : "提取音频" }}
              </button>
            </div>
          </div>
        </div>
        <div v-if="!result" class="video-preview-empty" role="status">
          <LoaderCircle v-if="resolving" :size="28" class="spin" aria-hidden="true" />
          <Film v-else :size="28" :stroke-width="1.5" aria-hidden="true" />
          <strong>{{ resolving ? "正在读取视频信息" : "等待解析视频" }}</strong>
        </div>
      </section>
    </div>

    <section class="video-recent" aria-labelledby="video-recent-title">
      <div class="section-heading video-recent-heading">
        <h2 id="video-recent-title">最近视频任务</h2>
        <div class="video-queue-controls">
          <span v-if="queue" role="status">视频队列 {{ queue.active }}/{{ queue.limit }}<template v-if="queue.paused"> · 已暂停</template><template v-if="queue.waiting"> · {{ queue.waiting }} 项等待</template></span>
          <button v-if="queue" class="secondary" :disabled="queueBusy" @click="$emit('pauseQueue', !queue.paused)">
            <Play v-if="queue.paused" :size="15" /><Pause v-else :size="15" />
            {{ queue.paused ? "继续视频队列" : "暂停视频队列" }}
          </button>
          <button v-if="tasks.length" class="text-button" @click="$emit('tasks')">查看全部视频任务</button>
        </div>
      </div>
      <p v-if="loadError" class="error-message" role="alert">{{ loadError }}</p>
      <div class="video-task-list">
        <div class="video-task-head" aria-hidden="true"><span>视频</span><span>状态</span><span>操作</span></div>
        <p v-if="!tasks.length" class="video-task-empty">暂无视频任务</p>
        <article v-for="task in tasks.slice(0, 5)" :key="task.id" class="video-result">
          <div class="video-task-title">
            <div class="video-task-cover">
              <VideoCover :src="task.cover" />
              <span v-if="task.duration" class="video-length"><Video :size="13" aria-hidden="true" />{{ time(task.duration) }}</span>
            </div>
            <h3 :title="task.title">{{ task.title || "视频任务" }}</h3>
          </div>
          <div class="video-task-state" :class="task.status" role="status">
            <div class="video-state-label">
              <LoaderCircle v-if="task.status === 'working'" :size="21" class="spin" aria-hidden="true" />
              <span v-else class="video-state-dot" aria-hidden="true"></span>
              <span>{{ task.interrupted && task.status === 'failed' ? "待恢复" : task.fileExists === false ? "文件缺失" : statusLabels[task.status] }}</span>
              <span v-if="task.status === 'working' && task.progress !== undefined" class="video-progress-value">{{ task.progress }}%</span>
            </div>
            <progress v-if="task.status === 'working' && task.progress !== undefined" :value="task.progress" max="100" aria-label="当前下载进度"></progress>
            <p v-else-if="task.status === 'failed' || task.status === 'working'" class="video-state-message">{{ task.message }}</p>
          </div>
          <div class="video-task-actions">
            <button v-if="task.status === 'failed' && task.interrupted" class="secondary" @click="$emit('recovery')">查看恢复</button>
            <button v-else-if="task.status === 'failed'" class="secondary" :disabled="!!busyTask" @click="$emit('action', 'retry', task)">
              <RotateCw :size="20" aria-hidden="true" />重试
            </button>
            <button v-else-if="task.status === 'queued' || task.status === 'working'" class="secondary" :disabled="!!busyTask" @click="$emit('action', 'cancel', task)">
              <Square :size="15" aria-hidden="true" />停止
            </button>
            <button v-else-if="task.status === 'completed'" class="secondary" :disabled="task.fileExists === false || !!busyTask" @click="$emit('action', 'open-folder', task)">
              <Folder :size="21" aria-hidden="true" />打开文件夹
            </button>
            <details class="recent-menu video-task-menu">
              <summary aria-label="更多视频操作" title="更多视频操作"><Ellipsis :size="24" aria-hidden="true" /></summary>
              <div class="recent-menu-content" @click="($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')">
                <button v-if="task.status === 'completed' && task.fileExists !== false" @click="$emit('action', 'play', task)"><Play :size="16" aria-hidden="true" />播放视频</button>
                <button v-if="task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled'" :disabled="!!busyTask" @click="$emit('action', 'remove', task)"><X :size="16" aria-hidden="true" />移除记录</button>
                <button v-if="task.interrupted && task.status === 'failed'" :disabled="!!busyTask" @click="$emit('action', 'cancel', task)"><X :size="16" aria-hidden="true" />取消恢复</button>
              </div>
            </details>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>
