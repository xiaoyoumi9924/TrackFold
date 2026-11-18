<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { AudioLines, Bell, Check, ChevronDown, Folder, Link2, PanelTop, Database } from "@lucide/vue";
import type { LibrarySettings, NamingStyle } from "../../shared/types";
import type { OutputFormat } from "../default-format";
import type { SettingsSection } from "../settings-sections";
import MaintenanceSettings from "./MaintenanceSettings.vue";
import GeneralSettings from "./GeneralSettings.vue";
import StoragePanel from "./StoragePanel.vue";
import NotificationSettings from "./NotificationSettings.vue";
import SeparationSettings from "./SeparationSettings.vue";
import "./settings-workspace.css";

const section = defineModel<SettingsSection>("section", { required: true });
const props = defineProps<{
  desktop: boolean;
  defaultFormat: OutputFormat;
  request: (url: string, options?: RequestInit) => Promise<unknown>;
}>();
const emit = defineEmits<{ format: [value: OutputFormat]; directory: [value: string]; restored: [] }>();
const navigation = [
  { id: "general", label: "通用", icon: PanelTop },
  { id: "files", label: "文件保存", icon: Folder },
  { id: "notifications", label: "通知", icon: Bell },
  { id: "accounts", label: "账号连接", icon: Link2 },
  { id: "separation", label: "人声分离", icon: AudioLines },
  { id: "maintenance", label: "数据与维护", icon: Database },
] as const;
const naming = [
  { value: "title", label: "仅歌名" },
  { value: "title-artist", label: "歌名 - 歌手" },
  { value: "artist-title", label: "歌手 - 歌名" },
] satisfies { value: NamingStyle; label: string }[];
const current = computed(() => navigation.find(item => item.id === section.value)!);
const organization = ref<LibrarySettings | null>(null);
const busy = ref(false);
const error = ref("");
const message = ref("");

async function readOrganization() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    organization.value = await props.request("/api/library/settings") as LibrarySettings;
  } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
async function saveOrganization(update: Partial<LibrarySettings>) {
  if (busy.value || !organization.value) return;
  const previous = organization.value;
  organization.value = { ...previous, ...update };
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    organization.value = await props.request("/api/library/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(organization.value),
    }) as LibrarySettings;
    message.value = "偏好已保存。";
  } catch (cause) {
    organization.value = previous;
    error.value = (cause as Error).message;
  } finally { busy.value = false; }
}
onMounted(readOrganization);
</script>

<template>
  <div class="settings-workspace">
    <div class="page-heading">
      <h1>设置</h1>
    </div>
    <div class="settings-layout">
      <aside class="settings-rail">
        <nav aria-label="设置分类">
          <button v-for="item in navigation" :key="item.id" :aria-pressed="section === item.id" @click="section = item.id">
            <component :is="item.icon" :size="25" aria-hidden="true" /><span>{{ item.label }}</span>
          </button>
        </nav>
      </aside>
      <section class="settings-pane" aria-labelledby="settings-pane-title">
        <header class="settings-pane-header">
          <h2 id="settings-pane-title">{{ current.label }}</h2>
        </header>

        <template v-if="section === 'general'">
          <GeneralSettings v-if="desktop" />
          <section class="settings-card" aria-labelledby="settings-artwork-title">
            <h3 id="settings-artwork-title">音频封面</h3>
            <label class="settings-switch-row">
              <span class="settings-control-copy">
                <span id="artwork-toggle-label">将可用封面写入音频</span>
                <small id="artwork-help">有封面时随音频保存，WAV 格式除外。</small>
              </span>
              <input type="checkbox" aria-labelledby="artwork-toggle-label" aria-describedby="artwork-help" :checked="organization?.embedCover" :disabled="busy || !organization" @change="saveOrganization({ embedCover: ($event.target as HTMLInputElement).checked })" />
            </label>
          </section>
        </template>
        <template v-else-if="section === 'files'">
          <section class="settings-card storage-card" aria-labelledby="storage-title">
            <h3 id="storage-title">本地保存位置</h3>
            <div class="settings-storage-locations">
              <StoragePanel kind="audio" @changed="emit('directory', $event)" />
              <StoragePanel kind="video" />
            </div>
          </section>

          <section class="settings-card settings-format" aria-labelledby="settings-format-title">
            <h3 id="settings-format-title">输出默认格式</h3>
            <label class="settings-format-select">
              <span class="sr-only">输出默认格式</span>
              <select :value="defaultFormat" @change="emit('format', ($event.target as HTMLSelectElement).value as OutputFormat)">
                <option value="mp3">MP3</option>
                <option value="m4a">M4A</option>
                <option value="original">保留来源音轨</option>
              </select>
              <ChevronDown class="select-arrow" :size="18" aria-hidden="true" />
            </label>
          </section>

          <section class="settings-card settings-naming" aria-labelledby="settings-naming-title">
            <h3 id="settings-naming-title">命名偏好</h3>
            <div class="settings-option-grid" role="radiogroup" aria-labelledby="settings-naming-title">
              <label v-for="option in naming" :key="option.value" class="settings-option">
                <input type="radio" name="settings-naming" :value="option.value" :checked="organization?.naming === option.value" :disabled="busy || !organization" @change="saveOrganization({ naming: option.value })" />
                <strong>{{ option.label }}</strong>
              </label>
            </div>
          </section>

        </template>

        <slot v-else-if="section === 'accounts'" name="accounts" />
        <template v-else-if="section === 'notifications'">
          <NotificationSettings v-if="desktop" />
          <section v-else class="settings-card"><p role="status">系统通知可在拾音桌面版中设置。</p></section>
        </template>
        <SeparationSettings v-else-if="section === 'separation'" />
        <MaintenanceSettings v-else :request="request" @restored="emit('restored')" />

        <template v-if="section === 'files' || section === 'general'">
          <div v-if="error" class="error-message" role="alert">
            <p>{{ error }}</p>
            <button v-if="!organization" class="text-button" @click="readOrganization">重新读取偏好</button>
          </div>
          <p v-if="message" class="settings-save-feedback" role="status"><Check :size="16" aria-hidden="true" />{{ message }}</p>
        </template>
      </section>
    </div>
  </div>
</template>
