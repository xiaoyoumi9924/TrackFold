import test from 'node:test';
import assert from 'node:assert/strict';
import type { Job } from '../shared/types.ts';
import { isNetworkFailure, canBatchRetry, retryReason } from '../shared/retry-policy.ts';
import { retryFailures } from '../server/retry-bulk.ts';
const fixture = (id:string, overrides:Partial<Job>={}):Job => ({id,title:id,artist:'',platform:'qishui',status:'failed',progress:0,message:'网络异常',format:'mp3',createdAt:'2026-11-17T00:00:00Z',completeness:'full',sourceId:'1234567',selection:{quality:'high',format:'m4a'},failureKind:'network',...overrides});
test('only identified transient network failures with sufficient source and quality data can be retried in bulk',()=>{
 assert(isNetworkFailure(Object.assign(new Error('fetch failed'),{cause:{code:'ECONNRESET'}})));
 assert(isNetworkFailure(Object.assign(new Error('response failed'),{status:503})));
 assert(!isNetworkFailure(Object.assign(new Error('账号登录失效'),{status:403})));
 assert(canBatchRetry(fixture('yes')));
 for (const overrides of [{status:'cancelled'}, {platform:'local'}, {parentJobId:'parent'}, {failureKind:undefined}, {sourceId:undefined}, {selection:undefined}, {selection:{}}] as Partial<Job>[]) assert(!canBatchRetry(fixture('no',overrides)));
 assert.match(retryReason(fixture('local',{platform:'local'})),/重新选择/);
});
test('batch retry handles stale, cancelled, failures and a later pause in order, without retrying others',async()=>{
 const jobs=new Map([['a',fixture('a')],['b',fixture('b')],['cancel',fixture('cancel',{status:'cancelled'})],['c',fixture('c')],['d',fixture('d')]]);
 const attempted:string[]=[];let paused=false;
 const results=await retryFailures(['cancel','a','b','c','d','missing'],{
  find:id=>jobs.get(id), stopReason:()=>paused?'队列已暂停':undefined, isLocked:()=>false,
  retry:async job=>{attempted.push(job.id); if(job.id==='a') return {...job,status:'queued'}; if(job.id==='b') throw Error('网络仍不可用'); paused=true; return {...job,status:'cancelled'};},
  describe:error=>(error as Error).message,
 });
 assert.deepEqual(attempted,['a','b','c']);
 assert.deepEqual(results.map(x=>x.status),['skipped','started','failed','skipped','skipped','skipped']);
 assert.equal(results[2].message,'网络仍不可用');assert.equal(results[3].message,'任务已取消');assert.equal(results[4].message,'队列已暂停');
});

test('a task that fails immediately is not counted as restarted',async()=>{
 const job=fixture('x');
 const [result]=await retryFailures(['x'],{find:()=>job,stopReason:()=>undefined,isLocked:()=>false,retry:async()=>({...job,status:'failed',message:'保存目录不可用'}),describe:()=>''});
 assert.deepEqual(result,{id:'x',status:'failed',message:'保存目录不可用'});
});
