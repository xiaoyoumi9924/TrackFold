import type { LoudnessStats } from '../shared/types.ts';
import { run } from './media.ts';
export const LOUDNESS_TARGET = -16;
export async function analyzeLoudness(file:string, signal:AbortSignal):Promise<LoudnessStats> {
  const output=await run('ffmpeg',['-nostdin','-hide_banner','-v','info','-protocol_whitelist','file,pipe','-i',file,'-map','0:a:0','-af','loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json','-f','null','-'],signal,undefined,true);
  const match=output.match(/\{[^{}]*"input_i"[^{}]*\}/s);
  if(!match) throw new Error('无法分析音频响度，请检查文件后重试。');
  let raw:any;try{raw=JSON.parse(match[0]);}catch{throw new Error('无法读取响度分析结果，请重试。');}
  const result:LoudnessStats={inputI:Number(raw.input_i),inputTP:Number(raw.input_tp),inputLRA:Number(raw.input_lra),inputThresh:Number(raw.input_thresh),offset:Number(raw.target_offset)};
  if(!Object.values(result).every(Number.isFinite) || result.inputI < -99 || result.inputI > 0 || result.inputTP < -99 || result.inputTP > 99 || result.inputLRA < 0 || result.inputLRA > 99 || result.inputThresh < -99 || result.inputThresh > 0 || Math.abs(result.offset)>99)
    throw new Error('音频过短或接近静音，无法可靠分析音量。');
  return result;
}
export function loudnessFilter(stats:LoudnessStats) {
  return `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${stats.inputI}:measured_TP=${stats.inputTP}:measured_LRA=${stats.inputLRA}:measured_thresh=${stats.inputThresh}:offset=${stats.offset}:linear=true`;
}
export async function renderLoudnessPreview(file:string, output:string, stats:LoudnessStats, signal:AbortSignal) {
  await run('ffmpeg',['-nostdin','-y','-hide_banner','-v','error','-protocol_whitelist','file,pipe','-i',file,'-map','0:a:0','-t','20','-af',loudnessFilter(stats),'-c:a','libmp3lame','-q:a','2','-ar','44100','-f','mp3',output],signal);
}
