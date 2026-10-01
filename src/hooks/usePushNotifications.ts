// ─── usePushNotifications Hook ────────────────────────────────────────────────
// Handles expo-notifications setup, permissions, and push token registration.
//
// COMPANION NOTE
//   The parameter is the OWNER uid (the account whose notifications we want to
//   receive). On a companion device this is different from the Firebase Auth
//   uid. Tokens are stored per-device in a subcollection so both the primary
//   and its companions register independently:
//
//       users/{ownerUid}/pushTokens/{deviceId}   → { token, platform, updatedAt }
//
//   A server-side sender must fan out to all docs in that subcollection.

import { useState, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { DEVICE_ID_KEY } from './useLinkedDevices';

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

// ── Safe unsubscribe helper ───────────────────────────────────────────────────
function removeSubscription(sub: any) {
  if (!sub) return;
  try {
    if (typeof sub.remove === 'function') {
      sub.remove();
      return;
    }
    if (typeof sub === 'function') {
      sub();
    }
  } catch (err) {
    console.warn('[usePushNotifications] Error removing subscription (ignored):', err);
  }
}

function generateDeviceId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

async function getDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = generateDeviceId();
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function usePushNotifications(ownerUid: string | null) {
  const [expoPushToken, setExpoPushToken] = useState<string | null>(null);
  const [notification, setNotification] = useState<any | null>(null);
  const notificationListener = useRef<any>();
  const responseListener = useRef<any>();

  useEffect(() => {
    if (!ownerUid || !Notifications) return;

    registerForPushNotificationsAsync().then((token) => {
      if (token) {
        setExpoPushToken(token);
        savePushToken(ownerUid, token);
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
      if (notificationListener.current) removeSubscription(notificationListener.current);
      if (responseListener.current)     removeSubscription(responseListener.current);
    };
  }, [ownerUid]);

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

async function savePushToken(ownerUid: string, token: string) {
  try {
    const deviceId = await getDeviceId();
    const fsDb = db as ReturnType<typeof firestore>;

    await fsDb
      .collection('users').doc(ownerUid)
      .collection('pushTokens').doc(deviceId)
      .set(
        {
          token,
          platform: Platform.OS,
          updatedAt: firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

    console.log('[usePushNotifications] Push token saved for ownerUid:', ownerUid, 'device:', deviceId);
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