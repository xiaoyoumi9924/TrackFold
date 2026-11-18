import type { Job } from '../shared/types.ts';
import { canBatchRetry } from '../shared/retry-policy.ts';
export type RetryOutcome = {id:string; status:'started'|'skipped'|'failed'; message:string};
export async function retryFailures(ids: string[], options: {
  find(id:string): Job | undefined;
  stopReason(): string | undefined;
  isLocked(id:string): boolean;
  retry(job:Job): Promise<Job>;
  describe(error:unknown): string;
}): Promise<RetryOutcome[]> {
  const results: RetryOutcome[] = [];
  for (const id of ids) {
    const job = options.find(id), stop = options.stopReason();
    if (stop || !job || !canBatchRetry(job) || options.isLocked(id)) {
      results.push({id,status:'skipped',message:stop || '任务状态已变化或不适合批量重试'});
      continue;
    }
    try {
      const retried = await options.retry(job);
      results.push(retried.status === 'cancelled'
        ? {id,status:'skipped',message:'任务已取消'}
        : retried.status === 'failed'
          ? {id,status:'failed',message:retried.message}
          : {id,status:'started',message:'已重新发起'});
    } catch (error) { results.push({id,status:'failed',message:options.describe(error)}); }
  }
  return results;
}
