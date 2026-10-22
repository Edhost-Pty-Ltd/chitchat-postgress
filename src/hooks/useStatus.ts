// ─── Hook: useStatus ──────────────────────────────────────────────────────────
// Status management via backend REST + Socket.IO.
//
// COMPANION NOTE
//   `currentUserId` is the account that owns these statuses (on a companion
//   it's the owner's uid). A companion posts as the owner, but it must not
//   mark statuses as viewed — that would record the OWNER as a viewer — so
//   markAsViewed is skipped when `isCompanion` is true (the backend also
//   treats a companion's view as a no-op). Deleting is owner-only on the
//   backend; StatusScreen hides the delete action on companions.

import React, { useState, useEffect, useCallback } from 'react';
import type { FireStatus } from '../types';
import { endpoints, type BackendStatus } from '../api/endpoints';
import { socketClient } from '../realtime/socket';

export const IMAGE_STATUS_DURATION_MS = 5000;
export const VIDEO_STATUS_DURATION_MS = 15000;
export const TEXT_STATUS_DURATION_MS  = 5000;
export const MAX_VIDEO_STATUS_MS      = 30000;

export interface StatusGroup {
  userId:          string;
  displayName:     string;
  userPhone:       string | null;
  photoURL:        string | null;
  statuses:        FireStatus[];
  hasUnviewed:     boolean;
  latestTimestamp: Date;
}

function backendToFireStatus(s: BackendStatus): FireStatus {
  return {
    statusId:        s.statusId,
    userId:          s.userId,
    displayName:     s.displayName ?? '',
    userPhone:       s.userPhone ?? null,
    photoURL:        null,
    mediaUrl:        s.mediaObjectKey,        // raw key — resolved by resolveStatusMedia
    mediaType:       s.mediaType,
    thumbnailUrl:    s.thumbnailObjectKey,    // raw key — resolved by resolveStatusMedia
    durationMs:      s.durationMs ?? IMAGE_STATUS_DURATION_MS,
    caption:         s.caption,
    backgroundColor: s.backgroundColor,
    textColor:       s.textColor,
    createdAt:       new Date(s.createdAt),
    expiresAt:       new Date(s.expiresAt),
    viewedBy:        s.viewedBy,
    visibility:      s.visibility,
  };
}

/** Resolve raw S3 object keys on FireStatus objects to presigned download URLs in-place. */
async function resolveStatusMedia(statuses: FireStatus[]): Promise<void> {
  const keys = new Set<string>();
  for (const s of statuses) {
    if (s.mediaUrl    && !/^https?:/.test(s.mediaUrl))    keys.add(s.mediaUrl);
    if (s.thumbnailUrl && !/^https?:/.test(s.thumbnailUrl)) keys.add(s.thumbnailUrl);
  }
  if (keys.size === 0) return;
  const { mediaService } = await import('../services/mediaService');
  const resolved = await mediaService.getDownloadUrls(Array.from(keys));
  for (const s of statuses) {
    if (s.mediaUrl    && resolved[s.mediaUrl])    s.mediaUrl    = resolved[s.mediaUrl];
    if (s.thumbnailUrl && resolved[s.thumbnailUrl]) s.thumbnailUrl = resolved[s.thumbnailUrl];
  }
}

