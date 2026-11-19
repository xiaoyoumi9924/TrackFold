import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createHandoffQueue } = require('../desktop/handoff.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('browser handoffs run different videos concurrently, deduplicate and continue after failure', async () => {
  const started: string[] = [], failed: string[] = [];
  const finish = new Map<string, (value?: unknown) => void>();
  const reject = new Map<string, (error: Error) => void>();
  let ready = false;
  const q = createHandoffQueue({
    canStart: () => ready,
    confirm: () => true,
    concurrency: 2,
    run: (id: string) => { started.push(id); return new Promise((resolve, fail) => { finish.set(id, resolve); reject.set(id, fail); }); },
    onError: (_error: Error, id: string) => failed.push(id),
  });
  assert.equal(q.add('a'), true);
  assert.equal(q.add('a'), false);
  q.add('b'); q.add('c');
  await tick(); assert.deepEqual(started, []);
  ready = true; q.drain(); await tick();
  assert.deepEqual(started, ['a', 'b']);
  reject.get('b')!(new Error('failure')); await tick();
  assert.deepEqual(failed, ['b']);
  assert.deepEqual(started, ['a', 'b', 'c']);
  finish.get('a')!(); finish.get('c')!(); await tick();
  assert.equal(q.add('a'), true);
  await tick(); assert.deepEqual(started, ['a', 'b', 'c', 'a']);
  finish.get('a')!(); await tick();
});

test('browser handoffs wait for one confirmation at a time and bound the pending queue', async () => {
  const shown: string[] = [], started: string[] = [];
  const answer = new Map<string, (confirmed: boolean) => void>();
  const queue = createHandoffQueue({
    canStart: () => true,
    maxPending: 2,
    confirm: (id: string) => {
      shown.push(id);
      return new Promise<boolean>(resolve => answer.set(id, resolve));
    },
    run: (id: string) => started.push(id),
    onError: (error: Error) => assert.fail(error.message),
  });
  assert.equal(queue.add('a'), true);
  assert.equal(queue.add('b'), true);
  assert.equal(queue.add('c'), false);
  assert.equal(queue.add('a'), false);
  await tick();
  assert.deepEqual(shown, ['a']);
  assert.deepEqual(started, []);
  answer.get('a')!(false);
  await tick();
  assert.deepEqual(shown, ['a', 'b']);
  assert.deepEqual(started, []);
  assert.equal(queue.add('c'), true);
  answer.get('b')!(true);
  await tick();
  assert.deepEqual(started, ['b']);
  assert.deepEqual(shown, ['a', 'b', 'c']);
  answer.get('c')!(false);
  await tick();
  assert.deepEqual(started, ['b']);
});
