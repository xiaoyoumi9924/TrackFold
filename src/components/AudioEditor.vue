<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { X, Scissors, Play, Square, LoaderCircle } from "@lucide/vue";
import type { Job } from "../../shared/types";
import { originalAudioNote } from "../../shared/preferences";
const props = defineProps<{ job: Job; mode?: "clip" | "organize" }>();
const emit = defineEmits<{ close: []; saved: [Job] }>();
const dialog = ref<HTMLDialogElement>(),
  audio = ref<HTMLAudioElement>();
const start = ref(0),
  end = ref(props.job.duration || 0),
  fadeIn = ref(0),
  fadeOut = ref(0.5);
const organizing = props.mode === "organize";
const title = ref(organizing ? props.job.title : `${props.job.title}（片段）`),
  artist = ref(props.job.artist),
  album = ref(props.job.metadata?.album || "");
const outputDir = ref("");
const format = ref("mp3"),
  loop = ref(false),
  busy = ref(false),
  error = ref(""),
  playing = ref(false),
  waveformError = ref(false);
const sourceCodec = ref<string>(), checkingCodec = ref(false), codecError = ref("");
watch(format, async (selected, _, onCleanup) => {
  if (!organizing || selected !== "original" || sourceCodec.value) return;
  const controller = new AbortController();
  onCleanup(() => { controller.abort(); checkingCodec.value = false; });
  checkingCodec.value = true;
  codecError.value = "";
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(props.job.id)}/audio-codec`, { signal: controller.signal });
    const result = await response.json();
    if (!response.ok || typeof result.codec !== "string") throw new Error(result.error || "无法识别来源音轨。");
    sourceCodec.value = result.codec;
  } catch (cause) {
    if (!controller.signal.aborted) codecError.value = (cause as Error).message;
  } finally {
    if (!controller.signal.aborted) checkingCodec.value = false;
  }
});
const originalUnavailable = computed(() => format.value === "original" && (checkingCodec.value || !sourceCodec.value));
const duration = ref(props.job.duration || 0);
fadeOut.value = Math.min(0.5, duration.value / 4);
const length = computed(() => end.value - start.value);
const invalid = computed(
  () =>
    !title.value.trim() ||
    (!organizing &&
      (![start.value, end.value, fadeIn.value, fadeOut.value].every(
        Number.isFinite,
      ) ||
        start.value < 0 ||
        end.value > duration.value ||
        length.value < 0.1 ||
        fadeIn.value < 0 ||
        fadeOut.value < 0 ||
        fadeIn.value + fadeOut.value > length.value)),
);
const display = (value: number) =>
  `${Math.floor(value / 60)
    .toString()
    .padStart(2, "0")}:${(value % 60).toFixed(3).padStart(6, "0")}`;
let frame = 0;
function stop() {
  audio.value?.pause();
  playing.value = false;
  cancelAnimationFrame(frame);
  if (audio.value) audio.value.volume = 1;
}
function tick() {
  const el = audio.value;
  if (!el || !playing.value) return;
  if (el.currentTime >= end.value || el.ended) {
    if (loop.value) {
      el.currentTime = start.value;
      void el.play().catch(stop);
    } else {
      stop();
      return;
    }
  }
  const elapsed = el.currentTime - start.value,
    remaining = end.value - el.currentTime;
  el.volume = Math.max(
    0,
    Math.min(
      1,
      fadeIn.value ? elapsed / fadeIn.value : 1,
      fadeOut.value ? remaining / fadeOut.value : 1,
    ),
  );
  frame = requestAnimationFrame(tick);
}
async function preview() {
  if (invalid.value || !audio.value) return;
  stop();
  error.value = "";
  audio.value.currentTime = start.value;
  audio.value.volume = fadeIn.value ? 0 : 1;
  try {
    await audio.value.play();
    playing.value = true;
    tick();
  } catch {
    error.value = "音频暂时无法试听，请检查原文件是否仍存在。";
  }
}
function loaded() {
  if (!audio.value || !Number.isFinite(audio.value.duration)) return;
  duration.value = audio.value.duration;
  end.value = Math.min(end.value, duration.value);
}
async function save() {
  if (invalid.value || busy.value || originalUnavailable.value) return;
  stop();
  busy.value = true;
  error.value = "";
  try {
    const response = await fetch(`/api/jobs/${props.job.id}/${organizing ? "organize" : "clip"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: format.value,
        metadata: { title: title.value, artist: artist.value, album: album.value },
        clip: { start: start.value, end: end.value, fadeIn: fadeIn.value, fadeOut: fadeOut.value },
      }),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error);
    emit("saved", result);
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
onMounted(() => {
  dialog.value?.showModal();
  void fetch("/api/storage").then(response => response.json())
    .then(data => { outputDir.value = data.outputDir || ""; }).catch(() => {});
});
onUnmounted(stop);
</script>
<template>
  <dialog
    ref="dialog"
    class="audio-editor"
    aria-labelledby="clip-heading"
    @cancel.prevent="!busy && emit('close')"
  >
    <header>
      <div>
        <h2 id="clip-heading">
          {{ organizing ? "整理歌曲信息" : "截取音频片段" }}
        </h2>
        <p>{{ job.title }} · {{ display(duration) }}</p>
      </div>
      <button
        class="icon-button"
        aria-label="关闭片段编辑"
        :disabled="busy"
        @click="emit('close')"
      >
        <X :size="20" />
      </button>
    </header>
    <audio
      ref="audio"
      :src="`/api/jobs/${job.id}/audio`"
      preload="metadata"
      @loadedmetadata="loaded"
      @error="error = '原文件暂时不可读取，请关闭后重新定位文件。'"
    />
    <template v-if="!organizing">
      <div class="wave-area" aria-label="音频波形">
        <img
          v-if="!waveformError"
          :src="`/api/jobs/${job.id}/waveform`"
          alt="原音频的实际波形"
          @error="waveformError = true"
        />
        <p v-else>波形暂不可用，仍可设置时间并试听。</p>
        <div
          class="selection-area"
          :style="{
            left: `${(start / duration) * 100}%`,
            width: `${(Math.max(0, length) / duration) * 100}%`,
          }"
        ></div>
      </div>
      <div class="range-row">
        <label
          >起点 {{ display(start)
          }}<input
            v-model.number="start"
            type="range"
            min="0"
            :max="duration"
            step="0.01"
            @input="stop" /></label
        ><label
          >终点 {{ display(end)
          }}<input
            v-model.number="end"
            type="range"
            min="0"
            :max="duration"
            step="0.01"
            @input="stop"
        /></label>
      </div>
      <div class="editor-grid">
        <label
          >开始（秒）<input
            v-model.number="start"
            type="number"
            min="0"
            :max="duration"
            step="0.001"
            @input="stop" /></label
        ><label
          >结束（秒）<input
            v-model.number="end"
            type="number"
            min="0"
            :max="duration"
            step="0.001"
            @input="stop" /></label
        ><label
          >淡入（秒）<input
            v-model.number="fadeIn"
            type="number"
            min="0"
            :max="length"
            step="0.1"
            @input="stop" /></label
        ><label
          >淡出（秒）<input
            v-model.number="fadeOut"
            type="number"
            min="0"
            :max="length"
            step="0.1"
            @input="stop"
        /></label>
      </div>
      <div class="preview-actions">
        <button
          class="secondary"
          :disabled="invalid || busy"
          @click="playing ? stop() : preview()"
        >
          <Square v-if="playing" :size="15" /><Play v-else :size="15" />{{
            playing ? "停止试听" : "试听所选片段"
          }}</button
        ><label><input v-model="loop" type="checkbox" />循环试听</label
        ><span>选中 {{ Math.max(0, length).toFixed(3) }} 秒</span>
      </div>
      <p class="editor-note">
        试听包含淡入淡出。导出将精确截取并重新编码，原文件保留。
      </p>
    </template>
    <p v-else class="editor-note">
      另存包含新歌曲信息的副本；可选择保留来源音轨，原文件不变。
    </p>
    <div class="editor-grid metadata-grid">
      <label
        >{{ organizing ? "歌曲标题" : "片段标题"
        }}<input v-model="title" maxlength="300" /></label
      ><label>歌手 / 作者<input v-model="artist" maxlength="300" /></label
      ><label>专辑（可选）<input v-model="album" maxlength="300" /></label
      ><label
        >导出格式<select v-model="format" aria-label="导出格式">
          <option v-if="organizing" value="original">保留来源音轨</option>
          <option value="m4a">M4A</option>
          <option value="mp3">MP3</option>
          <option v-if="!organizing" value="wav">WAV · 剪辑素材</option>
        </select></label
      >
    </div>
    <p v-if="organizing && format === 'original'" class="editor-note" role="status">
      {{ checkingCodec ? "正在检测来源音轨…" : codecError || originalAudioNote(sourceCodec) }}
    </p>
    <p v-if="invalid" class="editor-issue" role="status">
      {{
        organizing
          ? "请填写歌曲标题。"
          : "请填写标题，选取至少 0.1 秒，并确保淡入淡出不超出片段范围。"
      }}
    </p>
    <p v-if="error" class="editor-issue" role="alert">{{ error }}</p>
    <footer>
      <span>保存到 {{ outputDir || "设置中的当前目录" }}</span>
      <button class="primary" :disabled="busy || invalid || originalUnavailable" @click="save">
        <LoaderCircle v-if="busy" :size="16" class="spin" /><Scissors
          v-else
          :size="16"
        />{{ busy ? "正在提交…" : organizing ? "另存整理版" : "导出新片段" }}
      </button>
    </footer>
  </dialog>
