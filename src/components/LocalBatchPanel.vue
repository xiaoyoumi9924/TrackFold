<script setup lang="ts">
import { computed, ref, onMounted } from "vue";
import {
  Upload,
  Plus,
  X,
  LoaderCircle,
  FolderOpen,
  Check,
  AlertCircle,
  ArrowDownToLine,
} from "@lucide/vue";
import type { Job, LibrarySettings, StorageSettings } from "../../shared/types";
import { originalAudioNote } from "../../shared/preferences";
import {
  localBatch as state,
  addLocalFiles,
  discardLocal,
  readPending,
  submitLocal,
  type LocalItem,
} from "../local-batch";
const props = defineProps<{ jobs: Job[] }>();
const emit = defineEmits<{ refresh: []; single: [] }>();
const picker = ref<HTMLInputElement>();
const loadingSettings = ref(false),
  settingsReady = ref(false),
  nativePicker = ref(false);
const selected = computed(() =>
  state.items.filter((i) => i.selected && i.phase === "ready"),
);
const failed = computed(() =>
  state.items.filter(
    (i) =>
      i.phase === "error" ||
      (i.jobId &&
        props.jobs.some(
          (j) => j.id === i.jobId && ["failed", "cancelled"].includes(j.status),
        )),
  ),
);
const submitted = computed(() =>
  state.items.filter((i) => i.phase === "submitted"),
);
const ready = computed(() => state.items.filter((i) => i.phase === "ready"));
const processing = computed(
  () =>
    submitted.value.filter((i) => {
      const j = props.jobs.find((j) => j.id === i.jobId);
      return !j || !["completed", "failed", "cancelled"].includes(j.status);
    }).length,
);
const done = computed(
  () =>
    submitted.value.filter((i) =>
      props.jobs.some((j) => j.id === i.jobId && j.status === "completed"),
    ).length,
);
const storageError = ref("");
function jobFor(item: LocalItem) {
  return props.jobs.find((j) => j.id === item.jobId);
}
function status(item: LocalItem) {
  const job = jobFor(item);
  if (item.phase === "submitted")
    return item.reused
      ? job?.status === "completed"
        ? "复用已保存文件"
        : "复用已有任务"
      : job
        ? {
            queued: "等待处理",
            downloading: "读取来源",
            processing: "提取音频",
            checking: "核对文件",
            completed: "已保存",
            failed: "处理失败",
            cancelled: "已取消",
          }[job.status]
        : "已加入任务";
  return {
    waiting: "等待读取",
    reading: "正在读取",
    ready: "待保存",
    error: "未完成",
  }[item.phase];
}
const time = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
async function loadSettings() {
  const newBatch = !state.items.length;
  loadingSettings.value = true;
  storageError.value = "";
  settingsReady.value = false;
  try {
    const [storageResponse, organizationResponse] = await Promise.all([
      fetch("/api/storage"),
      fetch("/api/library/settings"),
    ]);
    if (!storageResponse.ok || !organizationResponse.ok)
      throw Error("未能读取保存偏好，请重试。");
    const storage: StorageSettings = await storageResponse.json();
    const organization: LibrarySettings = await organizationResponse.json();
    if (!storage.available) throw Error(storage.message);
    if (newBatch || !state.outputDir) state.outputDir = storage.outputDir;
    if (newBatch || !state.preferencesLoaded) {
      state.organization = organization;
      state.preferencesLoaded = true;
    }
    nativePicker.value = storage.nativePicker;
    settingsReady.value = true;
  } catch (e) {
    storageError.value = (e as Error).message;
  } finally {
    loadingSettings.value = false;
  }
}
async function add(files: File[]) {
  await addLocalFiles(files);
}
async function picked(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = "";
  await add(files);
}
async function remove(item: LocalItem) {
  if (state.busy) return;
  try {
    await discardLocal(item);
    state.items = state.items.filter((i) => i.id !== item.id);
  } catch (e) {
    state.error = (e as Error).message;
  }
}
async function clear() {
  if (state.busy) return;
  state.error = "";
  state.message = "";
  for (const item of [...state.items]) await remove(item);
}
async function chooseFolder() {
  storageError.value = "";
  loadingSettings.value = true;
  try {
    const r = await fetch("/api/storage/choose-folder", { method: "POST" });
    const result = await r.json();
    if (!r.ok) throw Error(result.error);
    if (result.path) state.outputDir = result.path;
  } catch (e) {
    storageError.value = (e as Error).message;
  } finally {
    loadingSettings.value = false;
  }
}
async function save(retry = false) {
  if (!settingsReady.value) return;
  await submitLocal(retry, props.jobs);
  emit("refresh");
}
function selectAll() {
  const next = !ready.value.every((i) => i.selected);
  for (const item of ready.value) item.selected = next;
}
onMounted(loadSettings);
defineExpose({ addFiles: add });
</script>

