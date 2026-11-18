import type { Job } from '../shared/types.ts';
export function groupKey(name:string) {return name.normalize('NFC').trim().toLocaleLowerCase('zh-CN');}
export function validGroupName(value:unknown) {
  if(typeof value!=='string') throw new Error('请填写分组名称。');
  const name=value.normalize('NFC').trim();
  if(!name || [...name].length>30 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('分组名称须为 1 至 30 个字符，不能包含换行。');
  return name;
}
export function organizeLibrary(ids:unknown, action:unknown, value:unknown, records:Map<string,Job>, playlists: string[] = []) {
  if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length) throw new Error('请选择至少一条音频，且选择不得重复。');
  if(!['favorite','add-group','remove-group'].includes(String(action))) throw new Error('整理操作无效。');
  if(action==='favorite' && typeof value!=='boolean') throw new Error('收藏状态无效。');
  const selected=ids.map(id=>records.get(id));
  if(selected.some(j=>!j || j.status!=='completed')) throw new Error('部分音频记录不可用，请刷新后重新选择。');
  let group='';
  if(action!=='favorite') {
    group=validGroupName(value);
    const existing=[...playlists, ...[...records.values()].filter(j=>j.status==='completed').flatMap(j=>j.groups||[])];
    group=existing.find(x=>groupKey(x)===groupKey(group)) || group;
    if(action==='add-group' && !existing.some(x=>groupKey(x)===groupKey(group)) && new Set(existing.map(groupKey)).size>=200) throw new Error('分组数量已达上限，请先移除不需要的分组。');
  }
  return (selected as Job[]).map(job=>{
    if(action==='favorite') return {...job, favorite:value as boolean};
    const groups=[...(job.groups||[])];const index=groups.findIndex(x=>groupKey(x)===groupKey(group));
    if(action==='add-group'&&index<0) {if(groups.length>=20) throw new Error('单首音频最多加入 20 个分组，请先移除部分分组。');groups.push(group);}
    if(action==='remove-group'&&index>=0) groups.splice(index,1);
    return {...job, groups};
  });
}
