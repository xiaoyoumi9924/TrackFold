<script setup lang="ts">
import { ref } from "vue";
import { Film } from "@lucide/vue";

defineProps<{ src?: string }>();
const failedSource = ref("");
</script>

<template>
  <span class="video-cover" aria-hidden="true">
    <img
      v-if="src?.startsWith('https://') && src !== failedSource"
      :key="src"
      :src="src"
      alt=""
      referrerpolicy="no-referrer"
      @error="failedSource = src!"
    />
    <Film v-else :size="26" :stroke-width="1.5" />
  </span>
</template>
