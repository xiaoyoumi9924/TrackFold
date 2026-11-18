import test from 'node:test'; import assert from 'node:assert/strict';
import {CompletionTracker} from '../server/completion-notifications.ts'; import type {Job} from '../shared/types.ts';
const job=(id:string,status:Job['status']):Job=>({id,status,title:id,artist:'',platform:'local',progress:0,message:'',format:'mp3',createdAt:'2026-11-17T00:00:00Z',completeness:'full'});
test('coalesces live completed and failed work, waits while busy, and ignores old or cancelled-only records',()=>{
 let busy=false;const sent:{completed:number;failed:number}[]=[];
 const tracker=new CompletionTracker(()=>busy,summary=>sent.push(summary),60000);
 try {
  tracker.observe(job('old','completed'));tracker.flush();assert.equal(sent.length,0);
  tracker.observe(job('a','queued'));tracker.observe(job('b','processing'));tracker.observe(job('c','queued'));
  tracker.observe(job('a','completed'));tracker.observe(job('b','failed'));tracker.observe(job('c','cancelled'));
  busy=true;tracker.flush();assert.equal(sent.length,0);
  busy=false;tracker.flush();assert.deepEqual(sent.map(x=>[x.completed,x.failed]),[[1,1]]);assert(tracker.last?.at);
  tracker.flush();assert.equal(sent.length,1);
  tracker.observe(job('cancel','queued'));tracker.observe(job('cancel','cancelled'));tracker.flush();assert.equal(sent.length,1);
 } finally {tracker.close();}
});
test('a retry before the summary uses the final outcome and removed jobs are not counted',()=>{
 const sent:{completed:number;failed:number}[]=[];const tracker=new CompletionTracker(()=>false,s=>sent.push(s),60000);
 try {
  tracker.observe(job('a','queued'));tracker.observe(job('a','failed'));tracker.observe(job('a','queued'));tracker.observe(job('a','completed'));
  tracker.observe(job('b','queued'));tracker.observe(job('b','completed'));tracker.remove('b');tracker.flush();
  assert.deepEqual(sent.map(s=>[s.completed,s.failed]),[[1,0]]);
 } finally {tracker.close();}
});
