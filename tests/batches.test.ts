import test from "node:test";
import assert from "node:assert/strict";
import { Batches, batchLinks } from "../server/batches.ts";
import type { Batch, Job, Resource } from "../shared/types.ts";
const link = (id: string) => `https://v.douyin.com/${id}/`;
const resource = (id: string): Resource => ({
  token: `token-${id}`,
  sourceId: id,
  platform: "douyin",
  title: `测试 ${id}`,
  artist: "测试作者",
  duration: 20,
  completeness: "full",
  note: "测试资源",
  choices: [{ id: "original", label: "原始音轨", format: "aac" }],
});
async function settled(store: Batches, id: string) {
  for (let i = 0; i < 100; i++) {
    const result = store.get(id);
    if (result.status !== "resolving") return result;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("batch did not settle");
}
test("batch input extracts mixed share text, merges exact repeats and enforces a bounded batch", () => {
  assert.deepEqual(
    batchLinks(
      `分享 [抖音](${link("a")})\n汽水 https://qishui.douyin.com/s/b/。 ${link("a")}`,
    ),
    {
      links: [link("a"), "https://qishui.douyin.com/s/b/"],
      duplicateInputs: 1,
    },
  );
  assert.throws(() => batchLinks("没有链接"), /没有找到/);
  assert.throws(
    () =>
      batchLinks(
        Array.from({ length: 21 }, (_, i) => link(String(i))).join("\n"),
      ),
    /最多 20/,
  );
  assert.throws(() => batchLinks("x".repeat(30001)), /过长/);
});
test("one bad item never blocks the rest; aliases are deduplicated by platform and source id", async () => {
  const calls: string[] = [];
  const store = new Batches(
    [],
    () => {},
    async (input) => {
      calls.push(input);
      if (input === link("bad")) throw new Error("作品已删除");
      return resource("same-work");
    },
  );
  const batch = store.create(
    [link("one"), link("bad"), link("alias"), "https://127.0.0.1/private"].join(
      "\n",
    ),
  );
  const result = await settled(store, batch.id);
  assert.deepEqual(
    result.items.map((i) => i.status),
    ["ready", "failed", "duplicate", "failed"],
  );
  assert.equal(result.items[2].duplicateOf, result.items[0].id);
  assert.equal(result.items[1].message, "作品已删除");
  assert.equal(calls.length, 3);
});
test("cancelling discards an in-flight result and never starts remaining links", async () => {
  let release!: (r: Resource) => void,
    calls = 0;
  const gate = new Promise<Resource>((r) => (release = r));
  const store = new Batches(
    [],
    () => {},
    async () => {
      calls++;
      return gate;
    },
  );
  const batch = store.create(`${link("one")}\n${link("two")}`);
  assert.equal(store.get(batch.id).items[0].status, "resolving");
  store.cancel(batch.id);
  release(resource("one"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    store.get(batch.id).items.map((i) => i.status),
    ["cancelled", "cancelled"],
  );
  assert.equal(calls, 1);
});
test("retrying while a cancelled request finishes cannot attach its stale response", async () => {
  let release!: (r: Resource) => void,
    calls = 0;
  const gate = new Promise<Resource>((r) => (release = r));
  const store = new Batches(
    [],
    () => {},
    async () => (++calls === 1 ? gate : resource("new")),
  );
  const batch = store.create(link("one"));
  store.cancel(batch.id);
  store.retry(batch.id, batch.items[0].id);
  release(resource("old"));
  const result = await settled(store, batch.id);
  assert.equal(result.items[0].resource?.sourceId, "new");
  assert.equal(calls, 2);
});
test("failed submission stays reviewable; repeated submission creates only one job", async () => {
  const store = new Batches(
    [],
    () => {},
    async () => ({ ...resource("preview"), completeness: "preview" }),
  );
  const batch = store.create(link("one"));
  const result = await settled(store, batch.id);
  const item = result.items[0];
  assert.throws(
    () =>
      store.submit(batch.id, item.id, () => {
        throw new Error("需要确认试听");
      }),
    /确认试听/,
  );
  assert.equal(store.get(batch.id).items[0].status, "ready");
  let calls = 0;
  const create = () => {
    calls++;
    return { id: "job-1" } as Job;
  };
  assert.deepEqual(store.submit(batch.id, item.id, create), {
    jobId: "job-1",
    created: true,
  });
  assert.deepEqual(store.submit(batch.id, item.id, create), {
    jobId: "job-1",
    created: false,
  });
  assert.equal(calls, 1);
  assert.throws(() => store.retry(batch.id, item.id, () => true), /不能重新解析/);
  store.retry(batch.id, item.id, id => id !== "job-1");
  const reparsed = (await settled(store, batch.id)).items[0];
  assert.equal(reparsed.status, "ready");
  assert.equal(reparsed.jobId, undefined);
});
test("restart preserves submitted jobs but requires reparse for unsaved and interrupted resources", async () => {
  let saved!: Batch;
  const store = new Batches(
    [],
    (b) => (saved = structuredClone(b)),
    async (input) => resource(input),
  );
  const batch = store.create(`${link("one")}\n${link("two")}`);
  const ready = await settled(store, batch.id);
  store.submit(batch.id, ready.items[0].id, () => ({ id: "saved-job" }) as Job);
  const restored = new Batches(
    [structuredClone(saved)],
    () => {},
    async () => {
      throw new Error("must not auto-resolve");
    },
  );
  const state = restored.get(batch.id);
  assert.equal(state.status, "interrupted");
  assert.equal(state.items[0].jobId, "saved-job");
  assert.equal(state.items[0].status, "submitted");
  assert.equal(state.items[1].status, "stale");
  assert.throws(
    () =>
      restored.submit(
        batch.id,
        state.items[1].id,
        () => ({ id: "bad" }) as Job,
      ),
    /先完成/,
  );
  state.items[1].status = "ready";
  assert.equal(restored.get(batch.id).items[1].status, "stale");
});

test("汽水批次可选 500 首；停止后保留结果，重试不会重复解析已经完成的歌曲", async () => {
  const tracks = Array.from({ length: 500 }, (_, index) => ({
    id: String(7420000 + index), title: `歌曲 ${index + 1}`, artist: "", duration: 60,
  }));
  const calls: string[] = [];
  const store = new Batches([], () => {}, async (_input, id) => {
    if (!id) throw new Error("缺少歌曲编号");
    calls.push(id);
    return { ...resource(id), platform: "qishui" };
  });
  assert.throws(() => store.createDiscovery([...tracks, tracks[0]], "超限"), /500/);
  const batch = store.createDiscovery(tracks, "汽水歌单");
  assert.equal(batch.items.length, 500);
  assert.throws(() => store.createDiscovery(tracks, "第二批"), /上一批/);
  assert.equal(batch.items.filter(item => item.status === "resolving").length, 1);
  for (let i = 0; i < 80 && store.get(batch.id).items[0].status !== "ready"; i++)
    await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(store.get(batch.id).items[0].status, "ready");
  const stopped = store.cancel(batch.id);
  assert.equal(stopped.items.filter(item => item.status === "cancelled").length, 499);
  const restored = new Batches([stopped], () => {}, async (_input, id) => {
    if (!id) throw new Error("缺少歌曲编号");
    calls.push(id);
    return { ...resource(id), platform: "qishui" };
  });
  const resumed = restored.resumeDiscovery(batch.id);
  assert.equal(resumed.items[0].status, "ready");
  assert.equal(resumed.items[1].status, "resolving");
  restored.cancel(batch.id);
  assert.deepEqual(calls, [tracks[0].id]);
});

test("a failed background checkpoint does not strand the batch", async (t) => {
  t.mock.method(console, "warn", () => {});
  const store = new Batches([], batch => {
    if (batch.items.some(item => item.status === "resolving"))
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  }, async input => resource(input));
  const batch = store.create(`${link("one")}\n${link("two")}`);
  assert.deepEqual((await settled(store, batch.id)).items.map(item => item.status), ["ready", "ready"]);
});
