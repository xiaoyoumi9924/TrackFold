<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { FolderOpen } from "@lucide/vue";
import type { StorageKind, StorageSettings } from "../../shared/types";

const props = defineProps<{
  kind: StorageKind;
  disabled?: boolean;
  original?: string;
  request: (url: string, options?: RequestInit) => Promise<unknown>;
}>();
const override = defineModel<string>({ required: true });
const ready = defineModel<boolean>("ready", { required: true });
const settings = ref<StorageSettings>();
const pending = ref(false);
const editing = ref(false);
const draft = ref("");
const pathInput = ref<HTMLInputElement>();
const error = ref("");
const directory = computed(() => props.original ?? (override.value || settings.value?.outputDir));
const defaultUnavailable = computed(() => !override.value && settings.value && !settings.value.available);
watch(() => !!props.original || (!pending.value && !editing.value && (!!override.value || !!settings.value?.available)),
  value => { ready.value = value; }, { immediate: true });

function post(url: string, body: object) {
  return props.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function load() {
  pending.value = true;
  error.value = "";
  try { settings.value = await props.request(`/api/storage?kind=${props.kind}`) as StorageSettings; }
  catch (cause) { error.value = (cause as Error).message; }
  finally { pending.value = false; }
}

async function apply(path: string) {
  const result = await post("/api/storage/check-folder", { path }) as { path: string };
  override.value = result.path;
  editing.value = false;
}

async function choose() {
  if (!settings.value?.nativePicker) {
    draft.value = directory.value || "";
    editing.value = true;
    await nextTick();
    pathInput.value?.focus();
    pathInput.value?.select();
    return;
  }
  pending.value = true;
  error.value = "";
  try {
    const result = await post("/api/storage/choose-folder", { kind: props.kind }) as { path: string | null };
    if (result.path) await apply(result.path);
  } catch (cause) { error.value = (cause as Error).message; }
  finally { pending.value = false; }
}

async function submitPath() {
  pending.value = true;
  error.value = "";
  try { await apply(draft.value.trim()); }
  catch (cause) { error.value = (cause as Error).message; }
  finally { pending.value = false; }
}

watch(() => props.original, value => { if (value === undefined) void load(); }, { immediate: true });
</script>

<template>
  <div class="extraction-destination">
    <div class="extraction-location">
      <FolderOpen :size="19" aria-hidden="true" />
      <div class="extraction-folder">
        <small>{{ original ? "原保存位置" : "保存到" }}</small>
        <span :title="directory">{{ directory || (pending ? "正在读取…" : "保存位置暂不可用") }}</span>
      </div>
      <button v-if="!original && settings && !editing" type="button" class="text-button" :disabled="disabled || pending" @click="choose">本次更改</button>
      <button v-if="override && !editing" type="button" class="text-button" :disabled="disabled || pending" @click="override = ''; error = ''">恢复默认</button>
    </div>
    <form v-if="editing" class="extraction-path-editor" @submit.prevent="submitPath">
      <input ref="pathInput" v-model="draft" aria-label="本次保存文件夹" placeholder="填写文件夹的完整路径" spellcheck="false" :disabled="pending" />
      <button class="secondary" :disabled="pending || !draft.trim()">使用此位置</button>
      <button class="text-button" type="button" :disabled="pending" @click="editing = false; error = ''">取消</button>
    </form>
    <p v-if="error" class="format-note" role="alert">{{ error }}</p>
    <p v-else-if="defaultUnavailable" class="format-note" role="alert">{{ settings?.message }}</p>
    <button v-if="!original && !settings && !pending" class="text-button" type="button" @click="load">重新读取位置</button>
  </div>
</template>

<style scoped>
.extraction-destination { min-width: 0; flex: 1 1 230px; }
.extraction-location, .extraction-path-editor { display: flex; align-items: center; gap: 8px; min-width: 0; }
.extraction-location > svg { flex: none; }
.extraction-folder { min-width: 0; font-size: 13px; line-height: 1.35; }
.extraction-folder small { display: block; color: var(--muted); font-size: 11px; }
.extraction-folder span { display: block; overflow-wrap: anywhere; }
.extraction-location button { flex: none; }
.extraction-path-editor { flex-wrap: wrap; margin-top: 6px; }
.extraction-path-editor input { flex: 1 1 150px; min-width: 0; min-height: 34px; padding: 4px 8px; background: var(--field-surface); border: 1px solid var(--field-border); border-radius: 8px; color: var(--ink); }
.extraction-path-editor button { white-space: nowrap; }
.extraction-destination [role="alert"] { color: var(--warm-error); overflow-wrap: anywhere; }
</style>
