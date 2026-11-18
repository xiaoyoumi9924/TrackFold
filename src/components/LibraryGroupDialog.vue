<script setup lang="ts">
import { onMounted, ref } from 'vue';
const props=defineProps<{ids:string[]; groups:string[]; assigned:string[]; update:(ids:string[],action:'add-group'|'remove-group',value:string)=>Promise<void>}>();
const emit=defineEmits<{close:[]; changed:[string]}>();
const dialog=ref<HTMLDialogElement>(), name=ref(''), busy=ref(false), error=ref('');
onMounted(()=>dialog.value?.showModal());
async function apply(action:'add-group'|'remove-group') {
 if(busy.value||!name.value.trim())return;
 busy.value=true;error.value='';
 try {await props.update(props.ids,action,name.value);emit('changed',action==='add-group'?'已加入分组。':'已从分组移除。');}
 catch(e){error.value=(e as Error).message;}
 finally{busy.value=false;}
}
</script>
<template>
 <dialog ref="dialog" class="group-dialog" aria-labelledby="group-dialog-title" @cancel.prevent="!busy && emit('close')">
  <h2 id="group-dialog-title">整理分组</h2>
  <p>已选择 {{ ids.length }} 份音频，输入新分组或选择已有分组。</p>
  <label class="group-input">分组名称<input v-model="name" list="available-audio-groups" maxlength="60" placeholder="例如：通勤、待剪辑" :disabled="busy" autofocus /></label>
  <datalist id="available-audio-groups"><option v-for="group in groups" :key="group" :value="group" /></datalist>
  <p v-if="assigned.length" class="group-current">所选音频已有：{{ assigned.join('、') }}</p>
  <p v-if="error" class="group-error" role="alert">{{ error }}</p>
  <div class="group-actions"><button class="primary" :disabled="busy || !name.trim()" @click="apply('add-group')">加入分组</button><button class="secondary" :disabled="busy || !name.trim()" @click="apply('remove-group')">移出分组</button><button class="text-button" :disabled="busy" @click="emit('close')">取消</button></div>
  <p class="group-hint">分组只整理拾音中的记录，不会移动或修改文件。</p>
 </dialog>
</template>
