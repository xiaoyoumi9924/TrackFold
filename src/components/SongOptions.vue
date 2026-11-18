<script setup lang="ts">
import { ref, watch } from "vue";
import { Check, FolderOpen } from "@lucide/vue";
import type { Resource, Job, AudioMetadata } from "../../shared/types";

const props = defineProps<{ resource: Resource; choice: string; format: string; revision: number; skipMatch?: boolean }>();
const emit = defineEmits<{ metadata: [AudioMetadata]; force: [boolean] }>();
const title = ref(""), artist = ref(""), album = ref(""), forceCopy = ref(false), saved = ref<Job | null>(null);
const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
watch(() => props.resource.token, () => {
  title.value = clean(props.resource.title);
  artist.value = props.resource.artist === "本地文件" ? "" : clean(props.resource.artist);
  album.value = props.resource.album || "";
  forceCopy.value = false;
}, { immediate: true });
watch([title, artist, album], () => emit("metadata", { title: title.value, artist: artist.value, album: album.value }), { immediate: true });
watch(forceCopy, value => emit("force", value), { immediate: true });
watch(() => [props.resource.token, props.choice, props.format, props.revision, props.skipMatch], async (_value, _previous, cleanup) => {
  saved.value = null;
  if (props.skipMatch) return;
  const controller = new AbortController();
  cleanup(() => controller.abort());
  try {
    const response = await fetch("/api/library/match", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: props.resource.token, choice: props.choice, format: props.format }),
      signal: controller.signal,
    });
    if (!response.ok) return;
    const result = await response.json();
    if (!controller.signal.aborted) saved.value = result.job;
  } catch { /* The save request still checks history. */ }
}, { immediate: true });
async function reveal() {
  if (saved.value) await fetch(`/api/jobs/${saved.value.id}/reveal`, { method: "POST" });
}
</script>

<template>
  <div v-if="saved" class="saved-match" role="status">
    <p><Check :size="16" />这一音质与格式已保存</p>
    <span>{{ saved.filename }}</span>
    <div class="match-actions">
      <a :href="`/api/jobs/${saved.id}/file`">打开已保存文件</a>
      <button class="text-button" @click="reveal"><FolderOpen :size="14" />显示位置</button>
    </div>
    <label><input v-model="forceCopy" type="checkbox" />仍保存副本，应用下方歌曲信息</label>
    <small v-if="!forceCopy">直接保存将复用历史文件，不会修改原文件信息。</small>
  </div>
  <details class="song-options" :open="resource.platform === 'local'">
    <summary>整理歌曲信息</summary>
    <label>歌曲标题<input v-model="title" maxlength="300" /></label>
    <label>{{ resource.platform === "douyin" || resource.platform === "bilibili" ? "作者 / 发布者" : "歌手" }}<input v-model="artist" maxlength="300" /></label>
    <label>专辑（可选）<input v-model="album" maxlength="300" placeholder="不确定时留空" /></label>
    <p>写入输出文件；命名与封面偏好可在设置中调整。</p>
  </details>
</template>

<style scoped>
.song-options { margin: 16px 0; border-top: 1px solid var(--line); padding-top: 14px; }
summary { cursor: pointer; font-size: 13px; font-weight: 600; }
.song-options label { display: grid; gap: 5px; margin-top: 13px; font-size: 12px; }
input:not([type="checkbox"]) { width: 100%; min-height: 38px; border: 1px solid var(--field-border); border-radius: 6px; padding: 8px; background: var(--field-surface); color: var(--ink); font: inherit; }
p, small { font-size: 12px; line-height: 1.6; }
.song-options p { color: var(--muted); }
.saved-match { margin-top: 16px; padding: 12px; background: var(--field-surface); border: 1px solid var(--line); border-radius: 8px; overflow-wrap: anywhere; }
.saved-match p { display: flex; gap: 6px; align-items: center; margin: 0 0 5px; font-weight: 600; }
.saved-match span, .saved-match label, .saved-match small { display: block; font-size: 12px; margin-top: 8px; }
.match-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 10px; font-size: 12px; }
.match-actions a { color: var(--accent); }
</style>
