<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { ArrowLeft, ListChecks, Search, LoaderCircle, Music2, Play, ListPlus, RotateCw, X } from "@lucide/vue";
import type { Batch, PlaylistImport, PlaylistTrack } from "../../shared/types";
import { savedOutputFormat } from "../default-format";

type Item = PlaylistTrack & { album?: string; count?: number };
const props = defineProps<{ initialPlaylist: string; localPlaying: boolean }>();
const emit = defineEmits<{ song: [id: string]; batch: [id: string]; settings: []; playback: [] }>();
const tab = ref<"search" | "mine">("search");
const keyword = ref("");
const items = ref<Item[]>([]);
const busy = ref(false);
const error = ref("");
const loaded = ref(false);
const complete = ref(true);
const playlistInput = ref("");
const playlist = ref<PlaylistImport | null>(null);
const selecting = ref(false);
const selected = ref(new Map<string, PlaylistTrack>());
const submitting = ref(false);
const selectionLimit = 500;
const tracks = computed(() => playlist.value?.tracks ?? (tab.value === "search" ? items.value : []));
const allSelected = computed(() => !!tracks.value.length && tracks.value.every(track => selected.value.has(track.id)));
const someSelected = computed(() => !allSelected.value && tracks.value.some(track => selected.value.has(track.id)));
const musicTitle = computed(() => playlist.value?.source.title || (keyword.value.trim() ? `搜索 · ${keyword.value.trim()}` : "汽水音乐"));
const liked = computed(() => items.value.find(item => /^(我喜欢的音乐|我喜欢|喜欢的音乐)$/.test(item.title.trim())));
const myPlaylists = computed(() => liked.value
  ? [liked.value, ...items.value.filter(item => item.id !== liked.value?.id)]
  : items.value);
let request: AbortController | undefined;
let submittingController: AbortController | undefined;
const previewTrack = ref<PlaylistTrack>();
const previewUrl = ref("");
const previewBusy = ref(false);
const previewError = ref("");
const activePreviewAction = computed(() => previewError.value ? "重试" : "停止");
let previewRequest: AbortController | undefined;
const previewAudio = ref<HTMLAudioElement>();
watch(() => props.localPlaying, playing => { if (playing) previewAudio.value?.pause(); });

