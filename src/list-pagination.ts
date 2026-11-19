import { computed, ref, watch, type Ref } from "vue";

const pageSize = 10;

export function useListPagination<T>(items: Readonly<Ref<readonly T[]>>) {
  const page = ref(1);
  const pageCount = computed(() => Math.max(1, Math.ceil(items.value.length / pageSize)));
  const offset = computed(() => (page.value - 1) * pageSize);
  const pageItems = computed(() => items.value.slice(offset.value, offset.value + pageSize));

  watch(pageCount, count => { if (page.value > count) page.value = count; });

  return { page, pageCount, offset, pageItems };
}
