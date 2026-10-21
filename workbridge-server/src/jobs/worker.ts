import { env } from '../env';
import { logger } from '../lib/logger';
import { ensureRecurringJobs } from './recurring';
import { recoverStaleJobs, runDueJobs } from './runner';

export interface JobWorker {
  /** Stops polling and resolves once the batch in flight (if any) has finished. */
  stop(): Promise<void>;
}

export interface StartJobWorkerOptions {
  intervalMs?: number;
  /** Exit the process on SIGINT/SIGTERM after the current batch. Default true. */
  handleSignals?: boolean;
}

/**
 * The polling worker for local development (`index.ts` starts it outside production and tests)
 * and for `npm run jobs:worker`. Production has no resident worker.
 *
 * Each poll: `ensureRecurringJobs` → `recoverStaleJobs` → `runDueJobs`. Batches never overlap:
 * the next poll is scheduled only after the previous one finished.
 */
export function startJobWorker(options: StartJobWorkerOptions = {}): JobWorker {
  const intervalMs = options.intervalMs ?? (Number(env.JOB_POLL_INTERVAL_MS) || 5000);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;

  const poll = async () => {
    try {
      const now = new Date();
      // Every poll, not just at start: `npm run db:seed` deletes every Job row, and two
      // `ON CONFLICT DO NOTHING` inserts are cheap.
      await ensureRecurringJobs(now);
      await recoverStaleJobs(now);
      const result = await runDueJobs({ now });
      if (result.claimed > 0) logger.info('jobs ran', { ...result });
    } catch (err) {
      logger.error('job worker poll failed', { err });
    }
  };

  const tick = () => {
    inFlight = poll().finally(() => {
      inFlight = undefined;
      if (!stopped) timer = setTimeout(tick, intervalMs);
    });
  };

  tick();
  logger.info('job worker started', { intervalMs });

  const worker: JobWorker = {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };

  if (options.handleSignals ?? true) {
    const shutdown = (signal: NodeJS.Signals) => {
      logger.info('job worker stopping', { signal });
      void worker.stop().finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }

  return worker;
}
