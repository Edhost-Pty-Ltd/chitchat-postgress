// ─── usePushNotifications Hook ────────────────────────────────────────────────
// Handles expo-notifications setup, permissions, and push token registration.

import { useState, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';

let Notifications: any = null;
try {
  Notifications = require('expo-notifications');
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
} catch {
  console.warn('[usePushNotifications] expo-notifications not available. Push notifications disabled.');
}

export function usePushNotifications(userId: string | null) {
  const [expoPushToken, setExpoPushToken] = useState<string | null>(null);
  const [notification, setNotification] = useState<any | null>(null);
  const notificationListener = useRef<any>();
  const responseListener = useRef<any>();

  useEffect(() => {
    if (!userId || !Notifications) return;

    registerForPushNotificationsAsync().then((token) => {
      if (token) {
        setExpoPushToken(token);
        savePushToken(userId, token);
      }
    });

    notificationListener.current = Notifications.addNotificationReceivedListener((notif: any) => {
      console.log('[usePushNotifications] Notification received:', notif);
      setNotification(notif);
    });

    responseListener.current = Notifications.addNotificationResponseReceivedListener((response: any) => {
      console.log('[usePushNotifications] Notification response:', response);
      handleNotificationResponse(response);
    });

    return () => {
      if (notificationListener.current) Notifications.removeNotificationSubscription(notificationListener.current);
      if (responseListener.current)     Notifications.removeNotificationSubscription(responseListener.current);
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
    console.log('[usePushNotifications] Push token:', token);
    return token;
  } catch (error) {
    console.error('[usePushNotifications] Error getting push token:', error);
    return null;
  }
}

async function savePushToken(userId: string, token: string) {
  try {
    const fsDb = db as ReturnType<typeof firestore>;
    await fsDb.collection('users').doc(userId).set(
      { pushToken: token, pushTokenUpdatedAt: firestore.FieldValue.serverTimestamp(), platform: Platform.OS },
      { merge: true },
    );
    console.log('[usePushNotifications] Push token saved');
  } catch (error) {
    console.error('[usePushNotifications] Error saving push token:', error);
  }
}

function handleNotificationResponse(response: any) {
  const data = response.notification.request.content.data;
  console.log('[usePushNotifications] Notification data:', data);
}

export async function sendLocalNotification(title: string, body: string, data?: any) {
  if (!Notifications) return;
  await Notifications.scheduleNotificationAsync({
    content: { title, body, data },
    trigger: null,
  });
}
