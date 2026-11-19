import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  Batch,
  BatchItem,
  DiscoverySaveOptions,
  Job,
  Resource,
  PlaylistImport,
  PlaylistTrack,
} from "../shared/types.ts";
import { extractLink } from "./providers.ts";
import { reportLocalFailure } from "./temporary-media.ts";

export function batchLinks(text: string) {
  if (typeof text !== "string" || text.length > 30000)
    throw new Error("分享文案过长，请分批添加，每批最多 20 条链接。");
  const matches = text.match(/https?:\/\/[^\s<>"\]\[\u00a0]+/g) || [];
  const links = [
    ...new Set(matches.map((s) => s.replace(/[，。；！）)]+$/, ""))),
  ];
  if (!links.length)
    throw new Error("没有找到链接，请粘贴汽水或抖音分享文案。");
  if (links.length > 20)
    throw new Error("每批最多 20 条不同链接，请分批添加。");
  return { links, duplicateInputs: matches.length - links.length };
}

export class Batches {
  private data = new Map<string, Batch>();
  private running = false;
  constructor(
    saved: Batch[],
    private persist: (batch: Batch) => void,
    private resolve: (input: string, trackId?: string) => Promise<Resource>,
    private saveDiscoveryTrack?: (resource: Resource, options: DiscoverySaveOptions, batchId: string, itemId: string) => Job,
  ) {
    for (const batch of saved) {
      let interrupted = false;
      for (const item of batch.items) {
        if (["waiting", "resolving", "ready"].includes(item.status) && !(batch.discovery && item.status === "ready")) {
          item.status = "stale";
          item.message = "服务已重启，请重新解析后确认保存。";
          interrupted = true;
        }
      }
      this.data.set(batch.id, batch);
      if (interrupted) {
        batch.status = "interrupted";
        this.persistProgress(batch);
      }
    }
  }
  discoveryHistory(unfinishedJob?: (id: string) => boolean) {
    return [...this.data.values()].reverse().filter(batch => batch.discovery).slice(0, 20).map(batch => ({
      id: batch.id, createdAt: batch.createdAt, title: batch.discovery!.title, status: batch.status, total: batch.items.length,
      needsAttention: batch.items.some(item =>
        !["submitted", "duplicate"].includes(item.status) || (!!item.jobId && unfinishedJob?.(item.jobId))),
    }));
  }
  createDiscovery(tracks: unknown, title: unknown, autoSave?: DiscoverySaveOptions) {
    if (!Array.isArray(tracks) || !tracks.length || tracks.length > 500)
      throw new Error("每批可加入 1 至 500 首歌曲。");
    if (this.discoveryHistory().some(batch => batch.status === "resolving"))
      throw new Error("上一批正在解析，完成或停止后可添加新的一批。");
    const clean = new Map<string, PlaylistTrack>();
    for (const track of tracks) {
      if (!track || typeof track.id !== "string" || !/^[1-9]\d{5,24}$/.test(track.id))
        throw new Error("部分歌曲编号无效，请刷新列表后重试。");
      if (clean.has(track.id)) continue;
      clean.set(track.id, {
        id: track.id,
        title: typeof track.title === "string" ? track.title.slice(0, 300) : "汽水音乐",
        artist: typeof track.artist === "string" ? track.artist.slice(0, 200) : "",
        duration: typeof track.duration === "number" && Number.isFinite(track.duration) && track.duration >= 0 ? track.duration : 0,
      });
    }
    const batch: Batch = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: "resolving",
      discovery: { title: typeof title === "string" && title.trim() ? title.trim().slice(0, 100) : "汽水音乐", autoSave },
      duplicateInputs: tracks.length - clean.size,
      items: [...clean.values()].map(track => ({
        id: randomUUID(), track, input: `https://music.douyin.com/qishui/share/track?track_id=${track.id}`,
        status: "waiting", message: "等待解析",
      })),
    };
    this.persist(batch);
    this.data.set(batch.id, batch);
    void this.drain();
    return this.get(batch.id);
  }
  discoveryBatch(id: string) {
    const batch = this.get(id);
    if (!batch.discovery) throw new Error("未找到汽水音乐解析批次。");
    return batch;
  }
  resumeDiscovery(id: string) {
    const batch = this.required(id);
    if (!batch.discovery || batch.status === "resolving" ||
        this.discoveryHistory().some(item => item.status === "resolving"))
      throw new Error("请等待当前批次完成或停止后重试。");
    const retryable = batch.items.filter(item => ["failed", "cancelled", "stale"].includes(item.status));
    if (!retryable.length) throw new Error("没有待重新解析的歌曲。");
    for (const item of retryable) {
      item.status = "waiting";
      item.message = "等待重新解析";
      item.resource = undefined;
    }
    batch.status = "resolving";
    this.persist(batch);
    void this.drain();
    return this.get(id);
  }
  list() {
    return [...this.data.values()]
      .reverse()
      .slice(0, 30)
      .map((b) => structuredClone(b));
  }
  get pending() {
    return [...this.data.values()].some(batch => batch.status === "resolving");
  }
  get size() { return this.data.size; }
  stopAll() {
    for (const batch of this.data.values()) {
      if (batch.status !== "resolving") continue;
      try { this.cancel(batch.id); } catch (error) { reportLocalFailure("未能保存批次停止状态", error); }
    }
  }
  get(id: string) {
    const batch = this.data.get(id);
    if (!batch) throw new Error("批次不存在，请重新添加链接。");
    return structuredClone(batch);
  }
  create(input: string) {
    const parsed = batchLinks(input);
    const batch: Batch = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: "resolving",
      duplicateInputs: parsed.duplicateInputs,
      items: parsed.links.map((input) => ({
        id: randomUUID(),
        input,
        status: "waiting",
        message: "等待解析",
      })),
    };
    this.persist(batch);
    this.data.set(batch.id, batch);
    void this.drain();
    return this.get(batch.id);
  }
  importPlaylist(data: PlaylistImport) {
    const batch: Batch = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: "ready",
      duplicateInputs: 0,
      playlist: data.source,
      items: data.tracks.map((track) => ({
        id: randomUUID(),
        input: `https://music.douyin.com/qishui/share/track?track_id=${track.id}`,
        status: "listed",
        track,
        message: "歌曲信息已读取，尚未解析音频。",
      })),
    };
    this.persist(batch);
    this.data.set(batch.id, batch);
    return this.get(batch.id);
  }
  comparePlaylist(id: string, data: PlaylistImport) {
    const previous = this.required(id);
    if (!previous.playlist || previous.playlist.id !== data.source.id)
      throw new Error("歌单编号不一致，无法比较。");
    if (!previous.playlist.comparisonReady || !data.source.comparisonReady)
      throw new Error("歌单清单不完整或数量无法核对，暂不能可靠比较。请重新读取完整歌单后再试；旧版清单需先重新展开。 ");
    const oldTracks = previous.items.map(item => item.track).filter((track): track is NonNullable<typeof track> => Boolean(track));
    if (oldTracks.length !== previous.items.length || new Set(oldTracks.map(track => track.id)).size !== oldTracks.length)
      throw new Error("旧清单缺少歌曲编号，无法可靠比较，请重新展开歌单。");
    const oldIds = new Set(oldTracks.map(track => track.id));
    const newIds = new Set(data.tracks.map(track => track.id));
    const batch = this.importPlaylist(data);
    const stored = this.required(batch.id);
    stored.playlistComparison = {
      previousAt: previous.playlist.retrievedAt,
      addedIds: data.tracks.filter(track => !oldIds.has(track.id)).map(track => track.id),
      removed: oldTracks.filter(track => !newIds.has(track.id)),
      unchanged: data.tracks.filter(track => oldIds.has(track.id)).length,
    };
    this.persist(stored);
    return this.get(batch.id);
  }
  resolveSelected(id: string, itemIds: unknown) {
    const batch = this.required(id);
    if (
      !Array.isArray(itemIds) ||
      !itemIds.length ||
      itemIds.length > 20 ||
      itemIds.some((i) => typeof i !== "string")
    )
      throw new Error("请勾选 1 至 20 首待解析歌曲。");
    const selected = [...new Set(itemIds)].map((id) =>
      batch.items.find((i) => i.id === id),
    );
    if (selected.some((i) => !i || i.status !== "listed"))
      throw new Error("部分歌曲状态已变化，请刷新清单后重新选择。");
    for (const item of selected) {
      item!.status = "waiting";
      item!.message = "等待解析音频资源";
    }
    batch.status = "resolving";
    this.persist(batch);
    void this.drain();
    return this.get(id);
  }
  cancel(id: string) {
    const batch = this.required(id);
    batch.status = "cancelled";
    for (const item of batch.items) {
      if (["waiting", "resolving"].includes(item.status)) {
        item.status = "cancelled";
        item.message = "解析已停止，可单独重试。";
      }
    }
    this.persist(batch);
    return this.get(id);
  }
  retry(id: string, itemId: string, hasJob: (id: string) => boolean = () => true) {
    const batch = this.required(id);
    const item = batch.items.find((i) => i.id === itemId);
    const missingJob = item?.status === "submitted" && item.jobId && !hasJob(item.jobId);
    if (!item || (!missingJob && !["failed", "cancelled", "stale", "ready"].includes(item.status)))
      throw new Error("该条目当前不能重新解析。");
    item.jobId = undefined;
    item.status = "waiting";
    item.message = "等待重新解析";
    item.resource = undefined;
    batch.status = "resolving";
    this.persist(batch);
    void this.drain();
    return this.get(id);
  }
  submit(id: string, itemId: string, create: (resource: Resource) => Job) {
    const batch = this.required(id);
    const item = batch.items.find((i) => i.id === itemId);
    if (item?.status === "submitted" && item.jobId)
      return { jobId: item.jobId, created: false };
    if (!item || item.status !== "ready" || !item.resource)
      throw new Error("请先完成该条目的解析，再确认保存。");
    const job = create(item.resource);
    this.attachJob(item, job);
    this.persist(batch);
    return { jobId: job.id, created: true };
  }
  private attachJob(item: BatchItem, job: Job) {
    item.status = "submitted";
    item.jobId = job.id;
    item.message = job.status === "completed" ? "已有保存文件" : "已加入音频队列";
  }
  private required(id: string) {
    const batch = this.data.get(id);
    if (!batch) throw new Error("批次不存在，请重新添加链接。");
    return batch;
  }
  private persistProgress(batch: Batch) {
    try { this.persist(batch); } catch (error) { reportLocalFailure("未能保存批次进度", error); }
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const batch = [...this.data.values()].find((b) =>
          b.items.some((i) => i.status === "waiting"),
        );
        const item = batch?.items.find((i) => i.status === "waiting");
        if (!batch || !item) break;
        item.status = "resolving";
        item.message = "正在解析资源";
        this.persistProgress(batch);
        try {
          const link = extractLink(item.input);
          const host = new URL(link).hostname;
          if (
            !["douyin.com", "qishui.com", "iesdouyin.com", "amemv.com"].some(
              (d) => host === d || host.endsWith("." + d),
            )
          )
            throw new Error("仅支持汽水音乐或抖音分享链接。");
          if (batch.discovery) await delay(300);
          if (item.status !== "resolving") continue;
          const resource = await this.resolve(link, batch.discovery ? item.track?.id : undefined);
          if (item.status !== "resolving") continue;
          if (
            item.track &&
            (resource.platform !== "qishui" ||
              resource.sourceId !== item.track.id)
          )
            throw new Error("解析结果与所选歌单歌曲编号不一致，已停止此条目。");
          const duplicate = batch.items.find(
            (i) =>
              i.id !== item.id &&
              i.resource?.platform === resource.platform &&
              i.resource.sourceId === resource.sourceId &&
              ["ready", "submitted"].includes(i.status),
          );
          item.resource = resource;
          const autoSave = batch.discovery?.autoSave;
          const canSave = resource.completeness === "full" ||
            (resource.completeness === "preview" && autoSave?.allowPreview);
          if (!duplicate && autoSave && canSave && this.saveDiscoveryTrack) {
            this.attachJob(item, this.saveDiscoveryTrack(resource, autoSave, batch.id, item.id));
            continue;
          }
          item.status = duplicate ? "duplicate" : "ready";
          item.duplicateOf = duplicate?.id;
          item.message = duplicate
            ? "与本批次其他条目是同一资源，已跳过。"
            : resource.note;
        } catch (e) {
          if (item.status !== "resolving") continue;
          item.status = "failed";
          item.message = (
            e instanceof Error ? e.message : "解析未完成，请重试。"
          )
            .replace(/https?:\/\/[^\s]+/g, "[资源地址]")
            .slice(0, 400);
        } finally {
          if (
            !batch.items.some((i) =>
              ["waiting", "resolving"].includes(i.status),
            ) &&
            batch.status === "resolving"
          )
            batch.status = "ready";
          this.persistProgress(batch);
        }
      }
    } catch (error) {
      reportLocalFailure("批次处理意外停止", error);
      for (const batch of this.data.values()) {
        if (batch.status !== "resolving") continue;
        for (const item of batch.items) if (item.status === "resolving" || item.status === "waiting") {
          item.status = "failed";
          item.message = "批次处理未完成，请重试。";
        }
        batch.status = "ready";
        this.persistProgress(batch);
      }
    } finally {
      this.running = false;
    }
  }
}
