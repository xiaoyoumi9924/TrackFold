<script setup lang="ts">
import { computed, nextTick, onDeactivated, ref, watch } from "vue";
import { ArrowDownUp, ChevronDown, Download, Ellipsis, FolderOpen, Heart, ListMusic, ListPlus, Music2, Pencil, Play, Plus, Scissors, Search, SlidersHorizontal, Tags, Trash2, X, AudioLines } from "@lucide/vue";
import { audioKind, emptyLibraryFilters, filterLibrary } from "../../shared/library-filters";
import type { Job } from "../../shared/types";
import AudioCover from "./AudioCover.vue";
import FileLocation from "./FileLocation.vue";
import LibraryFilters from "./LibraryFilters.vue";
import "./library-workspace.css";

type PlaylistAction = "create" | "rename" | "remove";
type LibraryAction = "favorite" | "group" | "clip" | "organize" | "separate" | "remove-record" | "reveal" | "folder" | "enqueue";
const props = defineProps<{
  jobs: Job[];
  groups: string[];
  updating: boolean;
  separating: ReadonlySet<string>;
  playing: string;
  paused: boolean;
  nativePicker: boolean;
  request: (url: string, options?: RequestInit) => Promise<unknown>;
  editPlaylist: (action: PlaylistAction, name: string, newName?: string) => Promise<void>;
  addToGroup: (ids: string[], action: "add-group" | "remove-group", name: string) => Promise<void>;
}>();
const emit = defineEmits<{
  action: [action: LibraryAction, job: Job];
  play: [jobs: Job[], start?: string];
  group: [ids: string[]];
  createAudio: [];
  refresh: [];
  notice: [text: string];
}>();

const filters = ref({ ...emptyLibraryFilters });
const advanced = ref(false);
const selecting = ref(false);
const selected = ref(new Set<string>());
const exportBusy = ref(false);
const exportResult = ref("");
const exportError = ref("");
const membershipTarget = ref("");
const membershipBusy = ref(false);
const sortList = ref<HTMLElement>();
const popup = ref<HTMLElement>();
const popupItem = ref<{ job: Job } | { playlist: string }>();
const playlistDialog = ref<HTMLDialogElement>();
const playlistMode = ref<PlaylistAction>("create");
const originalName = ref("");
const playlistName = ref("");
const playlistError = ref("");
const playlistBusy = ref(false);

const groupKey = (name: string) => name.normalize("NFC").trim().toLocaleLowerCase("zh-CN");
const audio = computed(() => props.jobs.filter(job => job.status === "completed"));
const featured = computed(() => filterLibrary(audio.value, { ...emptyLibraryFilters, group: filters.value.group, favoriteOnly: filters.value.favoriteOnly, sort: filters.value.sort }));
const favorites = computed(() => audio.value.filter(job => job.favorite));
const shown = computed(() => filterLibrary(audio.value, filters.value));
const playable = computed(() => shown.value.filter(job => job.fileExists !== false));
const collectionTitle = computed(() => filters.value.group || (filters.value.favoriteOnly ? "我喜欢的" : "全部歌曲"));
const hasFilters = computed(() => Object.keys(emptyLibraryFilters).some(key => key !== "sort" &&
  filters.value[key as keyof typeof emptyLibraryFilters] !== emptyLibraryFilters[key as keyof typeof emptyLibraryFilters]));
const playlistRows = computed(() => {
  const songs = new Map<string, Job[]>();
  for (const job of audio.value) for (const name of job.groups || []) {
    const key = groupKey(name);
    const matches = songs.get(key) || [];
    matches.push(job);
    songs.set(key, matches);
  }
  return props.groups.map(name => {
    const matches = songs.get(groupKey(name)) || [];
    return { name, count: matches.length, cover: matches.find(job => job.cover)?.cover };
  });
});
const artwork = computed(() => featured.value.filter(job => !!job.cover).slice(0, 3));
const kindLabels = { full: "完整音频", preview: "试听片段", clip: "截取片段", unknown: "完整性未知", stem: "分离音轨", normalized: "音量统一副本" };

watch(() => filters.value.group, () => { if (sortList.value) sortList.value.scrollTop = 0; });
watch(() => props.groups, groups => {
  if (filters.value.group && !groups.some(name => groupKey(name) === groupKey(filters.value.group))) filters.value.group = "";
});
watch(audio, tracks => {
  const ids = new Set(tracks.map(track => track.id));
  for (const id of selected.value) if (!ids.has(id)) selected.value.delete(id);
});
onDeactivated(closeMenu);

