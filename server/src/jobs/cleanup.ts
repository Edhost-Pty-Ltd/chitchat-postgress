import { logger } from '../config/logger.js';
import {
  deleteExpiredStatuses,
  deleteExpiredMessages,
  deleteStaleCalls,
} from '../db/repositories/cleanup.js';
import { enqueueDeleteObject } from './queues.js';

export const STALE_CALL_THRESHOLD_HOURS = 3; // Req 11.3

/**
 * Hourly: delete expired statuses and their media objects (Req 11.1).
 * Returns the counts for logging (Req 11.6).
 */
export async function runStatusCleanup(): Promise<{ rows: number; objects: number }> {
  const { deleted, mediaKeys } = await deleteExpiredStatuses();
  for (const key of mediaKeys) await enqueueDeleteObject(key);
  logger.info({ job: 'cleanupStatuses', rows: deleted, objects: mediaKeys.length }, 'cleanup complete');
  return { rows: deleted, objects: mediaKeys.length };
}

/**
 * Daily: delete expired messages and their media objects (Req 11.2).
 */
export async function runMessageCleanup(): Promise<{ rows: number; objects: number }> {
  const { deleted, mediaKeys } = await deleteExpiredMessages();
  for (const key of mediaKeys) await enqueueDeleteObject(key);
  logger.info({ job: 'cleanupMessages', rows: deleted, objects: mediaKeys.length }, 'cleanup complete');
  return { rows: deleted, objects: mediaKeys.length };
}

/**
 * Every 30 min: delete stale call records (Req 11.3).
 */
export async function runStaleCallCleanup(): Promise<{ rows: number }> {
  const deleted = await deleteStaleCalls(STALE_CALL_THRESHOLD_HOURS);
  logger.info({ job: 'cleanupStaleCalls', rows: deleted }, 'cleanup complete');
  return { rows: deleted };
}
