<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { generalPreferences, type GeneralPreferences } from "../desktop-preferences";

const settings = ref<GeneralPreferences>();
const busy = ref(false);
const recording = ref(false);
const error = ref("");
const keyLabels: Record<string, string> = {
  Control: "⌃", Alt: "⌥", Shift: "⇧", CommandOrControl: "⌘",
  Space: "空格", Up: "↑", Down: "↓", Left: "←", Right: "→",
  Backspace: "⌫", Delete: "⌦", Home: "↖", End: "↘", PageUp: "⇞", PageDown: "⇟",
};
const shortcutLabel = computed(() => settings.value?.shortcut
  .split("+").map(key => keyLabels[key] ?? key).join(""));

async function load(update?: Partial<GeneralPreferences>) {
  if (busy.value) return;
  busy.value = true;
  if (update || !settings.value) error.value = "";
  try {
    settings.value = await generalPreferences(update);
  } catch (cause) {
    error.value = (cause as Error).message.replace(/^Error invoking remote method 'shiyin:preferences': Error: /, "");
  }
  finally { busy.value = false; }
}
async function toggleLogin(event: Event) {
  const input = event.target as HTMLInputElement;
  await load({ openAtLogin: input.checked });
  input.checked = !!settings.value?.openAtLogin;
}
function toggleRecording() {
  if (busy.value) return;
  recording.value = !recording.value;
  error.value = "";
}
function recordShortcut(event: KeyboardEvent) {
  if (!recording.value || event.key === "Tab") return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") {
    recording.value = false;
    error.value = "";
    return;
  }
  if (event.repeat || ["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
  let key = event.key.toUpperCase();
  if (/^Key[A-Z]$/.test(event.code)) key = /^[A-Z]$/.test(key) ? key : event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
  if (event.key === " ") key = "Space";
  if (/^Arrow(Up|Down|Left|Right)$/.test(event.key)) key = event.key.slice(5);
  if (["Backspace", "Delete", "Home", "End", "PageUp", "PageDown"].includes(event.key)) key = event.key;
  if (!(event.metaKey || event.ctrlKey || event.altKey) || !(/^[A-Z0-9]$|^F(?:[1-9]|1[0-9]|20)$/.test(key) || keyLabels[key])) {
    error.value = "请按住 ⌘、⌃ 或 ⌥，再按一个字母、数字、功能键或方向键。";
    return;
  }
  const shortcut = [
    event.metaKey && "CommandOrControl", event.ctrlKey && "Control", event.altKey && "Alt",
    event.shiftKey && "Shift", key,
  ].filter(Boolean).join("+");
  recording.value = false;
  void load({ shortcut });
}
const refresh = () => { if (!recording.value) void load(); };
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  void load();
  window.addEventListener("focus", refresh);
  timer = setInterval(refresh, 4000);
});
onUnmounted(() => { window.removeEventListener("focus", refresh); clearInterval(timer); });
</script>

<template>
  <section class="settings-card general-settings-card">
    <template v-if="settings">
      <label class="settings-switch-row">
        <span>开机自启动</span>
        <input type="checkbox" :checked="settings.openAtLogin" :disabled="busy || recording || !settings.loginSupported" @change="toggleLogin" />
      </label>
      <p v-if="settings.loginStatus === 'requires-approval'" class="settings-inline-error" role="status">请在系统设置的「登录项」中允许拾音。</p>
      <div class="settings-shortcut-row">
        <div class="settings-control-copy">
          <span>快捷启动</span>
          <small id="shortcut-help">拾音运行时，可从其他应用用快捷键唤出窗口。</small>
        </div>
        <div class="settings-shortcut-actions">
          <button type="button" class="secondary settings-shortcut-key" :aria-pressed="recording"
            :aria-disabled="busy" :aria-label="'快捷启动 ' + (recording ? '等待按键，Esc 取消' : shortcutLabel || '设置快捷键')" aria-describedby="shortcut-help"
            @click="toggleRecording" @keydown="recordShortcut" @blur="recording = false">
            <span v-if="recording">请按下快捷键</span>
            <kbd v-else-if="shortcutLabel">{{ shortcutLabel }}</kbd>
            <span v-else>设置快捷键</span>
          </button>
          <button v-if="settings.shortcut && !recording" type="button" class="text-button" :disabled="busy" aria-label="清除快捷启动键" @click="load({ shortcut: '' })">清除</button>
        </div>
      </div>
      <p v-if="settings.shortcut && !settings.shortcutActive && !error" class="settings-inline-error" role="status">快捷键暂未生效，请设置其他组合。</p>
    </template>
    <p v-else-if="busy" role="status">正在读取设置…</p>
    <p v-if="error" class="storage-warning" role="alert">{{ error }} <button v-if="!settings" type="button" class="text-button" @click="load()">重试</button></p>
  </section>
</template>
