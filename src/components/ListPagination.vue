<script setup lang="ts">
import { ChevronLeft, ChevronRight } from "@lucide/vue";

const page = defineModel<number>({ required: true });
defineProps<{ pageCount: number; label: string }>();
</script>

<template>
  <nav v-if="pageCount > 1" class="list-pagination" :aria-label="label">
    <button type="button" :disabled="page <= 1" @click="page--">
      <ChevronLeft :size="15" aria-hidden="true" />上一页
    </button>
    <span role="status">第 {{ page }} / {{ pageCount }} 页</span>
    <button type="button" :disabled="page >= pageCount" @click="page++">
      下一页<ChevronRight :size="15" aria-hidden="true" />
    </button>
  </nav>
</template>

<style scoped>
.list-pagination {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 7px 12px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.list-pagination button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 34px;
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--ink);
  white-space: nowrap;
}
.list-pagination button:hover:not(:disabled) { background: var(--field-surface); border-color: var(--field-border); }
.list-pagination button:focus-visible { outline-offset: 2px; }
</style>