function post(body: object, signal?: AbortSignal): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal };
}
async function json<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "暂时无法读取，请稍后重试。");
  return data;
}
function cancelLoad() {
  request?.abort();
  request = undefined;
  busy.value = false;
  error.value = "";
}
function closePlaylist() {
  cancelLoad();
  stopPreview();
  playlistInput.value = "";
  playlist.value = null;
}
function switchTab(next: typeof tab.value) {
  if (next === tab.value && !playlistInput.value) return;
  closePlaylist();
  if (next === tab.value) return;
  tab.value = next;
  items.value = [];
  loaded.value = false;
  if (next === "mine") void load();
}
async function fetchList<T>(operation: (signal: AbortSignal) => Promise<T>, apply: (data: T) => void) {
  cancelLoad();
  const controller = new AbortController();
  request = controller;
  busy.value = true;
  try {
    const data = await operation(controller.signal);
    if (!controller.signal.aborted) apply(data);
  } catch (cause) {
    if (!controller.signal.aborted) error.value = (cause as Error).message;
  } finally {
    if (request === controller) { request = undefined; busy.value = false; }
  }
}
async function openPlaylist(input: string) {
  playlistInput.value = input;
  playlist.value = null;
  await fetchList(signal => json<PlaylistImport>("/api/playlists", post({ input, browse: true }, signal)), data => { playlist.value = data; });
}
async function load() {
  if (busy.value || (tab.value === "search" && !keyword.value.trim())) return;
  const search = tab.value === "search";
  loaded.value = false;
  await fetchList(signal => json<{ items: Item[]; complete?: boolean }>(
    search ? "/api/discovery/search" : "/api/discovery/my-playlists",
    search ? post({ keyword: keyword.value.trim() }, signal) : { signal },
  ), data => {
    items.value = data.items;
    complete.value = data.complete !== false;
    loaded.value = true;
  });
}
function selectTrack(track: PlaylistTrack, checked: boolean) {
  if (!checked) selected.value.delete(track.id);
  else if (selected.value.size < selectionLimit) selected.value.set(track.id, track);
}
function toggleAll() {
  const checked = !allSelected.value;
  for (const track of tracks.value) selectTrack(track, checked);
}
async function submit() {
  if (!selected.value.size || submitting.value) return;
  submitting.value = true;
  error.value = "";
  const controller = new AbortController();
  submittingController = controller;
  try {
    const batch = await json<Batch>("/api/discovery/batches", post({
      tracks: [...selected.value.values()], title: musicTitle.value, format: savedOutputFormat(), allowPreview: true,
    }, controller.signal));
    if (controller.signal.aborted) return;
    selected.value.clear();
    selecting.value = false;
    emit("batch", batch.id);
  } catch (cause) {
    if (!controller.signal.aborted) error.value = (cause as Error).message;
  } finally {
    submitting.value = false;
    submittingController = undefined;
  }
}
function stopPreview() {
  previewRequest?.abort();
  previewRequest = undefined;
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = "";
  previewTrack.value = undefined;
  previewBusy.value = false;
  previewError.value = "";
}
async function preview(track: PlaylistTrack) {
  const shouldStop = previewTrack.value?.id === track.id && !previewError.value;
  stopPreview();
  if (shouldStop) return;
  previewTrack.value = track;
  const controller = new AbortController();
  previewRequest = controller;
  previewBusy.value = true;
  try {
    const response = await fetch("/api/discovery/preview", post({ id: track.id }, controller.signal));
    if (!response.ok) throw new Error((await response.json()).error || "试听暂不可用。");
    const audio = await response.blob();
    if (!controller.signal.aborted) {
      emit("playback");
      previewUrl.value = URL.createObjectURL(audio);
    }
  } catch (cause) {
    if (!controller.signal.aborted) previewError.value = (cause as Error).message;
  } finally {
    if (previewRequest === controller) { previewRequest = undefined; previewBusy.value = false; }
  }
}
onMounted(() => { if (props.initialPlaylist) void openPlaylist(props.initialPlaylist); });
onUnmounted(() => { cancelLoad(); stopPreview(); submittingController?.abort(); });
const time = (n: number) => n ? `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}` : "时长未知";
</script>

