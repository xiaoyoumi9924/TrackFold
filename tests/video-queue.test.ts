import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VideoQueue, type VideoRecord } from '../server/video-queue.ts';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('video jobs queue independently, respect concurrency, deduplicate and recover from failure', async () => {
  const started: string[] = [];
  const resolve = new Map<string, () => void>();
  const reject = new Map<string, (error: Error) => void>();
  const q = new VideoQueue(async (task, input, output) => {
    started.push(`${input}:${output}`);
    await new Promise<void>((yes, no) => { resolve.set(input, yes); reject.set(input, no); });
    task.status = 'completed'; task.message = '视频已保存。';
  }, 2);
  assert.deepEqual(q.setPaused(true), { paused: true, waiting: 0, active: 0, limit: 2 });
  const a = q.add('a', '/first'), b = q.add('b', '/second'), c = q.add('c', '/third');
  assert.equal(q.add('a', '/first').id, a.id);
  assert.throws(() => q.add('a', '/other'), /另一位置/);
  await tick();
  assert.deepEqual(started, []);
  assert.deepEqual(q.setPaused(false), { paused: false, waiting: 1, active: 2, limit: 2 });
  assert.deepEqual(started, ['a:/first', 'b:/second']);
  assert.equal(c.status, 'queued'); assert.equal(q.busy, true);
  reject.get('b')!(new Error('network')); await tick();
  assert.equal(b.status, 'failed'); assert.equal(b.message, 'network');
  assert.equal(c.status, 'working'); assert.deepEqual(started, ['a:/first', 'b:/second', 'c:/third']);
  resolve.get('a')!(); resolve.get('c')!(); await tick();
  assert.equal(q.busy, false); assert.equal(a.status, 'completed');
  assert.notEqual(q.add('a', '/first').id, a.id);
  q.stop(); await tick(); assert.equal(q.busy, false);
});

test('video history keeps completed outputs and only restores jobs interrupted by exit', async () => {
  const records = new Map<string, VideoRecord>();
  const persist = (record: VideoRecord) => records.set(record.task.id, structuredClone(record));
  const queue = new VideoQueue(async (task, input, _, __, signal) => {
    if (input === 'done') { task.status = 'completed'; task.filePath = '/original/video.mp4'; return; }
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  }, 2, [], persist);
  const done = queue.add('done', '/original');
  const interrupted = queue.add('interrupted', '/original');
  const cancelled = queue.add('cancelled', '/original');
  const waiting = queue.add('waiting', '/original');
  await tick();
  queue.cancel(cancelled.id);
  await queue.stop();

  const resumed: string[] = [];
  const next = new VideoQueue(async (task, input, destination) => {
    resumed.push(`${input}:${destination}`);
    task.status = 'completed';
  }, 2, [...records.values()], persist);
  assert.equal(next.tasks.get(done.id)?.filePath, '/original/video.mp4');
  assert.equal(next.tasks.get(cancelled.id)?.status, 'cancelled');
  assert.equal(next.tasks.get(interrupted.id)?.interrupted, true);
  assert.equal(next.tasks.get(waiting.id)?.interrupted, true);
  assert.deepEqual(resumed, []);
  next.retry(interrupted.id);
  await tick();
  assert.deepEqual(resumed, ['interrupted:/original']);
  assert.equal(next.tasks.get(interrupted.id)?.interrupted, undefined);
  assert.throws(() => next.retry(cancelled.id), /无法重试/);
});
