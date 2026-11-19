<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { LoaderCircle, RotateCw, Square } from "@lucide/vue";
import type { Batch, BatchItem, Job, Resource } from "../../shared/types";

type BatchSummary = { id: string; createdAt: string; title: string; status: Batch["status"]; total: number };
const props = defineProps<{ initialId: string; jobs: Job[] }>();
const emit = defineEmits<{ song: [id: string, resource: Resource, batchId: string, itemId: string]; complete: [id: string]; issues: [count: number] }>();
const list = ref<BatchSummary[]>([]);
const selectedId = ref("");
const batch = ref<Batch>();
const busy = ref(false);
const opening = ref("");
const error = ref("");
const updating = ref(false);
const listing = ref(true);
let disposed = false;
let timer: ReturnType<typeof setInterval>;
const base = "/api/discovery/batches";
const ended = computed(() => batch.value?.items.filter(item => item.status !== "waiting" && item.status !== "resolving").length ?? 0);
const waiting = computed(() => batch.value?.items.filter(item => item.status === "waiting").length ?? 0);
const done = computed(() => batch.value?.items.filter(item => ["ready", "duplicate", "submitted"].includes(item.status)).length ?? 0);
const submitted = computed(() => batch.value?.items.filter(item => item.status === "submitted").length ?? 0);
const review = computed(() => batch.value?.items.filter(item => item.status === "ready").length ?? 0);
const retryable = computed(() => batch.value?.items.some(item => ["failed", "cancelled", "stale"].includes(item.status)));
const jobsById = computed(() => new Map(props.jobs.map(job => [job.id, job])));
function linkedJob(item: BatchItem) {
  return item.jobId ? jobsById.value.get(item.jobId) : undefined;
}
function failure(item: BatchItem) {
  const job = linkedJob(item);
  if (item.status === "failed") return item.message || "音频不可用。";
  if (job?.status === "failed") return job.message || "保存音频失败。";
  if (job?.status === "cancelled") return job.message || "已取消保存。";
  if (job?.fileExists === false && job.status === "completed") return "已保存的音频文件找不到。";
  return "";
}
const failed = computed(() => batch.value?.items.filter(item => failure(item)).length ?? 0);
watch(failed, count => emit("issues", count));
const complete = computed(() => {
  const current = batch.value;
  return current?.id === props.initialId && current.status === "ready" && current.items.length > 0 &&
    current.items.every(item => {
      if (item.status === "duplicate") return true;
      const job = linkedJob(item);
      return item.status === "submitted" && job?.status === "completed" && job.fileExists !== false;
    });
});
watch(complete, value => { if (value) emit("complete", props.initialId); });
const states: Record<BatchItem["status"], string> = {
  listed: "未解析", waiting: "等待中", resolving: "正在解析", failed: "失败", cancelled: "已停止",
  stale: "待重新解析", ready: "已解析", duplicate: "重复", submitted: "已加入提取",
};
const jobStates: Record<Job["status"], string> = {
  queued: "等待下载", downloading: "正在下载", processing: "正在处理", checking: "正在核对",
  completed: "已保存", failed: "保存失败", cancelled: "已取消",
};
function badge(item: BatchItem) {
  const job = linkedJob(item);
  if (job) return job.status === "completed" && job.fileExists === false ? "文件缺失" : jobStates[job.status];
  if (item.status === "submitted") return item.message;
  if (item.status !== "ready") return states[item.status];
  if (item.resource?.audioSource === "douyin") return "抖音原声";
  if (item.resource?.completeness === "full") return "完整音频";
  return item.resource?.completeness === "preview" ? "平台试听" : "完整性未知";
}
async function request<T>(url: string, body?: object): Promise<T> {
  const response = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "暂时无法读取歌单批次。");
  return data;
}
async function readBatch() {
  const id = selectedId.value;
  if (!id || updating.value || busy.value) return;
  updating.value = true;
  try {
    const next = await request<Batch>(`${base}/${id}`);
    if (selectedId.value === id && !busy.value && !disposed) batch.value = next;
  } catch (cause) {
    if (selectedId.value === id && !disposed) error.value = (cause as Error).message;
  } finally { updating.value = false; }
  if (id !== selectedId.value && !disposed) void readBatch();
}
function choose(id: string) {
  selectedId.value = id;
  error.value = "";
  batch.value = undefined;
  void readBatch();
}
async function load() {
  listing.value = true;
  error.value = "";
  try {
    list.value = await request<BatchSummary[]>(base);
    if (!disposed) choose(list.value.find(item => item.id === props.initialId)?.id || list.value.find(item => item.status === "resolving")?.id || list.value[0]?.id || "");
  } catch (cause) { error.value = (cause as Error).message; }
  finally { listing.value = false; }
}
async function control(action: "stop" | "retry") {
  if (!batch.value || busy.value || updating.value) return;
  busy.value = true;
  error.value = "";
  try { batch.value = await request(`${base}/${batch.value.id}/${action}`, {}); }
  catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
async function open(item: BatchItem) {
  if (!batch.value || !item.track || opening.value) return;
  const id = batch.value.id;
  opening.value = item.id;
  error.value = "";
  try {
    const resource = await request<Resource>(`${base}/${id}/resource`, { itemId: item.id });
    if (!disposed) emit("song", item.track.id, resource, id, item.id);
  } catch (cause) { error.value = (cause as Error).message; }
  finally { opening.value = ""; }
}
onMounted(() => {
  void load();
  timer = setInterval(() => {
    if (batch.value?.status === "resolving" || (selectedId.value && !batch.value)) void readBatch();
  }, 1500);
});
onUnmounted(() => { disposed = true; clearInterval(timer); });
</script>

<template>
  <div class="discovery-batch-panel">
    <label v-if="list.length" class="discovery-batch-picker">
      解析批次
      <select :value="selectedId" :disabled="busy || !!opening" @change="choose(($event.target as HTMLSelectElement).value)">
        <option v-for="item in list" :key="item.id" :value="item.id">{{ item.title }} · {{ item.total }} 首 · {{ new Date(item.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) }}</option>
      </select>
    </label>
    <p v-if="error" class="discovery-error" role="alert">{{ error }}</p>
    <button v-if="error && !batch" class="secondary" @click="load">重试</button>
    <p v-if="listing" role="status">正在读取歌单批次…</p>
    <p v-else-if="!error && !list.length && !batch">在汽水音乐中多选歌曲后，点「解析并下载」。</p>
    <div v-if="batch" class="discovery-batch">
      <div class="discovery-batch-progress">
        <div role="status">
          <strong>已解析 {{ done }} / {{ batch.items.length }} 首</strong>
          <span v-if="waiting"> · {{ waiting }} 首待解析</span>
          <span v-if="submitted"> · {{ submitted }} 首已交给音频队列</span>
          <span v-if="review"> · {{ review }} 首待确认</span>
        </div>
        <button v-if="batch.status === 'resolving'" class="secondary" :disabled="busy || updating" @click="control('stop')"><Square :size="15" />停止解析</button>
        <button v-else-if="retryable" class="secondary" :disabled="busy || updating" @click="control('retry')"><RotateCw :size="15" />重新解析未完成项</button>
        <progress v-if="batch.status === 'resolving'" :value="ended" :max="batch.items.length" aria-label="解析进度"></progress>
      </div>
      <p v-if="failed" class="discovery-error" role="alert">{{ failed }} 首音频无法获取或保存，原因见下方歌曲。</p>
      <ul class="discovery-batch-list">
        <li v-for="item in batch.items" :key="item.id">
          <div class="discovery-batch-song"><strong>{{ item.track?.title }}</strong>
            <p>{{ item.track?.artist || '未知歌手' }}<template v-if="item.status === 'submitted' && item.resource?.completeness === 'preview'"> · {{ item.resource.audioSource === 'douyin' ? '抖音原声' : '平台试听' }}</template></p>
            <p v-if="failure(item)" class="discovery-error">{{ failure(item) }}</p>
          </div>
          <span class="discovery-state" :class="item.jobId && jobsById.get(item.jobId)?.status || item.status">{{ badge(item) }}</span>
          <button v-if="item.status === 'ready'" class="secondary" :disabled="!!opening" @click="open(item)">
            <LoaderCircle v-if="opening === item.id" :size="15" class="spin" />查看并保存
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.discovery-batch-panel > p { margin: 4px 0; }
.discovery-batch-picker { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; }
.discovery-batch-picker select { min-width: 0; width: min(410px, 100%); padding: 7px 10px; border: 1px solid var(--field-border); border-radius: 9px; background: var(--field-surface); color: var(--ink); text-overflow: ellipsis; }
.discovery-batch-progress { margin-top: 12px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; color: var(--muted); }
.discovery-batch-progress strong { color: var(--ink); }
.discovery-batch-progress progress { width: 100%; height: 8px; accent-color: var(--accent); }
.discovery-batch-list { margin: 8px 0 0; padding: 0; max-height: min(248px, 38vh); overflow: auto; scrollbar-width: thin; list-style: none; }
.discovery-batch-list li { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; padding: 8px 0; border-top: 1px solid var(--line); }
.discovery-batch-song { flex: 1 1 10rem; min-width: 0; overflow-wrap: anywhere; }
.discovery-batch-song strong { color: var(--ink); }
.discovery-batch-song p { font-size: 12px; margin: 3px 0 0; }
.discovery-batch-panel .secondary { min-height: 34px; padding: 4px 9px; }
.discovery-state { font-size: 12px; color: var(--muted); white-space: nowrap; }
.discovery-state.ready, .discovery-state.resolving, .discovery-state.completed { color: var(--soft-accent); }
.discovery-state.failed, .discovery-error { color: var(--warm-error); overflow-wrap: anywhere; }
</style>