</template>
<style scoped>
.audio-editor {
  width: min(720px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  padding: 26px;
  margin: auto;
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--field-border);
  border-radius: 14px;
  overflow-y: auto;
}
.audio-editor::backdrop {
  background: var(--dialog-scrim);
}
header,
footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}
h2 {
  font-size: 17px;
  margin: 0;
}
header p {
  margin: 7px 0 0;
  max-width: 52ch;
  overflow-wrap: anywhere;
  font-size: 14px;
}
.wave-area {
  height: 115px;
  margin: 24px 0 14px;
  position: relative;
  background: var(--field-surface);
  border: 1px solid var(--line);
  overflow: hidden;
}
.wave-area img {
  width: 100%;
  height: 100%;
  object-fit: fill;
}
.wave-area p {
  padding: 20px;
  font-size: 14px;
}
.selection-area {
  position: absolute;
  inset-block: 0;
  background: rgb(255 144 119 / 12%);
  border-inline: 2px solid var(--accent);
  pointer-events: none;
}
.range-row,
.editor-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.range-row {
  margin-bottom: 18px;
}
.editor-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
label {
  display: grid;
  gap: 7px;
  font-size: 12px;
  font-weight: 500;
}
input:not([type="checkbox"]):not([type="range"]),
select {
  min-width: 0;
  width: 100%;
  min-height: 40px;
  border: 1px solid var(--field-border);
  padding: 8px;
  border-radius: 6px;
  font: inherit;
  background: var(--field-surface);
  color: var(--ink);
}
input[type="range"] {
  width: 100%;
  accent-color: var(--accent);
}
input[type="checkbox"] {
  accent-color: var(--accent);
}
.metadata-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin-top: 23px;
}
.preview-actions {
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 20px;
  font-size: 12px;
}
.preview-actions label {
  display: flex;
  align-items: center;
}
.editor-note,
footer span {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}
.editor-note {
  margin-top: 12px;
}
.editor-issue {
  color: var(--warm-error);
  font-size: 14px;
  line-height: 1.6;
  margin-top: 16px;
}
footer span {
  overflow-wrap: anywhere;
}
footer {
  position: sticky;
  bottom: -26px;
  background: var(--surface);
  padding-bottom: 8px;
  margin-top: 26px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
}
@media (max-width: 550px) {
  .audio-editor {
    padding: 18px;
  }
  footer {
    bottom: -18px;
  }
  .editor-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  footer {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
