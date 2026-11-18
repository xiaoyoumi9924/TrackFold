<script setup lang="ts">
import { ref } from "vue";
import { DatabaseBackup, Upload } from "@lucide/vue";
const props = defineProps<{ request: (url: string, options?: RequestInit) => Promise<unknown> }>();
const emit = defineEmits<{ restored: [] }>();
type Preview = { id: string; createdAt: string; audio: number; video: number; favorites: number; groups: number; presets: number; canRestore: boolean };
const picker = ref<HTMLInputElement>();
const preview = ref<Preview>();
const busy = ref(false);
const error = ref("");
const message = ref("");
async function choose(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || busy.value) return;
  busy.value = true;
  preview.value = undefined;
  error.value = "";
  message.value = "";
  try {
    if (file.size > 12 * 1024 ** 2) throw new Error("此备份超过 12 MB，暂时无法读取。");
    preview.value = await props.request("/api/backup/preview", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: await file.text(),
    }) as Preview;
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
async function restore() {
  if (!preview.value?.canRestore || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await props.request("/api/backup/restore", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: preview.value.id }),
    });
    preview.value = undefined;
    message.value = "记录已恢复。文件移到新位置时，可在任务或歌单里重新关联。";
    emit("restored");
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
</script>

<template>
  <section class="settings-card">
    <h3>记录备份与恢复</h3>
    <div class="settings-actions">
      <a class="secondary" href="/api/backup"><DatabaseBackup :size="17" />导出记录备份</a>
      <button class="secondary" :disabled="busy" @click="picker?.click()"><Upload :size="17" />打开备份预览</button>
      <input ref="picker" type="file" accept=".json,application/json" class="sr-only" tabindex="-1" aria-label="选择拾音备份" @change="choose" />
    </div>
    <div v-if="preview" class="settings-preview">
      <strong>恢复预览</strong>
      <p>备份时间 {{ new Date(preview.createdAt).toLocaleString('zh-CN') }}</p>
      <dl class="backup-counts">
        <div><dt>音频记录</dt><dd>{{ preview.audio }}</dd></div>
        <div><dt>视频记录</dt><dd>{{ preview.video }}</dd></div>
        <div><dt>收藏</dt><dd>{{ preview.favorites }}</dd></div>
        <div><dt>歌单分组</dt><dd>{{ preview.groups }}</dd></div>
        <div v-if="preview.presets"><dt>旧版预设</dt><dd>{{ preview.presets }}</dd></div>
      </dl>
      <p v-if="!preview.canRestore" class="storage-warning">当前资料库已有记录、歌单或预设。首版支持恢复到空资料库。</p>
      <div class="settings-actions">
        <button class="primary" :disabled="busy || !preview.canRestore" @click="restore">确认恢复</button>
        <button class="text-button" :disabled="busy" @click="preview = undefined; error = ''">关闭预览</button>
      </div>
    </div>
    <p v-if="busy" role="status">正在处理备份…</p>
    <p v-if="error" class="storage-warning" role="alert">{{ error }}</p>
    <p v-if="message" class="settings-save-feedback" role="status">{{ message }}</p>
  </section>
</template>
