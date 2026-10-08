// ─── Hook: useStatus ──────────────────────────────────────────────────────────
// Manages status updates with 24-hour expiry, view tracking, and real-time sync.

import { useState, useEffect, useCallback } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import type { FireStatus } from '../types';
import { uploadFile, generateFileName, getFileExtension, deleteFile } from '../config/storage';
import { useBackend } from '../config/featureFlags';
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

function toDate(timestamp: any): Date {
  if (!timestamp) return new Date();
  if (timestamp.toDate) return timestamp.toDate();
  if (timestamp.seconds) return new Date(timestamp.seconds * 1000);
  return new Date(timestamp);
}

function isExpired(expiresAt: Date): boolean {
  return new Date() > expiresAt;
}

/** Map a backend status to the FireStatus shape the UI consumes. */
function backendToFireStatus(s: BackendStatus): FireStatus {
  return {
    statusId: s.statusId,
    userId: s.userId,
    displayName: s.displayName ?? '',
    userPhone: s.userPhone ?? null,
    photoURL: null, // avatar object-key resolution is Slice 6
    mediaUrl: s.mediaObjectKey, // object key until Slice 6 resolves to a URL
    mediaType: s.mediaType,
    thumbnailUrl: s.thumbnailObjectKey,
    durationMs: s.durationMs ?? IMAGE_STATUS_DURATION_MS,
    caption: s.caption,
    backgroundColor: s.backgroundColor,
    textColor: s.textColor,
    createdAt: new Date(s.createdAt),
    expiresAt: new Date(s.expiresAt),
    viewedBy: s.viewedBy,
    visibility: s.visibility,
  };
}

