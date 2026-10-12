// ─── usePushNotifications Hook ────────────────────────────────────────────────
import { useState, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { registerChatReplyCategory, handleNotificationReply } from './useNotificationReply';
import { endpoints } from '../api/endpoints';

let Notifications: any = null;
try {
  Notifications = require('expo-notifications');
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true,
      shouldShowBanner: true, shouldShowList: true,
    }),
  });
} catch {
  console.warn('[usePushNotifications] expo-notifications not available.');
}

function removeSubscription(sub: any) {
  if (!sub) return;
  try {
    if (typeof sub.remove === 'function') { sub.remove(); return; }
    if (typeof sub === 'function') sub();
  } catch {}
}

export function usePushNotifications(userId: string | null) {
  const [expoPushToken, setExpoPushToken] = useState<string | null>(null);
  const [notification,  setNotification]  = useState<any | null>(null);
  const notificationListener = useRef<any>(null);
  const responseListener     = useRef<any>(null);

  useEffect(() => {
    if (!userId || !Notifications) return;

    registerChatReplyCategory();

    registerForPushNotificationsAsync().then((token) => {
      if (token) { setExpoPushToken(token); savePushToken(userId, token); }
    });

    notificationListener.current = Notifications.addNotificationReceivedListener((notif: any) => {
      setNotification(notif);
    });

    responseListener.current = Notifications.addNotificationResponseReceivedListener(async (response: any) => {
      const handled = await handleNotificationReply(response);
      if (!handled) handleNotificationResponse(response);
    });

    if (Notifications.getLastNotificationResponseAsync) {
      Notifications.getLastNotificationResponseAsync()
        .then((response: any) => { if (response) handleNotificationReply(response); })
        .catch(() => {});
    }

    return () => {
      removeSubscription(notificationListener.current);
      removeSubscription(responseListener.current);
    };
  }, [userId]);

  return { expoPushToken, notification };
}

async function registerForPushNotificationsAsync(): Promise<string | null> {
  if (!Notifications) return null;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF231F7C',
    });
  }

  if (Platform.OS === 'web') return null;

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== 'granted') return null;

  try {
    const token = (await Notifications.getExpoPushTokenAsync({
      projectId: 'e68eeca5-8ee9-4c30-b23f-8cd3616b7c21',
    })).data;
    return token;
  } catch {
    return null;
  }
}

async function savePushToken(userId: string, token: string) {
  try {
    const res = await endpoints.registerPushToken(token, Platform.OS);
    if (!res.ok) console.error('[usePushNotifications] Backend token register failed:', res.error);
  } catch (error) {
    console.error('[usePushNotifications] Error saving push token:', error);
  }
}

export async function removePushTokenFromBackend(token: string): Promise<void> {
  try { await endpoints.removePushToken(token); } catch {}
}

function handleNotificationResponse(_response: any) {}

export async function sendLocalNotification(title: string, body: string, data?: any) {
  if (!Notifications) return;
  await Notifications.scheduleNotificationAsync({ content: { title, body, data }, trigger: null });
}
