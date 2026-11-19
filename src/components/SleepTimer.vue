<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { onDesktopAction, shutdownTimer } from "../desktop-preferences";

const deadline = ref<number | null>(null);
const now = ref(Date.now());
const duration = ref("30");
const custom = ref<number | "">("");
const busy = ref(false);
const error = ref("");
const minutes = computed(() => duration.value === "custom" ? Number(custom.value) : Number(duration.value));
const valid = computed(() => Number.isInteger(minutes.value) && minutes.value >= 1 && minutes.value <= 720);
const remaining = computed(() => {
  const seconds = Math.max(0, Math.ceil(((deadline.value ?? now.value) - now.value) / 1000));
  const clock = [Math.floor(seconds / 60) % 60, seconds % 60].map(part => String(part).padStart(2, "0")).join(":");
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${clock}` : clock;
});
const finishTime = computed(() => deadline.value && new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit", minute: "2-digit", hour12: false,
}).format(deadline.value));
function setDeadline(value: number | null) {
  now.value = Date.now();
  deadline.value = value;
}

let ticker: ReturnType<typeof setInterval>;
let removeAction: (() => void) | undefined;
async function change(value?: number | null) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try { setDeadline(await shutdownTimer(value)); }
  catch { error.value = "定时关闭暂不可用，请重试。"; }
  finally { busy.value = false; }
}
onMounted(() => {
  removeAction = onDesktopAction(message => { if (message.type === "timer") setDeadline(message.deadline); });
  ticker = setInterval(() => { if (deadline.value) now.value = Date.now(); }, 1000);
  void change();
});
onUnmounted(() => { removeAction?.(); clearInterval(ticker); });
</script>

<template>
  <section class="settings-card sleep-timer" aria-labelledby="sleep-timer-heading">
    <h3 id="sleep-timer-heading">定时关闭</h3>
    <div v-if="deadline" class="sleep-active">
      <div><span class="sleep-countdown" role="timer" aria-label="剩余时间">{{ remaining }}</span><p>{{ finishTime }} 退出拾音</p></div>
      <button type="button" class="secondary" :disabled="busy" @click="change(null)">取消定时</button>
    </div>
    <form v-else class="sleep-form" @submit.prevent="valid && change(minutes)">
      <label><span class="sr-only">关闭时间</span><select v-model="duration" :disabled="busy">
        <option value="15">15 分钟后</option><option value="30">30 分钟后</option>
        <option value="45">45 分钟后</option><option value="60">60 分钟后</option>
        <option value="90">90 分钟后</option><option value="custom">自定时长</option>
      </select></label>
      <label v-if="duration === 'custom'"><span>分钟</span><input v-model.number="custom" type="number" min="1" max="720" step="1" required placeholder="1–720" :disabled="busy" /></label>
      <p>到时停止播放并退出，未完成的任务留待下次处理。</p>
      <button type="submit" class="primary" :disabled="busy || !valid">开始计时</button>
    </form>
    <p v-if="error" class="settings-inline-error" role="alert">{{ error }}</p>
  </section>
</template>
