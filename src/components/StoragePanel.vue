<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { FolderOpen, LoaderCircle, AlertCircle, Check } from "@lucide/vue";
import type { StorageKind, StorageSettings } from "../../shared/types";
const props = defineProps<{ kind: StorageKind }>();
const label = computed(() => props.kind === "audio" ? "音频" : "视频");
const emit = defineEmits<{ changed: [directory: string] }>();
const settings = ref<StorageSettings | null>(null);
const pathInput = ref<HTMLInputElement>();
const draft = ref("");
const busy = ref("");
const error = ref("");
const message = ref("");
const editing = ref(false);
const dirty = computed(() => !!settings.value && draft.value !== settings.value.outputDir);
async function api(url: string, body?: unknown) {
  const response = await fetch(
    url,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "操作未完成，请重试。");
  return data;
}
async function load() {
  if (busy.value) return;
  busy.value = "load";
  error.value = "";
  try {
    settings.value = await api(`/api/storage?kind=${props.kind}`);
    draft.value = settings.value!.outputDir;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = "";
  }
}
async function choose() {
  if (busy.value) return;
  busy.value = "choose";
  error.value = "";
  message.value = "";
  try {
    const data = await api("/api/storage/choose-folder", { kind: props.kind });
    if (data.path) {
      draft.value = data.path.replace(/\/$/, "") || "/";
      editing.value = true;
      message.value = "";
    } else message.value = "已取消选择，保存位置未变更。";
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = "";
  }
}
async function save() {
  if (busy.value || !draft.value.trim() || (!dirty.value && settings.value?.available)) return;
  busy.value = "save";
  error.value = "";
  message.value = "";
  try {
    settings.value = await api("/api/storage", { kind: props.kind, outputDir: draft.value });
    draft.value = settings.value!.outputDir;
    emit("changed", draft.value);
    editing.value = false;
    message.value = "保存位置已更新，之后新建的任务将使用这里。";
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = "";
  }
}
function editPath() {
  editing.value = true;
  pathInput.value?.focus();
  pathInput.value?.select();
}
function cancelDraft() {
  if (settings.value) draft.value = settings.value.outputDir;
  editing.value = false;
  error.value = "";
  message.value = "";
}
onMounted(load);
</script>

<template>
  <section class="settings-storage-location" :aria-labelledby="'storage-' + kind + '-title'">
    <h4 :id="'storage-' + kind + '-title'">{{ label }}文件夹</h4>
    <template v-if="settings">
      <form class="settings-storage-form" @submit.prevent="save">
        <div class="settings-storage-row">
          <label class="settings-storage-path">
            <FolderOpen :size="23" aria-hidden="true" />
            <span class="sr-only">{{ label }}保存文件夹路径</span>
            <input
              ref="pathInput"
              v-model="draft"
              :disabled="!!busy"
              spellcheck="false"
              autocomplete="off"
              :title="draft"
              @input="editing = true; message = ''; error = ''"
            />
          </label>
          <button class="primary settings-change-location" type="button" :disabled="!!busy" @click="settings.nativePicker ? choose() : editPath()">
            <LoaderCircle v-if="busy === 'choose'" :size="16" class="spin" aria-hidden="true" />
            {{ busy === "choose" ? "请选择文件夹…" : "更改位置" }}
          </button>
        </div>
        <div v-if="editing || dirty || !settings.available" class="settings-storage-actions">
          <p class="settings-storage-action-status" role="status">
            {{ dirty ? "新位置尚未应用" : !settings.available ? "请先选择一个可用位置" : "更改位置后，应用才会生效" }}
          </p>
          <div class="settings-storage-action-buttons">
            <button class="text-button" type="button" :disabled="!!busy" @click="draft = settings.defaultOutputDir; editing = true; message = ''; error = ''">
              选用默认位置
            </button>
            <button v-if="editing || dirty" class="text-button" type="button" :disabled="!!busy" @click="cancelDraft">取消更改</button>
            <button class="secondary" :disabled="!!busy || !draft.trim() || (!dirty && settings.available)">
              <LoaderCircle v-if="busy === 'save'" :size="16" class="spin" /><Check v-else :size="16" />
              {{ busy === "save" ? "正在检查并保存…" : "应用保存位置" }}
            </button>
          </div>
        </div>
      </form>
      <p v-if="!settings.available" class="storage-warning" role="alert">
        <AlertCircle :size="16" />{{ settings.message }}
      </p>
    </template>
    <p v-else-if="busy === 'load'" class="storage-hint" role="status">正在读取保存位置…</p>
    <button v-else class="secondary" @click="load">重新读取保存位置</button>
    <div v-if="error" class="error-message" role="alert"><AlertCircle :size="18" /><p>{{ error }}</p></div>
    <p v-if="message" class="storage-feedback" role="status">{{ message }}</p>
  </section>
</template>
