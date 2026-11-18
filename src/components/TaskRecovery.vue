<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { RecoveryItem, Resource } from "../../shared/types";

const props = defineProps<{ request: (url: string, options?: RequestInit) => Promise<unknown> }>();
const emit = defineEmits<{ changed: []; review: [resource: Resource, id: string] }>();
const expanded = defineModel<boolean>("expanded", { required: true });
const items = ref<RecoveryItem[]>([]);
const selection = ref<string[]>([]);
const busy = ref(false);
const feedback = ref("");
const errors = ref<string[]>([]);
const ready = computed(() => items.value.filter(item => item.action === "resume"));
const selected = computed(() => selection.value.filter(id => ready.value.some(item => item.id === id)));
const labels = { resume: "可以继续", file: "需要重新选择文件", review: "需要检查" };
let timer: ReturnType<typeof setInterval>;
let refreshing = false;
let initialized = false;

function post(url: string, body: object = {}) {
  return props.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function refresh() {
  if (refreshing || busy.value) return;
  refreshing = true;
  try {
    const data = await props.request("/api/recovery") as RecoveryItem[];
    if (busy.value) return;
    items.value = data;
    selection.value = initialized ? selected.value : ready.value.slice(0, 20).map(item => item.id);
    if (!initialized) feedback.value = "";
    initialized = true;
  } catch (error) {
    if (!initialized) feedback.value = (error as Error).message;
  } finally { refreshing = false; }
}
onMounted(() => {
  void refresh();
  timer = setInterval(refresh, 1800);
});
onUnmounted(() => clearInterval(timer));

async function act(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  feedback.value = "";
  errors.value = [];
  try { await action(); }
  catch (error) { feedback.value = (error as Error).message; }
  finally { busy.value = false; emit("changed"); void refresh(); }
}
async function resume() {
  if (!selected.value.length) return;
  await act(async () => {
    const result = await post("/api/recovery/resume", { ids: selected.value }) as { results: { id: string; title: string; message?: string }[] };
    const accepted = result.results.filter(item => !item.message);
    selection.value = selection.value.filter(id => !accepted.some(item => item.id === id));
    errors.value = result.results.flatMap(item => item.message ? [`${item.title}：${item.message}`] : []);
    feedback.value = `已恢复或加入队列 ${accepted.length} 项${errors.value.length ? `，${errors.value.length} 项需要处理` : ""}。`;
  });
}
async function pickFile(item: RecoveryItem, event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  await act(async () => {
    const body = new FormData();
    body.append("file", file);
    const { token } = await props.request("/api/upload", { method: "POST", body }) as Resource;
    try {
      await post(`/api/recovery/${encodeURIComponent(item.id)}/file`, { token });
      feedback.value = `已继续处理「${item.title}」。`;
    } catch (error) {
      await props.request(`/api/uploads/${encodeURIComponent(token)}`, { method: "DELETE" }).catch(() => {});
      throw error;
    }
  });
}
async function review(item: RecoveryItem) {
  await act(async () => {
    const resource = await post(`/api/recovery/${encodeURIComponent(item.id)}/source`) as Resource;
    emit("review", resource, item.id);
  });
}
</script>

<template>
  <section v-if="items.length || feedback" class="tasks-tools task-recovery" aria-labelledby="task-recovery-title">
    <div class="tasks-tools-row task-recovery-heading">
      <h2 id="task-recovery-title">继续上次<span v-if="items.length"> · {{ items.length }} 项待处理</span></h2>
      <div v-if="items.length" class="task-recovery-actions">
        <button v-if="expanded && ready.length" type="button" class="primary" :disabled="!selected.length || busy" @click="resume">
          {{ busy ? "正在处理…" : `继续所选（${selected.length}）` }}
        </button>
        <button type="button" class="secondary" aria-controls="task-recovery-items" :aria-expanded="expanded" @click="expanded = !expanded">{{ expanded ? "收起" : "查看待恢复" }}</button>
      </div>
    </div>
    <ul v-if="items.length" v-show="expanded" id="task-recovery-items" class="task-recovery-list">
      <li v-for="item in items" :key="item.id" class="task-recovery-row">
        <input v-if="item.action === 'resume'" v-model="selection" type="checkbox" :value="item.id"
          :aria-label="`恢复 ${item.title}`" :disabled="busy || (selected.length >= 20 && !selected.includes(item.id))" />
        <div class="task-recovery-info">
          <strong>{{ item.title }}</strong>
          <p>{{ item.kind === 'audio' ? '音频' : '视频' }} · {{ labels[item.action] }} · {{ item.message }}</p>
        </div>
        <label v-if="item.action === 'file'" class="secondary task-recovery-picker" :class="{ disabled: busy }">
          选择原文件<input class="sr-only" type="file" :aria-label="`为 ${item.title} 选择原文件`" :disabled="busy" @change="pickFile(item, $event)" />
        </label>
        <button v-if="item.canReviewSource" type="button" class="secondary" :disabled="busy" @click="review(item)">重新确认资源</button>
      </li>
    </ul>
    <div v-if="feedback" role="status">
      <p>{{ feedback }}</p>
      <ul v-if="errors.length"><li v-for="detail in errors" :key="detail">{{ detail }}</li></ul>
    </div>
  </section>
</template>
