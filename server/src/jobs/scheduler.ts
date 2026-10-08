import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { getEnv } from '../config/env.js';
import { logger } from '../config/logger.js';
import { runStatusCleanup, runMessageCleanup, runStaleCallCleanup } from './cleanup.js';

function connection(): ConnectionOptions {
  const url = new URL(getEnv().REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  };
}

export const QUEUE_CLEANUP = 'cleanup';

export type CleanupJobName = 'status' | 'message' | 'stale-call';

// Repeatable schedules (Req 11.1-11.3). BullMQ dedupes a repeatable job by its
// name + pattern across all producers, so adding it on every instance still
// results in a single scheduled series (Req 11.4).
const SCHEDULES: { name: CleanupJobName; pattern: string }[] = [
  { name: 'status', pattern: '0 * * * *' }, // hourly
  { name: 'message', pattern: '0 3 * * *' }, // daily at 03:00
  { name: 'stale-call', pattern: '*/30 * * * *' }, // every 30 minutes
];

let cleanupQueue: Queue | null = null;
let cleanupWorker: Worker | null = null;

export function getCleanupQueue(): Queue {
  if (!cleanupQueue) {
    cleanupQueue = new Queue(QUEUE_CLEANUP, {
      connection: connection(),
      defaultJobOptions: {
        attempts: 4, // initial + 3 retries (Req 11.5)
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    });
  }
  return cleanupQueue;
}

async function runJob(name: CleanupJobName): Promise<unknown> {
  switch (name) {
    case 'status':
      return runStatusCleanup();
    case 'message':
      return runMessageCleanup();
    case 'stale-call':
      return runStaleCallCleanup();
  }
}

/**
 * Register the repeatable cleanup schedules and start the worker. The worker's
 * concurrency is 1 and BullMQ guarantees a job is processed by exactly one
 * worker, so a scheduled run executes on exactly one instance (Req 11.4).
 */
export async function startScheduler(): Promise<void> {
  if (cleanupWorker) return;
  const queue = getCleanupQueue();

  for (const { name, pattern } of SCHEDULES) {
    await queue.add(
      name,
      {},
      { repeat: { pattern }, jobId: `cleanup-${name}` },
    );
  }

  cleanupWorker = new Worker<Record<string, never>>(
    QUEUE_CLEANUP,
    async (job) => runJob(job.name as CleanupJobName),
    { connection: connection(), concurrency: 1 },
  );
  cleanupWorker.on('failed', (job, err) => {
    logger.warn({ job: job?.name, attempts: job?.attemptsMade, err }, 'cleanup job failed');
  });
  logger.info({ schedules: SCHEDULES.map((s) => s.name) }, 'cleanup scheduler started');
}

export async function closeScheduler(): Promise<void> {
  await Promise.all([cleanupWorker?.close(), cleanupQueue?.close()]);
  cleanupWorker = null;
  cleanupQueue = null;
}

// Exposed for tests: run a named job once synchronously.
export { runJob };
