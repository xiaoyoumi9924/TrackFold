import type { Job } from "../shared/types.ts";
export type CompletionSummary = { completed: number; failed: number; at: string };
const terminal = new Set<Job["status"]>(["completed", "failed", "cancelled"]);

// Coalesce work observed in this run when the audio queue becomes idle.
export class CompletionTracker {
  private tracked = new Map<string, Job["status"]>();
  private timer?: ReturnType<typeof setTimeout>;
  last?: CompletionSummary;
  constructor(private busy: () => boolean, private notify: (summary: CompletionSummary) => void, private delay = 2500) {}
  observe(job: Job) {
    if (!this.tracked.has(job.id) && terminal.has(job.status)) return;
    this.tracked.set(job.id, job.status);
    this.schedule();
  }
  remove(id: string) { this.tracked.delete(id); }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delay);
    this.timer.unref();
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.tracked.size) return;
    if (this.busy() || [...this.tracked.values()].some(status => !terminal.has(status))) { this.schedule(); return; }
    const states = [...this.tracked.values()];
    this.tracked.clear();
    const completed = states.filter(status => status === "completed").length;
    const failed = states.filter(status => status === "failed").length;
    if (!completed && !failed) return;
    this.last = { completed, failed, at: new Date().toISOString() };
    this.notify(this.last);
  }
  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.tracked.clear();
  }
}
