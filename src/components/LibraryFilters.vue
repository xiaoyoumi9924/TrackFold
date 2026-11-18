<script setup lang="ts">
import { computed } from "vue";
import type { LibraryFilters } from "../../shared/library-filters";
import { emptyLibraryFilters } from "../../shared/library-filters";
const props = defineProps<{
  modelValue: LibraryFilters;
  groups: string[];
  hideSort?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [LibraryFilters] }>();
const filters = computed({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});
const active = computed(() =>
  Object.entries(emptyLibraryFilters).some(
    ([key, value]) => props.modelValue[key as keyof LibraryFilters] !== value,
  ),
);
</script>
<template>
  <section class="library-filters" aria-label="音频库筛选">
    <div class="filter-fields">
      <label
        >音频类型<select aria-label="音频类型" v-model="filters.kind">
          <option value="all">全部类型</option>
          <option value="full">完整音频</option>
          <option value="preview">平台试听</option>
          <option value="clip">截取片段</option>
          <option value="stem">分离音轨</option>
          <option value="unknown">完整性未知</option>
        </select></label
      >
      <label
        >来源平台<select aria-label="来源平台" v-model="filters.platform">
          <option value="all">全部来源</option>
          <option value="qishui">汽水音乐</option>
          <option value="douyin">抖音视频</option>
          <option value="bilibili">B 站</option>
          <option value="local">本地文件</option>
        </select></label
      >
      <label
        >文件状态<select aria-label="文件状态" v-model="filters.file">
          <option value="all">全部状态</option>
          <option value="available">文件可用</option>
          <option value="missing">文件缺失</option>
        </select></label
      >
      <label
        >文件格式<select aria-label="文件格式" v-model="filters.format">
          <option value="all">全部格式</option>
          <option value="mp3">MP3</option>
          <option value="m4a">M4A</option>
          <option value="flac">FLAC</option>
          <option value="wav">WAV</option>
        </select></label
      >
      <label
        >分组<select aria-label="分组" v-model="filters.group">
          <option value="">全部分组</option>
          <option v-for="group in groups" :key="group" :value="group">{{ group }}</option>
        </select></label
      >
      <label v-if="!hideSort"
        >排序<select aria-label="排序" v-model="filters.sort">
          <option value="newest">最近保存</option>
          <option value="oldest">最早保存</option>
          <option value="title">按标题</option>
          <option value="artist">按歌手 / 作者</option>
        </select></label
      >
    </div>
    <label class="favorite-filter"><input type="checkbox" v-model="filters.favoriteOnly" />只看收藏</label>
    <div v-if="active" class="filter-summary">
      <button
        class="text-button"
        @click="filters = { ...emptyLibraryFilters }"
      >
        清空筛选与搜索
      </button>
    </div>
  </section>
</template>
<style scoped>
.library-filters {
  margin: 14px 0 22px;
}
.filter-fields {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
}
label {
  display: grid;
  gap: 7px;
  color: var(--muted, #3b5a44);
  font-size: 12px;
}
select {
  min-height: 40px;
  width: 100%;
  min-width: 0;
  padding: 8px;
  border: 1px solid var(--line, #c7d1ca);
  border-radius: 6px;
  color: var(--ink, #253a32);
  background: var(--surface, #fff);
  font: inherit;
}
.favorite-filter { display:flex; align-items:center; gap:7px; margin-top:14px; font-size:13px; }
.favorite-filter input { accent-color:var(--accent, #2f6350); }
.filter-summary {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  align-items: center;
  margin-top: 13px;
  color: var(--muted, #56655a);
  font-size: 12px;
}
@media (max-width: 850px) {
  .filter-fields {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 550px) {
  .filter-fields {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  select {
    font-size: 16px;
  }
}
</style>
