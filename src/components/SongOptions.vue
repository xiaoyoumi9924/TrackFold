<script setup lang="ts">
import { ref, watch } from "vue";
import type { Resource, Job, AudioMetadata } from "../../shared/types";

const props = defineProps<{ resource: Resource; choice: string; format: string; revision: number; expanded: boolean }>();
const emit = defineEmits<{ metadata: [AudioMetadata]; force: [boolean] }>();
const title = ref(""), artist = ref(""), album = ref(""), forceCopy = ref(false), saved = ref(false);
const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
watch(() => props.resource.token, () => {
  title.value = clean(props.resource.title);
  artist.value = props.resource.artist === "本地文件" ? "" : clean(props.resource.artist);
  album.value = props.resource.album || "";
  forceCopy.value = false;
}, { immediate: true });
watch([title, artist, album], () => emit("metadata", { title: title.value, artist: artist.value, album: album.value }), { immediate: true });
watch(forceCopy, value => emit("force", value), { immediate: true });
watch(() => [props.resource.token, props.choice, props.format, props.revision], async (_value, _previous, cleanup) => {
  saved.value = false;
  if (_previous && (_value[0] !== _previous[0] || _value[1] !== _previous[1] || _value[2] !== _previous[2]))
    forceCopy.value = false;
  const controller = new AbortController();
  cleanup(() => controller.abort());
  try {
    const response = await fetch("/api/library/match", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: props.resource.token, choice: props.choice, format: props.format }),
      signal: controller.signal,
    });
    if (!response.ok) return;
    const result: { job: Job | null } = await response.json();
    if (!controller.signal.aborted) {
      saved.value = !!result.job;
      if (!saved.value) forceCopy.value = false;
    }
  } catch { /* The save request still checks history. */ }
}, { immediate: true });
</script>

<template>
  <div id="extraction-song-options" v-show="expanded" class="song-options">
    <label>歌曲标题<input v-model="title" maxlength="300" /></label>
    <label>{{ resource.platform === "douyin" || resource.platform === "bilibili" ? "作者 / 发布者" : "歌手" }}<input v-model="artist" maxlength="300" /></label>
    <label>专辑（可选）<input v-model="album" maxlength="300" placeholder="不确定时留空" /></label>
    <p>歌曲信息会写入保存的音频。</p>
    <label v-if="saved" class="song-copy"><input v-model="forceCopy" type="checkbox" />另存副本并应用歌曲信息</label>
  </div>
</template>

<style scoped>
.song-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px 12px; margin-top: 10px; }
.song-options label { display: grid; gap: 5px; min-width: 0; font-size: 12px; }
.song-options > :first-child, .song-options p { grid-column: 1 / -1; }
input:not([type="checkbox"]) { width: 100%; min-height: 38px; border: 1px solid var(--field-border); border-radius: 6px; padding: 8px; background: var(--field-surface); color: var(--ink); font: inherit; }
.song-options p { color: var(--muted); font-size: 12px; line-height: 1.6; }
.song-options .song-copy { grid-column: 1 / -1; display: flex; align-items: center; }
.song-copy input { accent-color: var(--accent); }
</style>
