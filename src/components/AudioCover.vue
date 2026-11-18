<script setup lang="ts">
import { ref } from "vue";
import { Music2 } from "@lucide/vue";

defineProps<{ src?: string }>();
const failedSource = ref("");
</script>

<template>
  <span class="audio-cover" aria-hidden="true">
    <img
      v-if="src?.startsWith('https://') && src !== failedSource"
      :key="src"
      :src="src"
      alt=""
      referrerpolicy="no-referrer"
      @error="failedSource = src!"
    />
    <Music2 v-else :size="24" />
  </span>
</template>
