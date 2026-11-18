import { randomUUID } from "node:crypto";
import type { VideoTask } from "../shared/types.ts";
import type { VideoPlan } from "./video.ts";

type VideoRequest = { input: string; outputDir: string };
type WaitingVideo = VideoRequest & { task: VideoTask; plan?: VideoPlan };
export type VideoRecord = VideoRequest & { task: VideoTask };

export class VideoQueue {
  readonly tasks = new Map<string, VideoTask>();
  private waiting: WaitingVideo[] = [];
  private active = 0;
  private readonly inFlight = new Map<string, VideoTask>();
  private readonly requests = new Map<string, VideoRequest>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Set<Promise<void>>();
  private stopped = false;
  private paused = false;

  constructor(
    private readonly process: (task: VideoTask, input: string, outputDir: string, plan: VideoPlan | undefined, signal: AbortSignal) => Promise<void>,
    private readonly concurrency = 2,
    records: VideoRecord[] = [],
    private readonly persist: (record: VideoRecord) => void = () => {},
  ) {
    for (const record of records) {
      const { task } = record;
      this.restoreRecord(record);
      if (task.status === "queued" || task.status === "working") this.interrupt(task);
    }
  }

  restoreRecord({task, input, outputDir}: VideoRecord) {
    this.tasks.set(task.id, task);
    this.requests.set(task.id, { input, outputDir });
  }

  state() {
    return { paused: this.paused, active: this.active, waiting: this.waiting.length, limit: this.concurrency };
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    if (!paused) this.drain();
    return this.state();
  }

  get busy() { return this.active > 0 || this.waiting.length > 0; }

  add(input: string, outputDir: string, plan?: VideoPlan) {
    const clean = input.trim();
    const duplicate = this.inFlight.get(clean);
    if (duplicate) {
      if (this.requests.get(duplicate.id)?.outputDir !== outputDir)
        throw new Error("该视频正在保存到另一位置，请完成或取消原任务后再试。");
      return duplicate;
    }
    this.checkCapacity();
    const sourceId = clean.match(/douyin\.com\/video\/(\d{15,22})/)?.[1];
    const task: VideoTask = {
      id: randomUUID(), status: "queued", message: "等待处理",
      createdAt: new Date().toISOString(),
      title: sourceId ? `抖音视频 ${sourceId}` : undefined,
      ...plan?.metadata,
    };
    const request = { input: clean, outputDir };
    this.tasks.set(task.id, task);
    this.requests.set(task.id, request);
    return this.enqueue({ task, ...request, plan });
  }

  retry(id: string) {
    const task = this.tasks.get(id);
    const request = this.requests.get(id);
    if (task?.status !== "failed" || !request) throw new Error("此视频任务无法重试，请重新解析链接。");
    if (this.inFlight.has(request.input)) throw new Error("该视频已有任务正在处理，请稍后再试。");
    this.checkCapacity();
    task.status = "queued";
    task.message = "等待处理";
    task.progress = undefined;
    task.needsReview = undefined;
    return this.enqueue({ task, ...request });
  }

  request(id: string) { return this.requests.get(id); }

  canRemove(id: string) {
    const task = this.tasks.get(id);
    return !!task && task.status !== "queued" && task.status !== "working" && !this.controllers.has(id);
  }

  remove(id: string, removeRecord: () => void) {
    if (!this.canRemove(id))
      throw new Error("请等待这条视频任务结束后再删除。");
    removeRecord();
    this.tasks.delete(id);
    this.requests.delete(id);
  }

  save(task: VideoTask) {
    const request = this.requests.get(task.id);
    if (request) this.persist({ task, ...request });
  }

  cancel(id: string) {
    const task = this.tasks.get(id);
    const request = this.requests.get(id);
    if (!task || !request) throw new Error("视频任务不存在。");
    if (!["queued", "working"].includes(task.status) && !task.interrupted) return task;
    const index = this.waiting.findIndex(item => item.task.id === id);
    if (index >= 0) {
      this.waiting.splice(index, 1);
      this.inFlight.delete(request.input);
    }
    this.controllers.get(id)?.abort();
    task.status = "cancelled";
    task.message = "视频任务已取消。";
    task.progress = undefined;
    task.interrupted = undefined;
    this.save(task);
    return task;
  }

  private interrupt(task: VideoTask) {
    task.status = "failed";
    task.message = "上次未完成，可在任务页继续。";
    task.interrupted = true;
    task.progress = undefined;
    this.save(task);
  }

  private checkCapacity() {
    if (this.stopped) throw new Error("拾音正在退出。");
    if (this.waiting.length >= 100) throw new Error("视频排队数量已满，请等待任务完成。");
  }

  private enqueue(item: WaitingVideo) {
    this.save(item.task);
    this.inFlight.set(item.input, item.task);
    this.waiting.push(item);
    queueMicrotask(() => this.drain());
    return item.task;
  }

  private drain() {
    while (!this.stopped && !this.paused && this.active < this.concurrency && this.waiting.length) {
      const { task, input, outputDir, plan } = this.waiting.shift()!;
      this.active++;
      task.status = "working";
      task.message = plan ? "正在准备下载…" : "正在解析链接…";
      this.save(task);
      const controller = new AbortController();
      this.controllers.set(task.id, controller);
      const work = this.process(task, input, outputDir, plan, controller.signal).catch(error => {
        if (task.status === "cancelled") return;
        task.status = "failed";
        task.message = error instanceof Error ? error.message : "处理失败。";
      }).finally(() => {
        if (task.status !== "completed" && controller.signal.aborted) {
          if (task.status !== "cancelled") this.interrupt(task);
        } else {
          if (task.status === "completed") {
            task.interrupted = undefined;
            task.needsReview = undefined;
          }
          this.save(task);
        }
        this.controllers.delete(task.id);
        this.inFlight.delete(input);
        this.active--;
        this.running.delete(work);
        this.drain();
      });
      this.running.add(work);
    }
  }

  stop() {
    this.stopped = true;
    for (const { task, input } of this.waiting.splice(0)) {
      this.inFlight.delete(input);
      this.interrupt(task);
    }
    for (const controller of this.controllers.values()) controller.abort();
    return Promise.allSettled(this.running);
  }
}
