<script setup lang="ts">
import { onMounted, ref } from "vue";
const enabled = ref(false);
const busy = ref(false);
const loaded = ref(false);
const error = ref("");
async function read() {
  busy.value = true;
  error.value = "";
  try {
    const response = await fetch("/api/notifications");
    if (!response.ok) throw Error("通知设置暂时不可用。");
    const data = await response.json();
    enabled.value = data.enabled === true;
    loaded.value = true;
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
async function change(event: Event) {
  const previous = enabled.value;
  enabled.value = (event.target as HTMLInputElement).checked;
  busy.value = true;
  error.value = "";
  try {
    const response = await fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: enabled.value }),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "设置未保存，请重试。");
    enabled.value = data.enabled === true;
  } catch (cause) {
    enabled.value = previous;
    error.value = (cause as Error).message;
  } finally { busy.value = false; }
}
onMounted(read);
</script>

<template>
  <section class="settings-card" aria-labelledby="notification-settings-title">
    <h3 id="notification-settings-title">任务提醒</h3>
    <label class="settings-switch-row">
      <span class="settings-control-copy">
        <span id="notification-toggle-label">开启系统通知</span>
        <small id="notification-help">一批音频任务结束后，通知完成和失败数量。</small>
      </span>
      <input type="checkbox" aria-labelledby="notification-toggle-label" aria-describedby="notification-help" :checked="enabled" :disabled="busy || !loaded" @change="change" />
    </label>
    <p v-if="error" class="settings-inline-error" role="alert">{{ error }}</p>
    <button v-if="!loaded && !busy" class="secondary" @click="read">重新读取</button>
  </section>
</template>