<template>
  <div
    class="local-batch-panel"
    @dragover.prevent
    @drop.prevent="add(Array.from($event.dataTransfer?.files || []))"
  >
    <div class="local-batch-heading">
      <div>
        <h3>本地批量处理</h3>
        <p>每批最多 20 个文件 · 单个 500 MB · 合计 2 GB</p>
      </div>
      <button
        class="secondary local-batch-back"
        :disabled="!!state.busy || loadingSettings"
        @click="emit('single')"
      >
        返回单文件
      </button>
    </div>
    <input
      ref="picker"
      class="sr-only"
      type="file"
      multiple
      accept="audio/*,video/*,.mkv,.flac,.m4a,.wav"
      aria-label="选择批量音视频文件"
      @change="picked"
    />
    <div :class="['batch-drop-area', { compact: state.items.length }]">
      <Upload :size="state.items.length ? 19 : 30" :stroke-width="1.5" />
      <p>
        {{
          state.items.length
            ? "拖入更多文件，或继续选择"
            : "将多段音频或视频拖到这里"
        }}
      </p>
      <button
        class="secondary"
        :disabled="!!state.busy || state.items.length >= 20"
        @click="picker?.click()"
      >
        <Plus :size="16" />{{
          state.items.length ? "添加文件" : "选择多个文件"
        }}
      </button>
    </div>
    <p v-if="state.error" class="batch-issue" role="alert">{{ state.error }}</p>
    <div v-if="state.items.length" class="local-batch-settings">
      <h4>统一保存选项</h4>
      <div class="local-options-grid">
        <label
          >输出格式<select
            aria-label="输出格式"
            v-model="state.format"
            :disabled="!!state.busy || loadingSettings"
          >
            <option value="original">保留来源音轨</option>
            <option value="mp3">MP3 · 通用格式</option>
            <option value="m4a">M4A · 兼容输出</option>
            <option value="wav">WAV · 剪辑素材</option>
          </select></label
        >
        <label
          >文件命名<select
            aria-label="文件命名"
            v-model="state.organization.naming"
            :disabled="!!state.busy || loadingSettings"
          >
            <option value="artist-title">歌手 - 歌名</option>
            <option value="title-artist">歌名 - 歌手</option>
            <option value="title">仅歌名</option>
          </select></label
        >
      </div>
      <label class="destination-field"
        >本批保存位置
        <div>
          <input
            aria-label="本批保存位置"
            v-model="state.outputDir"
            :disabled="!!state.busy || loadingSettings"
            placeholder="已有文件夹的完整路径"
          /><button
            v-if="nativePicker"
            class="secondary"
            aria-label="选择本批保存文件夹"
            :disabled="!!state.busy || loadingSettings"
            @click="chooseFolder"
          >
            <FolderOpen :size="17" />
          </button></div
      ></label>
      <div class="local-checks">
        <label
          ><input
            v-model="state.organization.embedCover"
            type="checkbox"
            :disabled="!!state.busy || loadingSettings"
          />保留可用封面</label
        ><label
          ><input
            v-model="state.forceCopy"
            type="checkbox"
            :disabled="!!state.busy || loadingSettings"
          />历史已保存资源另存副本</label
        >
      </div>
      <p v-if="storageError" class="batch-issue" role="alert">
        {{ storageError }}
        <button
          class="text-button"
          :disabled="loadingSettings"
          @click="loadSettings"
        >
          重新读取设置
        </button>
      </p>
    </div>
    <div v-if="state.items.length" class="local-list-toolbar">
      <span
        >{{ state.items.length }} 个文件 · 待保存已选
        {{ selected.length }} 个</span
      >
      <div>
        <button
          class="text-button"
          :disabled="!!state.busy || !ready.length"
          @click="selectAll"
        >
          {{
            ready.length && ready.every((i) => i.selected)
              ? "取消全选"
              : "选择全部待保存"
          }}</button><button
          class="text-button"
          :disabled="!!state.busy || loadingSettings"
          @click="clear"
        >
          清空清单
        </button>
      </div>
    </div>
    <ol class="local-file-list">
      <li
        v-for="item in state.items"
        :key="item.id"
        :class="{
          'local-failed':
            item.phase === 'error' || jobFor(item)?.status === 'failed',
        }"
      >
        <div class="local-file-main">
          <input
            v-if="item.phase === 'ready'"
            v-model="item.selected"
            type="checkbox"
            :aria-label="`选择文件 ${item.file.name}`"
            :disabled="!!state.busy || loadingSettings"
          /><LoaderCircle
            v-else-if="item.phase === 'reading'"
            :size="17"
            class="spin"
          /><Check
            v-else-if="jobFor(item)?.status === 'completed'"
            :size="17"
          /><AlertCircle v-else-if="item.phase === 'error'" :size="17" /><span
            v-else
            class="file-dot"
          ></span>
          <div class="local-file-info">
            <h4>{{ item.file.name }}</h4>
            <p>
              {{ (item.file.size / 1024 / 1024).toFixed(1) }} MB<template
                v-if="item.resource"
              >
                · {{ time(item.resource.duration) }} ·
                {{ item.resource.choices[0]?.format?.toUpperCase() }}</template
              >
            </p>
            <p v-if="state.format === 'original' && item.phase === 'ready' && item.resource">
              {{ originalAudioNote(item.resource.choices[0]?.format, state.organization.embedCover) }}
            </p>
          </div>
          <span class="local-file-status">{{ status(item) }}</span><button
            class="icon-button"
            :disabled="!!state.busy || loadingSettings"
            :aria-label="`移除清单文件 ${item.file.name}`"
            @click="remove(item)"
          >
            <X :size="16" />
          </button>
        </div>
        <p
          v-if="
            item.error ||
            jobFor(item)?.status === 'failed' ||
            jobFor(item)?.status === 'cancelled'
          "
          class="batch-issue"
          role="status"
        >
          {{ item.error || jobFor(item)?.message }}
        </p>
        <details
          v-if="item.metadata && item.phase === 'ready'"
          class="local-file-metadata"
        >
          <summary>歌曲信息</summary>
          <div class="local-options-grid">
            <label
              >标题<input
                v-model="item.metadata.title"
                :aria-label="`标题 ${item.file.name}`"
                maxlength="300"
                :disabled="!!state.busy || loadingSettings" /></label
            ><label
              >歌手 / 作者<input
                v-model="item.metadata.artist"
                :aria-label="`歌手 ${item.file.name}`"
                maxlength="300"
                :disabled="!!state.busy || loadingSettings" /></label
            ><label
              >专辑（可选）<input
                v-model="item.metadata.album"
                :disabled="!!state.busy || loadingSettings"
                maxlength="300"
            /></label>
          </div>
        </details>
        <p v-if="jobFor(item)?.status === 'completed'" class="local-result">
          <a :href="`/api/jobs/${item.jobId}/file`">获取已保存文件</a
          ><span>{{ jobFor(item)?.filename }}</span>
        </p>
      </li>
    </ol>
    <div v-if="state.items.length" class="local-submit-actions">
      <button
        class="primary"
        :disabled="
          !!state.busy || loadingSettings || !settingsReady || !selected.length
        "
        @click="save()"
      >
        <ArrowDownToLine :size="17" />保存所选 {{ selected.length }} 个
      </button>
      <button
        v-if="failed.length"
        class="secondary"
        :disabled="!!state.busy || !settingsReady"
        @click="save(true)"
      >
        重试未完成 {{ failed.length }} 个
      </button>
      <button
        v-if="state.items.some((i) => i.phase === 'waiting') && !state.busy"
        class="secondary"
        @click="readPending(state.items.filter((i) => i.phase === 'waiting'))"
      >
        继续读取
      </button>
      <button
        v-if="state.busy"
        class="secondary"
        :disabled="state.stop"
        @click="state.stop = true"
      >
        {{ state.stop ? "等待当前文件完成…" : "停止后续操作" }}
      </button>
    </div>
    <p v-if="state.busy" class="local-feedback" role="status">
      <LoaderCircle :size="15" class="spin" />{{
        state.busy === "reading"
          ? "正在逐个读取文件，单个失败不会阻断其他文件。"
          : "正在逐条加入处理任务…"
      }}
    </p>
    <p v-if="state.message" class="local-feedback" role="status">
      {{ state.message }}
    </p>
    <p v-if="submitted.length" class="local-feedback" role="status">
      本批已完成 {{ done }} 个，正在处理
      {{ processing }} 个。移除或清空清单不取消已加入任务。
    </p>
  </div>