function chooseCollection(group = "", favoriteOnly = false) {
  filters.value = { ...emptyLibraryFilters, sort: filters.value.sort, group, favoriteOnly };
  closeMenu();
}
function coverAt(index: number) { return artwork.value[index]?.cover; }
function time(value?: number) {
  if (!value || !Number.isFinite(value)) return "—";
  const seconds = Math.floor(value);
  return [Math.floor(seconds / 60), seconds % 60].map(part => String(part).padStart(2, "0")).join(":");
}
function closeMenu() {
  if (popup.value?.matches(":popover-open")) popup.value.hidePopover();
}
async function openMenu(event: MouseEvent, item: { job: Job } | { playlist: string }) {
  const anchor = event.currentTarget as HTMLElement;
  if (popup.value?.matches(":popover-open") && (("job" in item && popupItem.value && "job" in popupItem.value && item.job.id === popupItem.value.job.id) ||
    ("playlist" in item && popupItem.value && "playlist" in popupItem.value && item.playlist === popupItem.value.playlist))) {
    closeMenu();
    return;
  }
  closeMenu();
  popupItem.value = item;
  await nextTick();
  if (!popup.value || !anchor.isConnected) return;
  const menu = popup.value as HTMLElement & { showPopover(options: { source: HTMLElement }): void };
  menu.showPopover({ source: anchor });
  const rect = anchor.getBoundingClientRect();
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, rect.right - width) + "px";
  menu.style.top = Math.max(8, rect.bottom + height + 8 > window.innerHeight ? rect.top - height - 6 : rect.bottom + 6) + "px";
}
function action(action: LibraryAction, job: Job) {
  closeMenu();
  emit("action", action, job);
}
function playTrack(job: Job) {
  closeMenu();
  emit("play", playable.value, job.id);
}
function beginPlaylist(mode: PlaylistAction, name = "") {
  closeMenu();
  playlistMode.value = mode;
  originalName.value = name;
  playlistName.value = name;
  playlistError.value = "";
  playlistDialog.value?.showModal();
  void nextTick(() => playlistDialog.value?.querySelector<HTMLInputElement>("input")?.focus());
}
async function savePlaylist() {
  const mode = playlistMode.value;
  if (playlistBusy.value || (mode !== "remove" && !playlistName.value.trim())) return;
  playlistBusy.value = true;
  playlistError.value = "";
  try {
    const name = playlistName.value.trim().normalize("NFC");
    await props.editPlaylist(mode, mode === "create" ? name : originalName.value, mode === "rename" ? name : undefined);
    if (mode === "create" || mode === "rename") chooseCollection(name);
    else if (filters.value.group === originalName.value) chooseCollection();
    playlistDialog.value?.close();
  } catch (error) {
    playlistError.value = (error as Error).message;
  } finally {
    playlistBusy.value = false;
  }
}
function startPicking(name = "") {
  closeMenu();
  if (name) chooseCollection();
  membershipTarget.value = name;
  selected.value = new Set();
  selecting.value = true;
  exportError.value = "";
  exportResult.value = "";
}
function stopPicking() {
  const target = membershipTarget.value;
  selecting.value = false;
  membershipTarget.value = "";
  selected.value = new Set();
  exportError.value = "";
  if (target && props.groups.includes(target)) chooseCollection(target);
}
const selectable = computed(() => shown.value.filter(job => membershipTarget.value || job.fileExists !== false));
const allSelected = computed(() => selectable.value.length > 0 && selectable.value.every(job => selected.value.has(job.id)));
const someSelected = computed(() => !allSelected.value && selectable.value.some(job => selected.value.has(job.id)));
const selectionBusy = computed(() => exportBusy.value || membershipBusy.value);
function toggleAll() {
  if (allSelected.value) {
    for (const job of selectable.value) selected.value.delete(job.id);
  } else {
    for (const job of selectable.value) selected.value.add(job.id);
  }
}
async function saveMembership() {
  const target = membershipTarget.value;
  if (!target || !selected.value.size || membershipBusy.value) return;
  membershipBusy.value = true;
  exportError.value = "";
  try {
    await props.addToGroup([...selected.value], "add-group", target);
    stopPicking();
    emit("notice", "已添加到歌单。");
  } catch (error) {
    exportError.value = (error as Error).message;
  } finally { membershipBusy.value = false; }
}
async function removeFromPlaylist(job: Job) {
  closeMenu();
  if (props.updating || !filters.value.group) return;
  try {
    await props.addToGroup([job.id], "remove-group", filters.value.group);
    emit("notice", "已从歌单移除。");
  } catch (error) { emit("notice", (error as Error).message); }
}
async function exportSelected(format: "m3u8" | "txt" | "bundle") {
  if (exportBusy.value || !selected.value.size) return;
  exportBusy.value = true;
  exportResult.value = "";
  exportError.value = "";
  try {
    const ids = filterLibrary(audio.value, { ...emptyLibraryFilters, sort: filters.value.sort }).filter(job => selected.value.has(job.id)).map(job => job.id);
    if (ids.length !== selected.value.size) throw new Error("部分所选记录已不可用，请重新选择。");
    const result = await props.request("/api/library/export", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids, format }),
    }) as { count: number; filePath: string };
    exportResult.value = `已导出${format === "bundle" ? "分享文件夹" : ""} ${result.count} 首：${result.filePath}`;
  } catch (error) { exportError.value = (error as Error).message; }
  finally { exportBusy.value = false; }
}
</script>

