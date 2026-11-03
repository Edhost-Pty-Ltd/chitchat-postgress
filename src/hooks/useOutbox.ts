// ─── useOutbox ────────────────────────────────────────────────────────────────
// Persistent send queue for text messages. When the device is offline, messages
// are stored to AsyncStorage and shown as `uploadStatus: 'pending'` bubbles.
// On reconnect (or app resume), the queue is flushed in order: each item is
// sent via the REST API, the optimistic bubble is reconciled with the server
// message, and on permanent failure the bubble flips to 'failed'.
//
// Storage key: outbox_queue
// Format: JSON array of OutboxItem

import { useEffect, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { endpoints } from '../api/endpoints';
import type { BackendMessage } from '../api/endpoints';
import { useNetworkState } from './useNetworkState';

const OUTBOX_KEY = 'outbox_queue';
const MAX_ATTEMPTS = 4; // give up after 4 tries (transient failures only)

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OutboxItem {
  /** Stable client-generated id shared with the optimistic bubble. */
  clientId: string;
  chatId: string;
  text: string;
  /** ISO string — used to order the queue on flush. */
  queuedAt: string;
  attempts: number;
  /** Present when the item is currently being flushed (prevents double-send). */
  flushing?: boolean;
}

// ── Callbacks registered by useMessages instances ────────────────────────────
// Each open chat registers callbacks so the outbox can update optimistic bubbles
// without needing a context / event bus.

type PendingCallback  = (clientId: string, chatId: string, text: string) => void;
type SuccessCallback  = (clientId: string, message: BackendMessage)       => void;
type FailureCallback  = (clientId: string, chatId: string)                => void;

const pendingCallbacks  = new Map<string, PendingCallback>();
const successCallbacks  = new Map<string, SuccessCallback>();
const failureCallbacks  = new Map<string, FailureCallback>();

/** Called by useMessages to receive live status updates for its chat. */
export function registerOutboxCallbacks(
  chatId: string,
  onPending: PendingCallback,
  onSuccess: SuccessCallback,
  onFailure: FailureCallback,
): () => void {
  pendingCallbacks.set(chatId, onPending);
  successCallbacks.set(chatId, onSuccess);
  failureCallbacks.set(chatId, onFailure);
  return () => {
    pendingCallbacks.delete(chatId);
    successCallbacks.delete(chatId);
    failureCallbacks.delete(chatId);
  };
}

// ── Persistence helpers ───────────────────────────────────────────────────────

async function loadQueue(): Promise<OutboxItem[]> {
  try {
    const raw = await AsyncStorage.getItem(OUTBOX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveQueue(items: OutboxItem[]): Promise<void> {
  try {
    await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
  } catch (err) {
    console.warn('[useOutbox] saveQueue error:', err);
  }
}

// ── Enqueue ───────────────────────────────────────────────────────────────────

/**
 * Add a message to the outbox. Notifies any registered pending callbacks so
 * the chat screen shows a clock indicator immediately.
 */
export async function enqueueOutbox(
  chatId: string,
  clientId: string,
  text: string,
): Promise<void> {
  const item: OutboxItem = {
    clientId,
    chatId,
    text,
    queuedAt: new Date().toISOString(),
    attempts: 0,
  };

  const queue = await loadQueue();
  // Deduplicate: if this clientId is already queued (e.g. retry from UI), skip.
  if (!queue.some((q) => q.clientId === clientId)) {
    queue.push(item);
    await saveQueue(queue);
  }

  // Notify the open chat screen (if present) to show the pending bubble.
  pendingCallbacks.get(chatId)?.(clientId, chatId, text);
}

// ── Flush ─────────────────────────────────────────────────────────────────────

let flushInFlight = false;

/**
 * Attempt to send every queued item. Called automatically on reconnect and
 * can also be called imperatively (e.g. on app foreground).
 */
export async function flushOutbox(): Promise<void> {
  if (flushInFlight) return;
  flushInFlight = true;

  try {
    let queue = await loadQueue();
    if (queue.length === 0) return;

    // Process oldest-first.
    queue = queue.sort(
      (a, b) => new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime(),
    );

    const stillPending: OutboxItem[] = [];

    for (const item of queue) {
      if (item.flushing) {
        // Another process picked this up — skip but keep it.
        stillPending.push(item);
        continue;
      }

      const updated: OutboxItem = { ...item, flushing: true, attempts: item.attempts + 1 };

      try {
        const res = await endpoints.sendMessage(item.chatId, {
          clientId: item.clientId,
          type: 'text',
          text: item.text,
        });

        if (res.ok) {
          // Success — notify the chat screen to reconcile the bubble.
          successCallbacks.get(item.chatId)?.(item.clientId, res.data.message);
          // Dropped from queue (don't push to stillPending).
        } else if (updated.attempts >= MAX_ATTEMPTS) {
          // Permanent failure — mark the bubble as failed.
          failureCallbacks.get(item.chatId)?.(item.clientId, item.chatId);
          // Drop from queue after max attempts.
        } else {
          // Transient failure — keep for retry with incremented attempts.
          stillPending.push({ ...updated, flushing: false });
        }
      } catch {
        if (updated.attempts >= MAX_ATTEMPTS) {
          failureCallbacks.get(item.chatId)?.(item.clientId, item.chatId);
        } else {
          stillPending.push({ ...updated, flushing: false });
        }
      }
    }

    await saveQueue(stillPending);
  } finally {
    flushInFlight = false;
  }
}

// ── Remove a specific item (manual cancel / dismiss) ─────────────────────────

export async function removeFromOutbox(clientId: string): Promise<void> {
  const queue = await loadQueue();
  await saveQueue(queue.filter((q) => q.clientId !== clientId));
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Mount this once at the app root (or wherever it makes sense). It flushes the
 * outbox on mount (in case items were queued before the last session ended) and
 * again on every reconnect.
 */
export function useOutboxFlusher(): void {
  const flushedOnMount = useRef(false);

  const flush = useCallback(() => {
    void flushOutbox();
  }, []);

  // Flush on reconnect.
  useNetworkState(flush);

  // Flush on mount (handles items queued during a previous offline session).
  useEffect(() => {
    if (flushedOnMount.current) return;
    flushedOnMount.current = true;
    void flushOutbox();
  }, []);
}