</template>

<style scoped>
.local-batch-panel {
  padding: 22px 0;
}
.local-batch-heading,
.local-list-toolbar,
.local-list-toolbar > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}
.local-batch-heading .local-batch-back { min-height: 40px; padding-inline: 15px; font-size: 14px; }
h3 {
  font-size: 17px;
  margin: 0;
}
h4 {
  margin: 0;
  font-size: 14px;
}
p {
  margin: 8px 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
}
.batch-drop-area {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 180px;
  margin-top: 20px;
  border: 1px dashed var(--field-border);
  border-radius: 12px;
  background: var(--field-surface);
  padding: 18px;
}
.batch-drop-area.compact {
  min-height: 0;
  flex-direction: row;
  flex-wrap: wrap;
  gap: 12px;
}
.local-batch-settings {
  padding: 22px 0;
  margin-top: 6px;
  border-bottom: 1px solid var(--line);
}
.local-options-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 14px;
}
label {
  font-size: 12px;
  color: var(--muted);
}
.local-options-grid label,
.destination-field {
  display: grid;
  gap: 7px;
}
input:not([type="checkbox"]):not([type="file"]),
select {
  width: 100%;
  min-width: 0;
  min-height: 40px;
  font: inherit;
  color: var(--ink);
  background: var(--field-surface);
  border: 1px solid var(--field-border);
  border-radius: 6px;
  padding: 8px;
}
.destination-field {
  margin-top: 14px;
}
.destination-field > div {
  display: flex;
  gap: 8px;
}
.local-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 17px;
}
.local-checks label {
  display: flex;
  align-items: center;
  gap: 6px;
}
input[type="checkbox"] {
  accent-color: var(--accent);
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.local-list-toolbar {
  margin-top: 20px;
  font-size: 12px;
  color: var(--muted);
}
.local-file-list {
  list-style: none;
  padding: 0;
  margin: 10px 0 20px;
}
.local-file-list > li {
  padding: 17px 0;
  border-bottom: 1px solid var(--line);
}
.local-file-main {
  display: flex;
  align-items: center;
  gap: 10px;
}
.local-file-main > svg {
  flex-shrink: 0;
}
.local-file-info {
  flex: 1;
  min-width: 0;
}
.local-file-info h4 {
  overflow-wrap: anywhere;
  line-height: 1.6;
}
.local-file-info p {
  margin: 3px 0 0;
}
.local-file-status {
  font-size: 12px;
  flex-shrink: 0;
}
.file-dot {
  width: 16px;
  flex-shrink: 0;
}
.local-file-metadata {
  margin: 10px 0 0 26px;
}
summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--muted);
}
.batch-issue {
  color: var(--warm-error);
}
.local-submit-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.local-feedback {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 14px;
}
.local-result {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  overflow-wrap: anywhere;
  margin-left: 26px;
}
.local-result a {
  color: var(--accent);
}
@media (max-width: 550px) {
  .local-options-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  input:not([type="checkbox"]):not([type="file"]),
  select {
    font-size: 16px;
  }
  .local-file-main {
    flex-wrap: wrap;
  }
  .local-file-info {
    flex-basis: calc(100% - 28px);
  }
  .local-file-status {
    margin-left: 26px;
  }
  .local-file-main .icon-button {
    margin-left: auto;
  }
  .local-submit-actions > button {
    flex: 1 1 auto;
  }
}
</style>