<template>
  <div class="library-workspace">
    <div class="page-heading">
      <h1>歌单</h1>
    </div>

    <div class="library-layout">
      <aside class="library-rail" aria-label="本地音频合集">
        <h2>音乐库</h2>

        <div class="library-collections" role="group" aria-label="音频集合">
          <button :aria-pressed="!filters.group && !filters.favoriteOnly" @click="chooseCollection()">
            <Music2 :size="23" aria-hidden="true" /><span>全部歌曲</span><span>{{ audio.length }}</span>
          </button>
          <button :aria-pressed="!filters.group && filters.favoriteOnly" @click="chooseCollection('', true)">
            <Heart :size="23" aria-hidden="true" /><span>我喜欢的</span><span>{{ favorites.length }}</span>
          </button>
        </div>

        <div class="library-groups-heading">
          <h3>我的歌单</h3>
          <button class="secondary library-create" aria-label="创建歌单" @click="beginPlaylist('create')"><Plus :size="16" />新建</button>
        </div>
        <p v-if="!playlistRows.length" class="library-groups-empty">暂无歌单</p>
        <div v-for="playlist in playlistRows" :key="playlist.name" class="library-rail-playlist">
          <button class="library-collection-link" :aria-pressed="filters.group === playlist.name" @click="chooseCollection(playlist.name)">
            <AudioCover :src="playlist.cover" />
            <span><strong :title="playlist.name">{{ playlist.name }}</strong><small>{{ playlist.count }} 首</small></span>
          </button>
          <button class="icon-button" :aria-label="'操作歌单 ' + playlist.name" @click="openMenu($event, { playlist: playlist.name })"><Ellipsis :size="20" /></button>
        </div>
      </aside>

      <div class="library-main">
        <section class="library-hero" aria-labelledby="collection-title">
          <div class="library-artwork" aria-hidden="true">
            <div class="library-artwork-card left"><AudioCover v-if="coverAt(1)" :src="coverAt(1)" /></div>
            <div class="library-artwork-card right"><AudioCover v-if="coverAt(2)" :src="coverAt(2)" /></div>
            <div class="library-artwork-card front"><AudioCover v-if="coverAt(0)" :src="coverAt(0)" /></div>
          </div>
          <div class="library-hero-content">
            <h2 id="collection-title">{{ collectionTitle }}</h2>
            <p>{{ featured.length }} 首歌曲</p>
            <div class="library-hero-actions">
              <button v-if="featured.length || !filters.group" class="primary library-play-all" :disabled="!playable.length" @click="emit('play', playable)"><Play :size="18" fill="currentColor" />播放全部</button>
              <button v-if="filters.group && !membershipTarget" :class="[featured.length ? 'secondary' : 'primary', 'library-add']" :disabled="selecting" @click="audio.length ? startPicking(filters.group) : emit('createAudio')"><ListPlus :size="17" />添加歌曲</button>
            </div>
          </div>
        </section>

        <div class="library-list-toolbar">
          <div class="library-list-heading"><h2>歌曲列表</h2><span v-if="shown.length !== featured.length">{{ shown.length }} 首匹配</span></div>
          <div class="library-tools">
            <div class="library-search">
          <Search :size="20" aria-hidden="true" />
          <input v-model="filters.query" :placeholder="filters.group || filters.favoriteOnly ? '搜索当前歌单' : '搜索歌曲、歌手'" aria-label="搜索音频库" />
          <button v-if="filters.query" class="icon-button" aria-label="清空搜索" @click="filters.query = ''"><X :size="16" /></button>
        </div>
            <label class="library-sort">
              <ArrowDownUp :size="19" aria-hidden="true" />
              <select v-model="filters.sort" aria-label="排序">
                <option value="newest">按添加时间</option><option value="oldest">最早保存</option>
                <option value="title">按标题</option><option value="artist">按歌手 / 作者</option>
              </select>
              <ChevronDown class="select-arrow" :size="16" aria-hidden="true" />
            </label>
            <button class="secondary library-filter-button" type="button" aria-controls="library-filters" :aria-expanded="advanced" @click="advanced = !advanced"><SlidersHorizontal :size="17" />筛选</button>
            <button class="secondary library-select-button" type="button" :aria-pressed="selecting && !membershipTarget" :disabled="!audio.length || !!membershipTarget || exportBusy" @click="selecting ? stopPicking() : startPicking()">{{ selecting && !membershipTarget ? "退出多选" : "多选" }}</button>
          </div>
        </div>

        <div v-if="advanced" id="library-filters" class="library-advanced">
          <LibraryFilters v-model="filters" :groups="groups" hide-sort />
        </div>

        <div v-if="selecting" class="library-selection">
          <p v-if="membershipTarget">为「{{ membershipTarget }}」选择歌曲。</p>
          <div class="library-export-actions">
            <label class="library-select-all">
              <input type="checkbox" :checked="allSelected" :indeterminate="someSelected" :disabled="selectionBusy || !selectable.length" @change="toggleAll" />
              全选
            </label>
            <span class="library-selected-count" role="status">已选 {{ selected.size }} 首</span>
            <button v-if="selected.size" class="text-button" :disabled="selectionBusy" @click="selected = new Set()">清空选择</button>
            <button v-if="membershipTarget" class="primary" :disabled="membershipBusy || !selected.size || updating" @click="saveMembership">添加所选歌曲</button>
            <template v-else-if="selected.size">
              <button class="secondary" :disabled="exportBusy || updating || !selected.size" @click="emit('group', [...selected])">整理分组</button>
              <button class="secondary" :disabled="exportBusy || !selected.size" @click="exportSelected('m3u8')">导出播放列表</button>
              <button class="secondary" :disabled="exportBusy || !selected.size" @click="exportSelected('txt')">导出歌曲清单</button>
              <button class="secondary" :disabled="exportBusy || !selected.size" @click="exportSelected('bundle')">导出分享文件夹</button>
            </template>
            <button class="text-button" :disabled="exportBusy || membershipBusy" @click="stopPicking">完成选择</button>
          </div>
          <p v-if="exportBusy" role="status">正在导出，请保持拾音打开。</p>
          <p v-if="exportResult" class="batch-detail" role="status">{{ exportResult }}</p>
          <p v-if="exportError" class="library-error" role="alert">{{ exportError }}</p>
        </div>

        <section ref="sortList" class="library-songs" aria-label="歌曲列表" tabindex="0" @scroll="closeMenu">
          <div class="library-table-head" aria-hidden="true"><span>#</span><span>歌曲</span><span>歌手</span><span>时长</span><span>类型</span><span></span></div>
          <div v-if="!shown.length" class="library-songs-empty">
            <Music2 :size="27" :stroke-width="1.5" aria-hidden="true" />
            <div><h3>{{ !audio.length ? "还没有保存的音频" : featured.length ? "没有匹配的结果" : filters.group ? "歌单还没有歌曲" : "还没有收藏的歌曲" }}</h3>
            <p>{{ !audio.length ? "先提取或导入音频，保存后就会出现在这里。" : featured.length ? "试试其他关键词，或清空筛选条件。" : filters.group ? "可以从本地音频合集中添加歌曲。" : "点击歌曲旁的心形按钮即可收藏。" }}</p></div>
            <button v-if="!audio.length" class="secondary" @click="emit('createAudio')">添加声音</button>
            <button v-else-if="featured.length && hasFilters" class="secondary" @click="chooseCollection(filters.group, filters.favoriteOnly && !!featured.length)">清空筛选</button>
          </div>

          <article v-for="(job, index) in shown" :key="job.id" class="job-row library-row library-song" :class="{ 'is-playing': playing === job.id && !paused, 'is-selected': selecting && selected.has(job.id) }">
            <div class="library-index">
              <input v-if="selecting" v-model="selected" class="library-select" type="checkbox" :value="job.id" :disabled="exportBusy || membershipBusy || (!membershipTarget && job.fileExists === false && !selected.has(job.id))" :aria-label="`选择音频 ${job.title}`" />
              <span v-else>{{ index + 1 }}</span>
            </div>
            <h3 class="library-song-title" :title="job.title" :aria-label="job.title">
              <button :disabled="job.fileExists === false" :aria-label="`播放音频 ${job.title}`" @click="playTrack(job)">
                <span class="library-song-art"><AudioCover :src="job.cover" /><span class="library-song-play" aria-hidden="true"><Play :size="17" fill="currentColor" /></span></span>
                <span>{{ job.title }}</span>
              </button>
            </h3>
            <div class="library-artist" :title="job.artist">{{ job.artist || "—" }}</div>
            <div class="library-length">{{ time(job.duration) }}</div>
            <div class="library-kind">
              <span class="library-kind-badge" :class="audioKind(job)">{{ kindLabels[audioKind(job)] }}</span>
              <span v-if="job.fileExists === false" class="library-file-missing">文件缺失</span>
            </div>
            <div class="library-song-actions">
              <button class="icon-button library-heart" :class="{ selected: job.favorite }" :aria-label="job.favorite ? '取消收藏' : '收藏音频'" :aria-pressed="!!job.favorite" :disabled="updating" @click="action('favorite', job)">
                <Heart :size="23" :fill="job.favorite ? 'currentColor' : 'none'" />
              </button>
              <button class="icon-button" aria-label="更多歌曲操作" @click="openMenu($event, { job })"><Ellipsis :size="23" /></button>
            </div>
            <FileLocation v-if="job.fileExists === false" :job="job" :native-picker="nativePicker" @changed="emit('refresh')" />
          </article>
        </section>
      </div>
    </div>

    <div ref="popup" popover class="library-popup" aria-label="歌单操作">
      <template v-if="popupItem && 'playlist' in popupItem">
        <button @click="startPicking(popupItem.playlist)"><ListPlus :size="16" />添加歌曲</button>
        <button @click="beginPlaylist('rename', popupItem.playlist)"><Pencil :size="16" />重命名歌单</button>
        <button @click="beginPlaylist('remove', popupItem.playlist)"><Trash2 :size="16" />删除歌单</button>
      </template>
      <template v-else-if="popupItem && 'job' in popupItem">
        <template v-if="popupItem.job.fileExists !== false">
          <button aria-label="播放音频" @click="playTrack(popupItem.job)"><Play :size="16" />播放音频</button>
          <button @click="action('enqueue', popupItem.job)"><ListPlus :size="16" />加入播放队列</button>
          <button @click="action('reveal', popupItem.job)"><FolderOpen :size="16" />在文件夹中显示</button>
          <a :href="`/api/jobs/${encodeURIComponent(popupItem.job.id)}/file`" @click="closeMenu"><Download :size="16" />下载音频文件</a>
          <button @click="action('clip', popupItem.job)"><Scissors :size="16" />截取音频片段</button>
          <button @click="action('organize', popupItem.job)"><Tags :size="16" />整理歌曲信息</button>
          <button :disabled="separating.has(popupItem.job.id)" @click="action('separate', popupItem.job)"><AudioLines :size="16" />分离人声和伴奏</button>
        </template>
        <button v-else @click="action('folder', popupItem.job)"><FolderOpen :size="16" />打开原目录</button>
        <button :disabled="updating" :aria-label="`整理分组 ${popupItem.job.title}`" @click="action('group', popupItem.job)"><ListMusic :size="16" />加入或整理歌单</button>
        <button v-if="filters.group" :disabled="updating" @click="removeFromPlaylist(popupItem.job)"><X :size="16" />从当前歌单移除</button>
        <button @click="action('remove-record', popupItem.job)"><X :size="16" />移除记录</button>
        <p v-if="popupItem.job.warning">{{ popupItem.job.warning }}</p>
      </template>
    </div>

    <dialog ref="playlistDialog" class="library-playlist-dialog" aria-labelledby="playlist-dialog-title" @cancel.prevent="!playlistBusy && playlistDialog?.close()">
      <form @submit.prevent="savePlaylist">
        <h2 id="playlist-dialog-title">{{ playlistMode === "create" ? "创建歌单" : playlistMode === "rename" ? "重命名歌单" : "删除歌单" }}</h2>
        <p v-if="playlistMode === 'remove'">删除「{{ originalName }}」后，歌曲仍保留在本地音频合集中。</p>
        <label v-else>歌单名称<input v-model="playlistName" maxlength="60" required placeholder="例如：通勤时光" :disabled="playlistBusy" /></label>
        <p v-if="playlistError" role="alert" class="library-error">{{ playlistError }}</p>
        <div class="library-dialog-actions">
          <button type="button" class="secondary" :disabled="playlistBusy" @click="playlistDialog?.close()">取消</button>
          <button class="primary" :disabled="playlistBusy || (playlistMode !== 'remove' && !playlistName.trim())">
            {{ playlistBusy ? "正在保存…" : playlistMode === "create" ? "创建" : playlistMode === "rename" ? "保存名称" : "删除歌单" }}
          </button>
        </div>
      </form>
    </dialog>
  </div>
</template>
