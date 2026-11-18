<script setup lang="ts">
import { ref } from "vue";
import { FolderOpen, LoaderCircle } from "@lucide/vue";
import type { Job } from "../../shared/types";
const props = defineProps<{ job: Job; nativePicker: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const expanded = ref(false),
  candidate = ref(""),
  busy = ref(false),
  error = ref(""),
  message = ref("");
async function post(url: string, body: unknown = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "未能关联文件，请重试。");
  return data;
}
async function choose() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const data = await post(`/api/jobs/${props.job.id}/choose-file`);
    if (data.path) candidate.value = data.path;
    else message.value = "已取消选择，原记录未变更。";
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function relocate() {
  if (busy.value || !candidate.value.trim()) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    await post(`/api/jobs/${props.job.id}/relocate`, {
      filePath: candidate.value,
    });
    emit("changed");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="file-location">
    <button v-if="!expanded" class="text-button" @click="expanded = true">
      重新定位文件
    </button>
    <div v-else class="file-location-form">
      <p>
        选择这条任务原来的音频文件。内容核对一致后恢复关联，不会复制或移动文件。
      </p>
      <div class="storage-actions">
        <button
          v-if="nativePicker"
          class="secondary"
          :disabled="busy"
          @click="choose"
        >
          <FolderOpen :size="15" />选择音频文件</button
        ><button
          class="text-button"
          :disabled="busy"
          @click="
            expanded = false;
            error = '';
            message = '';
          "
        >
          收起
        </button>
      </div>
      <label :for="`relocate-${job.id}`"
        >音频文件完整路径<input
          :id="`relocate-${job.id}`"
          v-model="candidate"
          :disabled="busy"
          autocomplete="off"
          spellcheck="false"
          @input="
            error = '';
            message = '';
          "
      /></label>
      <button
        class="secondary"
        :disabled="busy || !candidate.trim()"
        @click="relocate"
      >
        <LoaderCircle v-if="busy" :size="15" class="spin" />{{
          busy ? "正在选择或核对…" : "核对并关联文件"
        }}
      </button>
      <p v-if="error" class="file-location-error" role="alert">{{ error }}</p>
      <p v-if="message" role="status">{{ message }}</p>
    </div>
  </div>
</template>
