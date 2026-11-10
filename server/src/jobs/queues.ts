import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { logger } from '../config/logger.js';
import { bullConnection } from '../redis/client.js';
import { dispatchMessagePush, dispatchReactionPush, type PushMessageJob } from '../push/dispatcher.js';
import { getCall, updateCallStatus } from '../db/repositories/calls.js';
import { recordHistory } from '../realtime/handlers/signaling.js';
import { emitToUser } from '../realtime/emitter.js';
import { deleteObject } from '../media/presign.js';

/** BullMQ connection built from REDIS_URL (with TLS when configured). */
function connection(): ConnectionOptions {
  return bullConnection() as ConnectionOptions;
}

export const QUEUE_PUSH = 'push';
export const QUEUE_CALL_TIMEOUT = 'call-timeout';
export const QUEUE_DELETE_OBJECT = 'delete-object';

export const CALL_RING_TIMEOUT_MS = 60_000; // Req 8.10

let pushQueue: Queue | null = null;
let pushWorker: Worker | null = null;
let callQueue: Queue | null = null;
let callWorker: Worker | null = null;
let deleteObjectQueue: Queue | null = null;
let deleteObjectWorker: Worker | null = null;

/** The push queue (lazy). Jobs run off the REST request path (Req 6.6). */
export function getPushQueue(): Queue {
  if (!pushQueue) {
    pushQueue = new Queue(QUEUE_PUSH, {
      connection: connection(),
      defaultJobOptions: {
        attempts: 4, // initial + 3 retries (Req 6.5)
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    });
  }
  return pushQueue;
}

/** Enqueue a message push job. */
export async function enqueueMessagePush(job: PushMessageJob): Promise<void> {
  await getPushQueue().add('message', job);
}

export interface ReactionPushJob {
  chatId: string;
  messageId: string;
  senderId: string;    // message author — receives the push
  reactorId: string;
  reactorName: string;
  emoji: string;
}

/** Enqueue a reaction push job (notifies the message author). */
export async function enqueueReactionPush(job: ReactionPushJob): Promise<void> {
  await getPushQueue().add('reaction', job);
}

/** The call-timeout queue (lazy). Marks unanswered calls missed (Req 8.10). */
export function getCallQueue(): Queue {
  if (!callQueue) {
    callQueue = new Queue(QUEUE_CALL_TIMEOUT, {
      connection: connection(),
      defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000 },
    });
  }
  return callQueue;
}

/** Schedule a 60s unanswered-call → missed check (Req 8.10). */
export async function scheduleCallTimeout(callId: string): Promise<void> {
  await getCallQueue().add(
    'ring-timeout',
    { callId },
    { delay: CALL_RING_TIMEOUT_MS, jobId: `ring-${callId}` },
  );
}

/** The object-deletion queue (lazy). Retries object deletes (Req 10.11). */
export function getDeleteObjectQueue(): Queue {
  if (!deleteObjectQueue) {
    deleteObjectQueue = new Queue(QUEUE_DELETE_OBJECT, {
      connection: connection(),
      defaultJobOptions: {
        attempts: 4, // initial + 3 retries (Req 10.11)
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    });
  }
  return deleteObjectQueue;
}

/** Enqueue an object-store deletion (Req 10.10). No-op for empty keys. */
export async function enqueueDeleteObject(objectKey: string | null | undefined): Promise<void> {
  if (!objectKey) return;
  await getDeleteObjectQueue().add('delete', { objectKey });
}

/** Start the push worker. Call once at startup. */
export function startWorkers(): void {
  if (pushWorker) return;
  pushWorker = new Worker<PushMessageJob | ReactionPushJob>(
    QUEUE_PUSH,
    async (job) => {
      if (job.name === 'reaction') {
        const data = job.data as ReactionPushJob;
        const result = await dispatchReactionPush(data);
        logger.info({ messageId: data.messageId, emoji: data.emoji }, 'reaction push dispatched');
        return result;
      }
      const result = await dispatchMessagePush(job.data as PushMessageJob);
      logger.info({ ...result, messageId: (job.data as PushMessageJob).messageId }, 'push dispatched');
      return result;
    },
    { connection: connection() },
  );
  pushWorker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, err }, 'push job failed');
  });

  // Call ring-timeout worker: if a call is still ringing after 60s, mark it
  // missed, record history, and notify both parties (Req 8.10, 8.13).
  callWorker = new Worker<{ callId: string }>(
    QUEUE_CALL_TIMEOUT,
    async (job) => {
      const call = await getCall(job.data.callId);
      if (!call || call.status !== 'ringing') return;
      await updateCallStatus(call.id, 'missed');
      // Unanswered after 60s: callee gets 'missed', caller gets outgoing 'no_answer'.
      await recordHistory(call, 'no_answer', null);
      emitToUser(call.callee_id, 'call:missed', { callId: call.id, caller: call.caller_info });
      emitToUser(call.caller_id, 'call:signal', {
        callId: call.id,
        kind: 'state',
        data: { status: 'missed' },
        from: 'server',
      });
    },
    { connection: connection() },
  );
  callWorker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, err }, 'call-timeout job failed');
  });

  // Object-deletion worker: delete the referenced object, retrying on failure
  // and logging the key if it ultimately fails (Req 10.10, 10.11).
  deleteObjectWorker = new Worker<{ objectKey: string }>(
    QUEUE_DELETE_OBJECT,
    async (job) => {
      await deleteObject(job.data.objectKey);
    },
    { connection: connection() },
  );
  deleteObjectWorker.on('failed', (job, err) => {
    logger.warn({ objectKey: job?.data?.objectKey, err }, 'object deletion failed');
  });
}

export async function closeJobs(): Promise<void> {
  await Promise.all([
    pushWorker?.close(),
    pushQueue?.close(),
    callWorker?.close(),
    callQueue?.close(),
    deleteObjectWorker?.close(),
    deleteObjectQueue?.close(),
  ]);
  pushWorker = null;
  pushQueue = null;
  callWorker = null;
  callQueue = null;
  deleteObjectWorker = null;
  deleteObjectQueue = null;
}
