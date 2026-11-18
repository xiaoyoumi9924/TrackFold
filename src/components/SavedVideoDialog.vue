<script setup lang="ts">
import { onMounted, ref } from "vue";
import { X } from "@lucide/vue";
import type { VideoTask } from "../../shared/types";

defineProps<{ task: VideoTask }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const error = ref(false);
onMounted(() => dialog.value?.showModal());
</script>

<template>
  <dialog ref="dialog" class="video-dialog" aria-labelledby="saved-video-title" @close="emit('close')">
    <div class="video-dialog-inner">
      <div class="section-heading">
        <h2 id="saved-video-title">{{ task.title || "播放视频" }}</h2>
        <button class="icon-button" type="button" aria-label="关闭视频预览" @click="dialog?.close()"><X :size="21" /></button>
      </div>
      <p v-if="error" class="error-message" role="alert">无法播放该视频，请检查文件是否仍在保存位置。</p>
      <video v-else controls autoplay playsinline :src="`/api/video/${encodeURIComponent(task.id)}/media`" @error="error = true"></video>
    </div>
  </dialog>
</template>