<template>
  <section class="discovery" aria-labelledby="qishui-discovery-title">
    <h2 id="qishui-discovery-title">搜索与歌单</h2>
    <div class="discovery-tabs" role="group" aria-label="汽水音乐功能">
      <button :disabled="submitting" :aria-pressed="tab === 'search'" @click="switchTab('search')">搜索歌曲</button>
      <button :disabled="submitting" :aria-pressed="tab === 'mine'" @click="switchTab('mine')">我的歌单</button>
      <button :disabled="submitting" @click="emit('settings')">账号设置</button>
    </div>
    <button v-if="playlistInput" class="text-button discovery-back" :disabled="submitting" @click="closePlaylist">
      <ArrowLeft :size="16" aria-hidden="true" />{{ tab === "mine" ? "返回歌单" : "返回搜索" }}
    </button>
    <form v-if="!playlistInput && tab === 'search'" class="search-row" @submit.prevent="load">
      <label class="sr-only" for="qishui-keyword">歌名或歌手</label>
      <input id="qishui-keyword" v-model="keyword" maxlength="100" placeholder="输入歌名或歌手" />
      <button class="primary" :disabled="busy || !keyword.trim()"><LoaderCircle v-if="busy" :size="16" class="spin" /><Search v-else :size="16" />搜索</button>
    </form>
    <div v-else-if="!playlistInput && (busy || error || (loaded && !complete))" class="discovery-account">
      <p v-if="busy" role="status">正在读取歌单…</p>
      <button v-else-if="error || (loaded && !complete)" class="secondary" @click="load">重新读取</button>
    </div>
    <p v-if="busy && playlistInput" role="status">正在读取歌单…</p>
    <p v-if="error" class="discovery-error" role="alert">{{ error }}</p>
    <button v-if="playlistInput && error && !playlist" class="secondary" @click="openPlaylist(playlistInput)">重试</button>
    <p v-if="loaded && !items.length && !playlistInput" role="status">没有找到可显示的{{ tab === "search" ? "歌曲" : "歌单" }}。</p>
    <p v-if="loaded && !complete && !playlistInput" role="status">歌单列表未读取完，请稍后重试。</p>
    <div v-if="playlist || tracks.length || (selecting && selected.size)" class="discovery-list-heading">
      <div class="discovery-list-title">
        <h3 v-if="playlist">{{ playlist.source.title }}</h3>
        <h3 v-else-if="tracks.length">搜索结果</h3>
        <small v-if="tracks.length">{{ tracks.length }} 首</small>
      </div>
      <button v-if="tracks.length || selected.size" class="secondary" :aria-pressed="selecting" :disabled="submitting" @click="selecting = !selecting">
        <ListChecks :size="16" aria-hidden="true" />{{ selecting ? "退出多选" : "多选" }}
      </button>
    </div>
    <p v-if="playlist && !playlist.source.reachedEnd">{{ playlist.source.notice }}</p>
    <p v-if="playlist && !tracks.length">歌单暂无可查看的歌曲。</p>
    <div v-if="selecting && (tracks.length || selected.size)" class="discovery-selection">
      <div class="discovery-selection-status">
        <label v-if="tracks.length"><input type="checkbox" :checked="allSelected" :indeterminate="someSelected"
          :disabled="submitting || (selected.size >= selectionLimit && !allSelected)" @change="toggleAll" />全选当前结果</label>
        <span role="status">已选 {{ selected.size }} 首<template v-if="selected.size >= selectionLimit"> · 已达每批 {{ selectionLimit }} 首上限</template></span>
        <button v-if="selected.size" class="text-button" :disabled="submitting" @click="selected.clear()">清空</button>
      </div>
      <button class="primary discovery-submit" :disabled="!selected.size || submitting" @click="submit">
        <LoaderCircle v-if="submitting" :size="16" class="spin" /><ListPlus v-else :size="17" />解析并下载
      </button>
      <p class="discovery-save-help">完整音频和平台试听会自动保存。</p>
    </div>

    <div v-if="previewTrack" class="discovery-preview" aria-label="在线试听">
      <div><strong>{{ previewTrack.title }}</strong><p>{{ previewBusy ? "正在载入试听…" : "在线试听 · 最长 60 秒" }}</p></div>
      <audio v-if="previewUrl" ref="previewAudio" :src="previewUrl" controls autoplay aria-label="试听播放器" @play="emit('playback')" @error="previewError = '暂时无法播放，请重新试听。'" />
      <button class="icon-button" aria-label="关闭试听" @click="stopPreview"><X :size="18" /></button>
      <p v-if="previewError" class="discovery-error" role="alert">{{ previewError }}</p>
    </div>

    <ul v-if="tracks.length" class="discovery-list">
      <li v-for="track in tracks" :key="track.id" class="discovery-song" :class="{ selected: selecting && selected.has(track.id) }">
        <input v-if="selecting" type="checkbox" :checked="selected.has(track.id)" :disabled="submitting || (selected.size >= selectionLimit && !selected.has(track.id))"
          :aria-label="'选择 ' + track.title" @change="selectTrack(track, ($event.target as HTMLInputElement).checked)" />
        <Music2 v-else :size="18" aria-hidden="true" />
        <div class="discovery-song-name"><strong>{{ track.title }}</strong><p>{{ track.artist || "未知歌手" }} · {{ time(track.duration) }}</p></div>
        <div class="discovery-song-actions">
          <button class="secondary discovery-listen" :aria-label="(previewTrack?.id === track.id ? activePreviewAction + '试听 ' : '试听 ') + track.title" @click="preview(track)">
            <LoaderCircle v-if="previewTrack?.id === track.id && previewBusy" :size="15" class="spin" />
            <RotateCw v-else-if="previewTrack?.id === track.id && previewError" :size="15" />
            <X v-else-if="previewTrack?.id === track.id" :size="15" /><Play v-else :size="15" />{{ previewTrack?.id === track.id ? activePreviewAction : "试听" }}
          </button>
          <button v-if="!selecting" class="secondary" @click="emit('song', track.id)">选择歌曲</button>
        </div>
      </li>
    </ul>

    <template v-if="tab === 'mine' && !playlistInput">
      <ul v-if="items.length" class="discovery-list">
        <li v-for="item in myPlaylists" :key="item.id" class="discovery-song">
          <Music2 :size="18" aria-hidden="true" />
          <div class="discovery-song-name"><strong>{{ item.title }}</strong><p>{{ item.count === undefined ? "歌曲数量未知" : `${item.count} 首` }}</p></div>
          <button class="secondary" :disabled="busy" @click="openPlaylist(item.id)">{{ item.id === liked?.id ? "打开我喜欢" : "打开歌单" }}</button>
        </li>
      </ul>
    </template>
  </section>