export function useStatus(currentUserId: string | null) {
  const [myStatuses,      setMyStatuses]      = useState<FireStatus[]>([]);
  const [contactStatuses, setContactStatuses] = useState<StatusGroup[]>([]);
  const [loading,         setLoading]         = useState(true);
  const [error,           setError]           = useState<string | null>(null);

  const backend = useBackend('status');

  useEffect(() => {
    if (!currentUserId) { setLoading(false); return; }

    if (backend) {
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
                userId: g.userId,
                displayName: g.displayName ?? '',
                userPhone: statuses[0]?.userPhone ?? null,
                photoURL: null,
                statuses,
                hasUnviewed: g.hasUnviewed,
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
    }

    const fsDb = db as ReturnType<typeof firestore>;

    const unsubscribe = fsDb
      .collection('statuses')
      .orderBy('createdAt', 'desc')
      .onSnapshot(
        (snapshot) => {
          try {
            const allStatuses: FireStatus[] = [];

            snapshot.forEach((docSnap) => {
              const data = docSnap.data();
              const status: FireStatus = {
                statusId:         docSnap.id,
                userId:           data.userId,
                displayName:      data.displayName,
                userPhone:        data.userPhone ?? null,
                photoURL:         data.photoURL || null,
                mediaUrl:         data.mediaUrl || null,
                mediaType:        data.mediaType,
                thumbnailUrl:     data.thumbnailUrl || null,
                durationMs:       data.durationMs || IMAGE_STATUS_DURATION_MS,
                caption:          data.caption || null,
                backgroundColor:  data.backgroundColor || null,
                textColor:        data.textColor || null,
                createdAt:        toDate(data.createdAt),
                expiresAt:        toDate(data.expiresAt),
                viewedBy:         data.viewedBy || [],
                visibility:       data.visibility || 'everyone',
                excludedUsers:    data.excludedUsers || [],
                selectedUsers:    data.selectedUsers || [],
              };
              if (!isExpired(status.expiresAt)) allStatuses.push(status);
            });

            const mine   = allStatuses.filter((s) => s.userId && s.userId === currentUserId);
            const others = allStatuses.filter((s) => s.userId && s.userId !== currentUserId);

            setMyStatuses(mine);

            const grouped = new Map<string, StatusGroup>();
            for (const status of others) {
              if (!grouped.has(status.userId)) {
                grouped.set(status.userId, {
                  userId: status.userId, displayName: status.displayName,
                  userPhone: status.userPhone ?? null, photoURL: status.photoURL,
                  statuses: [], hasUnviewed: false, latestTimestamp: status.createdAt,
                });
              }
              const group = grouped.get(status.userId)!;
              group.statuses.push(status);
              if (!status.viewedBy.includes(currentUserId)) group.hasUnviewed = true;
              if (status.createdAt > group.latestTimestamp) group.latestTimestamp = status.createdAt;
            }

            const groupArray = Array.from(grouped.values()).sort(
              (a, b) => b.latestTimestamp.getTime() - a.latestTimestamp.getTime(),
            );
            setContactStatuses(groupArray);
            setLoading(false);
          } catch (err) {
            console.error('[useStatus] Error processing statuses:', err);
            setError('Failed to load statuses');
            setLoading(false);
          }
        },
        (err) => {
          console.error('[useStatus] Snapshot error:', err);
          setError('Failed to sync statuses');
          setLoading(false);
        },
      );

    return () => unsubscribe();
  }, [currentUserId, backend]);

  const createStatus = useCallback(
    async (
      displayName: string, photoURL: string | null,
      mediaType: 'image' | 'video' | 'text', mediaUri: string | null,
      caption: string | null, backgroundColor: string | null, textColor: string | null,
      userPhone: string | null = null, durationMs?: number,
    ): Promise<string> => {
      if (!currentUserId) throw new Error('User not authenticated');

      if (backend) {
        let finalDuration = durationMs;
        if (!finalDuration) {
          finalDuration = mediaType === 'image' ? IMAGE_STATUS_DURATION_MS
            : mediaType === 'video' ? VIDEO_STATUS_DURATION_MS : TEXT_STATUS_DURATION_MS;
        }
        if (mediaType === 'video') finalDuration = Math.min(finalDuration, MAX_VIDEO_STATUS_MS);

        // Upload status media to the object store, store the returned key.
        let mediaObjectKey: string | null = null;
        if (mediaUri && mediaType !== 'text') {
          const { mediaService, fileSize } = await import('../services/mediaService');
          const sizeBytes = await fileSize(mediaUri);
          mediaObjectKey = await mediaService.upload(mediaUri, 'status', { sizeBytes });
        }

        const res = await endpoints.createStatus({
          displayName,
          userPhone,
          mediaObjectKey,
          mediaType,
          caption,
          backgroundColor,
          textColor,
          durationMs: finalDuration,
          visibility: 'everyone',
        });
        if (!res.ok) throw new Error(`createStatus failed: ${res.error.message}`);
        return res.data.statusId;
      }

      let mediaUrl: string | null = null;

      if (mediaUri && mediaType !== 'text') {
        const ext      = getFileExtension(mediaUri) || (mediaType === 'video' ? 'mp4' : 'jpg');
        const fileName = `status_${currentUserId}_${Date.now()}.${ext}`;
        mediaUrl = await uploadFile(mediaUri, 'status', { userId: currentUserId, fileName });
      }

      let finalDuration = durationMs;
      if (!finalDuration) {
        finalDuration = mediaType === 'image' ? IMAGE_STATUS_DURATION_MS
          : mediaType === 'video' ? VIDEO_STATUS_DURATION_MS : TEXT_STATUS_DURATION_MS;
      }
      if (mediaType === 'video') finalDuration = Math.min(finalDuration, MAX_VIDEO_STATUS_MS);

      const now       = new Date();
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const fsDb = db as ReturnType<typeof firestore>;

      const statusRef = await fsDb.collection('statuses').add({
        userId: currentUserId, displayName, userPhone, photoURL,
        mediaUrl, mediaType, thumbnailUrl: null, durationMs: finalDuration,
        caption, backgroundColor, textColor,
        createdAt: firestore.Timestamp.fromDate(now),
        expiresAt: firestore.Timestamp.fromDate(expiresAt),
        viewedBy: [], visibility: 'everyone',
      });

      return statusRef.id;
    },
    [currentUserId, backend],
  );

  const markAsViewed = useCallback(
    async (statusId: string) => {
      if (!currentUserId) return;
      try {
        if (backend) {
          await endpoints.viewStatus(statusId);
          return;
        }
        const fsDb = db as ReturnType<typeof firestore>;
        await fsDb.collection('statuses').doc(statusId).update({
          viewedBy: firestore.FieldValue.arrayUnion(currentUserId),
        });
      } catch (err) {
        console.error('[useStatus] Mark viewed error:', err);
      }
    },
    [currentUserId, backend],
  );

  const deleteStatus = useCallback(async (statusId: string, mediaUrl: string | null) => {
    try {
      if (backend) {
        // The server deletes the row and (in Slice 6) the media object.
        await endpoints.deleteStatus(statusId);
        return;
      }
      if (mediaUrl) {
        try { await deleteFile(mediaUrl); } catch (e) { console.warn('[useStatus] Storage delete warning:', e); }
      }
      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('statuses').doc(statusId).delete();
    } catch (err) {
      throw new Error('Failed to delete status');
    }
  }, [backend]);

  const deleteExpiredStatuses = useCallback(async () => {
    try {
      const fsDb   = db as ReturnType<typeof firestore>;
      const snap   = await fsDb.collection('statuses').where('expiresAt', '<=', new Date()).get();
      await Promise.all(snap.docs.map((d) => deleteStatus(d.id, d.data().mediaUrl || null)));
    } catch (err) {
      console.error('[useStatus] Cleanup error:', err);
    }
  }, [deleteStatus]);

  return {
    myStatuses, contactStatuses, loading, error,
    createStatus, markAsViewed, deleteStatus, deleteExpiredStatuses,
  };
}