export function useStatus(currentUserId: string | null, isCompanion = false) {
  const [myStatuses,      setMyStatuses]      = useState<FireStatus[]>([]);
  const [contactStatuses, setContactStatuses] = useState<StatusGroup[]>([]);
  const [loading,         setLoading]         = useState(true);
  const [error,           setError]           = useState<string | null>(null);

  // Keep a stable ref to `load` so createStatus / deleteStatus can call it
  // without being listed as a useCallback dependency.
  const loadRef = React.useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!currentUserId) { setLoading(false); return; }
    let active = true;

    const load = async () => {
      const res = await endpoints.listStatuses();
      if (!active) return;
      if (res.ok) {
        const mine   = res.data.myStatuses.map(backendToFireStatus);
        const others = res.data.contactStatuses.map((g) => {
          const statuses = g.statuses.map(backendToFireStatus);
          return {
            userId:          g.userId,
            displayName:     g.displayName ?? '',
            userPhone:       statuses[0]?.userPhone ?? null,
            photoURL:        null,
            statuses,
            hasUnviewed:     g.hasUnviewed,
            latestTimestamp: statuses.reduce(
              (max, s) => (s.createdAt > max ? s.createdAt : max),
              statuses[0]?.createdAt ?? new Date(0),
            ),
          };
        });

        // Show the list IMMEDIATELY with raw object keys — the UI can render
        // text/background statuses without waiting for presigned URLs.
        setMyStatuses(mine);
        setContactStatuses(others);
        setLoading(false);

        // Resolve presigned download URLs in the background, then update state
        // once they're ready. This avoids blocking the initial render on URL signing.
        resolveStatusMedia([...mine, ...others.flatMap((g) => g.statuses)])
          .then(() => {
            if (!active) return;
            setMyStatuses([...mine]);
            setContactStatuses([...others]);
          })
          .catch(() => {});
      } else {
        setError(String(res.error.code));
        setLoading(false);
      }
    };

    void socketClient.connect().then(load).catch(() => load());
    loadRef.current = load;

    // Collapse bursts of status events into a single refetch. With the
    // mediaService URL cache, the re-resolve on reload is near-free for keys
    // already seen, so the remaining cost is one /statuses GET per burst.
    let resyncTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleResync = () => {
      if (resyncTimer) return;
      resyncTimer = setTimeout(() => { resyncTimer = null; void load(); }, 500);
    };

    const unsubs = [
      socketClient.subscribe('status:update', scheduleResync),
      socketClient.subscribe('status:viewed', scheduleResync),
      socketClient.subscribe('client:reconnect', () => void load()),
    ];
    return () => {
      active = false;
      loadRef.current = null;
      if (resyncTimer) { clearTimeout(resyncTimer); resyncTimer = null; }
      unsubs.forEach((u) => u());
    };
  }, [currentUserId]);

  const createStatus = useCallback(
    async (
      displayName: string, _photoURL: string | null,
      mediaType: 'image' | 'video' | 'text', mediaUri: string | null,
      caption: string | null, backgroundColor: string | null, textColor: string | null,
      userPhone: string | null = null, durationMs?: number,
    ): Promise<string> => {
      if (!currentUserId) throw new Error('User not authenticated');

      let finalDuration = durationMs ?? (
        mediaType === 'image' ? IMAGE_STATUS_DURATION_MS
        : mediaType === 'video' ? VIDEO_STATUS_DURATION_MS : TEXT_STATUS_DURATION_MS
      );
      if (mediaType === 'video') finalDuration = Math.min(finalDuration, MAX_VIDEO_STATUS_MS);

      let mediaObjectKey: string | null = null;
      if (mediaUri && mediaType !== 'text') {
        const { mediaService, fileSize } = await import('../services/mediaService');
        mediaObjectKey = await mediaService.upload(mediaUri, 'status', {
          sizeBytes: await fileSize(mediaUri),
        });
      }

      const res = await endpoints.createStatus({
        displayName, userPhone, mediaObjectKey, mediaType,
        caption, backgroundColor, textColor,
        durationMs: finalDuration, visibility: 'everyone',
      });
      if (!res.ok) throw new Error(`createStatus failed: ${res.error.message}`);
      // Reload immediately so myStatuses updates without waiting for a socket event.
      void loadRef.current?.();
      return res.data.statusId;
    },
    [currentUserId],
  );

  const markAsViewed = useCallback(
    async (statusId: string) => {
      if (!currentUserId) return;
      // Companions share the owner's uid; a view from here would make it look
      // like the owner viewed the status. Skip the call entirely.
      if (isCompanion) return;
      try { await endpoints.viewStatus(statusId); } catch (err) {
        console.error('[useStatus] Mark viewed error:', err);
      }
    },
    [currentUserId, isCompanion],
  );

  const deleteStatus = useCallback(async (statusId: string, _mediaUrl: string | null) => {
    try {
      await endpoints.deleteStatus(statusId);
    } catch {
      throw new Error('Failed to delete status');
    }
  }, []);

  const deleteExpiredStatuses = useCallback(async () => {
    // Server-side scheduled job handles expiry (Slice 7).
  }, []);

  const reload = useCallback(() => {
    void loadRef.current?.();
  }, []);

  return {
    myStatuses, contactStatuses, loading, error,
    createStatus, markAsViewed, deleteStatus, deleteExpiredStatuses, reload,
  };
}
