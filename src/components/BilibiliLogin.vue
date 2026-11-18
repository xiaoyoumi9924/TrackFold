<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { Link2, LoaderCircle } from "@lucide/vue";

type Qr = { id: string; image: string; expiresAt: number; phase: "waiting" | "scanned" | "expired" | "confirmed" };
const props = defineProps<{
  request: (url: string, options?: RequestInit) => Promise<unknown>;
  disabled?: boolean;
}>();
const emit = defineEmits<{ connected: [] }>();
const base = "/api/login/bilibili/qr";
const qr = ref<Qr | null>(null);
const busy = ref(false);
const error = ref("");
const heading = {
  waiting: "使用哔哩哔哩 App 扫码",
  scanned: "请在手机上确认登录",
  expired: "二维码已过期",
  confirmed: "已登录 B 站",
};
let timer: ReturnType<typeof setInterval>;
let polling = false;
let revision = 0;

async function read(id?: string, method = "GET") {
  const response = await props.request(id ? `${base}/${encodeURIComponent(id)}` : base, { method }) as { qr: Qr | null };
  return response.qr;
}
async function start() {
  if (busy.value) return;
  const current = ++revision;
  busy.value = true;
  error.value = "";
  qr.value = null;
  try {
    const ticket = await read(undefined, "POST");
    if (current === revision) qr.value = ticket;
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
async function poll() {
  const ticket = qr.value;
  if (!ticket || polling || busy.value || ["confirmed", "expired"].includes(ticket.phase)) return;
  const started = revision;
  polling = true;
  try {
    const next = await read(ticket.id);
    if (started !== revision) return;
    qr.value = next;
    error.value = "";
    if (next?.phase === "confirmed") emit("connected");
  } catch (cause) { if (started === revision) error.value = (cause as Error).message; }
  finally { polling = false; }
}
async function close() {
  const ticket = qr.value;
  if (!ticket || busy.value) return;
  revision++;
  busy.value = true;
  try {
    await props.request(`${base}/${encodeURIComponent(ticket.id)}`, { method: "DELETE" });
    qr.value = null;
    error.value = "";
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
onMounted(async () => {
  const started = revision;
  timer = setInterval(poll, 2200);
  try {
    const ticket = await read();
    if (started === revision) qr.value = ticket?.phase !== "confirmed" ? ticket : null;
  } catch { /* The button can start another login. */ }
});
onUnmounted(() => { revision++; clearInterval(timer); });
</script>

<template>
  <button class="primary" type="button" :disabled="disabled || busy" @click="start">
    <LoaderCircle v-if="busy" :size="16" class="spin" /><Link2 v-else :size="16" />
    {{ busy ? "正在获取二维码…" : "扫码登录 B 站" }}
  </button>
  <div v-if="qr" class="qr-login-panel bilibili-qr" aria-live="polite">
    <div v-if="qr.phase !== 'confirmed'" class="qr-image-wrap">
      <img :src="qr.image" :class="{ expired: qr.phase === 'expired' }" alt="哔哩哔哩账号登录二维码" width="190" height="190" />
    </div>
    <div class="qr-instructions">
      <h4>{{ heading[qr.phase] }}</h4>
      <div class="account-actions">
        <button v-if="qr.phase !== 'confirmed'" class="text-button" type="button" :disabled="busy" @click="start">刷新二维码</button>
        <button class="text-button" type="button" :disabled="busy" @click="close">关闭扫码</button>
      </div>
    </div>
  </div>
  <p v-if="error" class="error-message bilibili-qr" role="alert">{{ error }}</p>
</template>

<style scoped>
.bilibili-qr { flex-basis: 100%; }
</style>