</template>

<style>
.discovery { padding: 19px 0; }
.discovery h2 { margin: 0; font-size: 17px; }
.discovery p { color: var(--muted); line-height: 1.5; margin: 7px 0; }
.discovery-tabs { display: flex; flex-wrap: wrap; column-gap: 16px; margin: 10px 0 15px; border-bottom: 1px solid var(--line); }
.discovery-tabs button { padding: 9px 2px; color: var(--muted); white-space: nowrap; }
.discovery-tabs button:hover { color: var(--ink); }
.discovery-tabs button[aria-pressed="true"] { color: var(--accent); box-shadow: inset 0 -2px var(--accent); font-weight: 600; }
.discovery .search-row, .discovery-account, .discovery-list-heading, .discovery-list-title { display: flex; align-items: center; gap: 10px; }
.discovery-account, .discovery-list-heading { justify-content: space-between; }
.discovery .discovery-back { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; }
.discovery-list-heading { margin-top: 14px; }
.discovery-list-heading button { flex: none; }
.discovery-list-title { min-width: 0; align-items: baseline; flex-wrap: wrap; gap: 2px 9px; }
.discovery-list-title h3 { font-size: 16px; overflow-wrap: anywhere; }
.discovery-list-title small { color: var(--muted); white-space: nowrap; }
.discovery .search-row input { flex: 1; min-width: 0; padding: 9px 11px; border: 1px solid var(--field-border); color: var(--ink); background: var(--field-surface); border-radius: 8px; font: inherit; }
.discovery .secondary { min-height: 34px; padding: 5px 9px; border-radius: 9px; white-space: nowrap; }
.discovery .discovery-error { color: var(--warm-error); overflow-wrap: anywhere; }
.discovery-selection, .discovery-preview { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; margin-top: 12px; padding: 9px 12px; background: #342825; border: 1px solid var(--line); border-radius: 11px; }
.discovery-selection { justify-content: space-between; padding: 8px 10px; }
.discovery-selection-status { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; }
.discovery-selection label { display: inline-flex; align-items: center; gap: 6px; }
.discovery-selection input, .discovery-song > input { accent-color: var(--accent); width: 16px; height: 16px; flex: none; }
.discovery-selection-status > span { font-size: 13px; color: var(--muted); }
.discovery-selection .discovery-submit { margin-left: auto; padding: 5px 12px; }
.discovery .discovery-save-help { flex-basis: 100%; margin: 0; }
.discovery-preview > div { flex: 1 1 145px; min-width: 0; overflow-wrap: anywhere; }
.discovery-preview audio { flex: 1 1 200px; min-width: 0; height: 39px; }
.discovery-preview p { margin: 2px 0 0; }
.discovery-preview [role="alert"] { width: 100%; }
.discovery-list { list-style: none; margin: 12px 0 0; padding: 0; max-height: min(480px, 58vh); overflow-y: auto; scrollbar-width: thin; }
.discovery-song { display: flex; align-items: center; gap: 10px; min-height: 58px; border-top: 1px solid var(--line); padding: 8px 6px; }
.discovery-song.selected { background: #3e2d28; }
.discovery-song > svg { flex: none; }
.discovery-song .discovery-song-name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.discovery-song strong { font-size: 14px; }
.discovery-song p { margin: 3px 0 0; }
.discovery-song-actions { display: flex; gap: 6px; }
@media (max-width: 550px) {
  .discovery-song { flex-wrap: wrap; gap: 6px; }
  .discovery-song .discovery-song-name { flex-basis: 130px; }
  .discovery-song-actions { margin-left: auto; }
  .discovery-preview audio { order: 3; flex-basis: 100%; }
  .discovery-preview [role="alert"] { order: 4; }
}
</style>
