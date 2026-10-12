// ─── Hook: useStatus ──────────────────────────────────────────────────────────
// Status management via backend REST + Socket.IO.

import { useState, useEffect, useCallback } from 'react';
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
    mediaUrl:        s.mediaObjectKey,
    mediaType:       s.mediaType,
    thumbnailUrl:    s.thumbnailObjectKey,
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

export function useStatus(currentUserId: string | null) {
  const [myStatuses,      setMyStatuses]      = useState<FireStatus[]>([]);
  const [contactStatuses, setContactStatuses] = useState<StatusGroup[]>([]);
  const [loading,         setLoading]         = useState(true);
  const [error,           setError]           = useState<string | null>(null);

  useEffect(() => {
    if (!currentUserId) { setLoading(false); return; }
    let active = true;

    const load = async () => {
      const res = await endpoints.listStatuses();
      if (!active) return;
      if (res.ok) {
        setMyStatuses(res.data.myStatuses.map(backendToFireStatus));
        setContactStatuses(
          res.data.contactStatuses.map((g) => {
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
          }),
        );
      } else {
        setError(String(res.error.code));
      }
      setLoading(false);
    };

    void socketClient.connect().then(load).catch(() => load());
    const unsubs = [
      socketClient.subscribe('status:update', () => void load()),
      socketClient.subscribe('status:viewed', () => void load()),
    ];
    return () => { active = false; unsubs.forEach((u) => u()); };
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
      return res.data.statusId;
    },
    [currentUserId],
  );

  const markAsViewed = useCallback(
    async (statusId: string) => {
      if (!currentUserId) return;
      try { await endpoints.viewStatus(statusId); } catch (err) {
        console.error('[useStatus] Mark viewed error:', err);
      }
    },
    [currentUserId],
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

  return {
    myStatuses, contactStatuses, loading, error,
    createStatus, markAsViewed, deleteStatus, deleteExpiredStatuses,
  };
}
