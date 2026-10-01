// ─── Notification Context ────────────────────────────────────────────────────
// Push notification system with native device notifications support.
import React, {
  createContext, useContext, useState, useCallback, useRef, useEffect,
} from 'react';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { useAuth } from '../hooks/useAuth';
import { useNotificationSync } from '../hooks/useNotificationSync';

// NOTE: setNotificationHandler is already configured in usePushNotifications.ts.
// We do NOT call it here again — calling it twice causes a render crash.

// ─── Helper: Format notification time ────────────────────────────────────────
function formatNotificationTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 14) return '1 week ago';
  return date.toLocaleDateString();
}

export type NotifType = 'message' | 'call' | 'number_change' | 'system';

export interface AppNotification {
  id:        string;
  type:      NotifType;
  title:     string;
  body:      string;
  time:      string;
  read:      boolean;
  /** Optional — user ID to navigate to chat with when tapped */
  contactId?: string;
}

interface NotificationContextValue {
  notifications:  AppNotification[];
  unreadCount:    number;
  messageCount:   number;
  callCount:      number;
  toast:          AppNotification | null;
  pushNotification: (n: Omit<AppNotification, 'id' | 'time' | 'read'>) => void;
  dismissToast:   () => void;
  markAllRead:    () => void;
  markRead:       (id: string) => void;
  clearAll:       () => void;
}

const NotificationContext = createContext<NotificationContextValue>({
  notifications:    [],
  unreadCount:      0,
  messageCount:     0,
  callCount:        0,
  toast:            null,
  pushNotification: () => {},
  dismissToast:     () => {},
  markAllRead:      () => {},
  markRead:         () => {},
  clearAll:         () => {},
});

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [toast, setToast]                 = useState<AppNotification | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Request notification permissions on mount ─────────────────────
  useEffect(() => {
    registerForPushNotificationsAsync();
  }, []);

  async function registerForPushNotificationsAsync() {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#4A99E9',
      });
    }

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    
    if (finalStatus !== 'granted') {
      console.log('[Notifications] Permission not granted');
      return;
    }
  }

  const pushNotification = useCallback(
    async (n: Omit<AppNotification, 'id' | 'time' | 'read'>) => {
      const callId = Math.random().toString(36).substring(7);
      console.log(`[NotificationContext-${callId}] pushNotification called with:`, n);
      
      const now = new Date();
      const notif: AppNotification = {
        ...n,
        id:   `${Date.now()}-${Math.random()}`,
        time: formatNotificationTime(now),
        read: false,
      };

      // Add to inbox
      setNotifications((prev) => [notif, ...prev]);

      // Show toast — auto-dismiss after 4 s
      setToast(notif);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 4000);

      // Send native device notification
      try {
        await Notifications.scheduleNotificationAsync({
          content: {
            title: notif.title,
            body: notif.body,
            sound: true,
            data: { 
              contactId: notif.contactId,
              type: notif.type,
            },
          },
          trigger: null,
        });
      } catch (error) {
        console.log(`[NotificationContext-${callId}] Failed to send native notification:`, error);
      }
    },
    [],
  );

  // ── Sync real-time notifications from Firestore ───────────────────
  // MUST be after pushNotification is defined — it is passed directly
  // so the hook never needs to call useNotifications() itself.
  useNotificationSync(user?.uid ?? null, pushNotification);

  const dismissToast = useCallback(() => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(null);
  }, []);

  const markRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => n.id === id ? { ...n, read: true } : n),
    );
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const clearAll = useCallback(() => setNotifications([]), []);

  // Calculate counters
  const unreadCount = notifications.filter((n) => !n.read).length;
  const messageCount = notifications.filter((n) => !n.read && n.type === 'message').length;
  const callCount = notifications.filter((n) => !n.read && n.type === 'call').length;

  // Update app badge count
  useEffect(() => {
    Notifications.setBadgeCountAsync(unreadCount).catch((err) => {
      console.log('[Notifications] Failed to set badge count:', err);
    });
  }, [unreadCount]);

  return (
    <NotificationContext.Provider value={{
      notifications, unreadCount, messageCount, callCount, toast,
      pushNotification, dismissToast,
      markRead, markAllRead, clearAll,
    }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  return useContext(NotificationContext);
}
