<script setup lang="ts">
import { FileAudio } from "@lucide/vue";
import type { Platform } from "../../shared/types";
import bilibiliIcon from "../assets/bilibili-mark.png";
import douyinIcon from "../assets/douyin-mark.svg";
import qishuiIcon from "../assets/qishui-mark.png";

defineProps<{ platform: Platform }>();
</script>

<template>
  <span class="source-icon" :class="platform" aria-hidden="true">
    <img v-if="platform === 'qishui'" :src="qishuiIcon" alt="" />
    <img v-else-if="platform === 'douyin'" :src="douyinIcon" alt="" />
    <img v-else-if="platform === 'bilibili'" :src="bilibiliIcon" alt="" />
    <FileAudio v-else :size="17" />
  </span>
</template>
