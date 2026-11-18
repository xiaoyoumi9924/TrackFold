<script setup lang="ts">
import { onMounted, ref } from "vue";
const busy = ref(false), message = ref(""), available = ref(false);
async function check() {
  if (busy.value) return;
  busy.value = true;
  try {
    const response = await fetch("/api/separation/status");
    if (!response.ok) throw new Error("暂时无法检查人声分离组件。");
    const result = await response.json();
    available.value = result.available === true;
    message.value = result.message;
  } catch (cause) { available.value = false; message.value = (cause as Error).message; }
  finally { busy.value = false; }
}
onMounted(check);
</script>

<template>
  <section class="settings-card">
    <h3>人声与伴奏分离</h3>
    <p class="settings-component-status" :class="{ available }" role="status">{{ busy ? '正在检查组件…' : message }}</p>
    <button type="button" class="secondary" :disabled="busy" @click="check">重新检查</button>
  </section>
</template>
