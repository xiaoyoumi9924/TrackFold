<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
const busy = ref(false), message = ref(""), available = ref(false), installable = ref(false), state = ref("");
let pollTimer: ReturnType<typeof setTimeout> | undefined;
async function check() {
  if (busy.value) return;
  busy.value = true;
  try {
    const response = await fetch("/api/separation/status");
    if (!response.ok) throw new Error("暂时无法检查人声分离组件。");
    const result = await response.json();
    available.value = result.available === true;
    installable.value = result.installable === true;
    state.value = result.state || "";
    message.value = result.message;
  } catch (cause) { available.value = false; message.value = (cause as Error).message; }
  finally { busy.value = false; }
}
async function pollInstallation() {
  await check();
  if (state.value === "installing") pollTimer = setTimeout(pollInstallation, 2500);
}
async function install() {
  if (busy.value || state.value === "installing") return;
  busy.value = true;
  try {
    const response = await fetch("/api/separation/install", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "无法开始安装人声分离组件。");
    state.value = result.state || "installing";
    message.value = result.message || "正在准备人声分离组件…";
    if (state.value === "installing") pollTimer = setTimeout(pollInstallation, 1200);
    else await check();
  } catch (cause) { message.value = (cause as Error).message; }
  finally { busy.value = false; }
}
onMounted(async () => {
  await check();
  if (state.value === "installing") pollTimer = setTimeout(pollInstallation, 1200);
});
onUnmounted(() => clearTimeout(pollTimer));
</script>

<template>
  <section class="settings-card">
    <h3>人声与伴奏分离</h3>
    <p class="settings-component-status" :class="{ available }" role="status">{{ busy ? '正在检查组件…' : message }}</p>
    <p v-if="installable && !available" class="settings-component-note">首次安装会下载运行环境、依赖和模型，需要网络并占用较多磁盘空间。</p>
    <div class="settings-component-actions">
      <button v-if="installable && !available" type="button" class="primary" :disabled="busy || state === 'installing'" @click="install">
        {{ state === 'installing' ? '正在准备组件…' : '安装人声分离组件' }}
      </button>
      <button type="button" class="secondary" :disabled="busy || state === 'installing'" @click="check">重新检查</button>
    </div>
  </section>
</template>
