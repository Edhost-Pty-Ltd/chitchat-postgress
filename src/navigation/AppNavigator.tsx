// ─── Navigation ──────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { View, ActivityIndicator, StyleSheet, Text, TouchableOpacity, InteractionManager } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { useAuth } from '../context/AuthContext';
import { COLORS } from '../types/theme';
import { AppBg } from '../context/ThemeContext';
import { useWritePresence } from '../hooks/usePresence';

import { getAuth, signOut as firebaseSignOut } from '@react-native-firebase/auth';
import { endpoints } from '../api/endpoints';

// ── Eager imports for screens that are in the critical render path ────────────
import SplashScreen from '../screens/SplashScreen';
import SignInScreen from '../screens/SignInScreen';
import CreateAccountScreen from '../screens/CreateAccountScreen';
import ChatsScreen from '../screens/ChatsScreen';
// ── Lazy imports — only parsed/executed when first navigated to ───────────────
// React Navigation does not support React.lazy() directly on Stack.Screen.
// Each lazy component is wrapped in a Suspense boundary so the navigator
// always receives a real synchronous component reference.
// ── Lazy imports ──────────────────────────────────────────────────────────────
// A lazy screen that also exposes a `preload()` so we can warm its chunk during
// idle time after startup — then the first navigation to it is instant instead
// of paying the dynamic import() + module-eval cost on the JS thread.
type Preloadable<T> = React.FC<T> & { preload: () => Promise<unknown> };

function makeLazy<T extends object>(factory: () => Promise<{ default: React.ComponentType<T> }>): Preloadable<T> {
  const Lazy = lazy(factory);
  const Wrapped = ((props: T) => (
    <Suspense fallback={<ScreenFallback />}>
      <Lazy {...(props as any)} />
    </Suspense>
  )) as Preloadable<T>;
  // Kick the import once; the promise is cached by the bundler so repeat calls
  // (and the eventual real navigation) reuse the same in-flight/resolved chunk.
  let started: Promise<unknown> | null = null;
  Wrapped.preload = () => (started ??= factory());
  return Wrapped;
}

const ChatScreen                 = makeLazy(() => import('../screens/ChatScreen'));
const CallsScreen                = makeLazy(() => import('../screens/CallsScreen'));
const CalendarScreen             = makeLazy(() => import('../screens/CalenderScreen'));
const StatusScreen               = makeLazy(() => import('../screens/StatusScreen'));
const ContactsScreen             = makeLazy(() => import('../screens/ContactsScreen'));
const SettingsScreen             = makeLazy(() => import('../screens/SettingsScreen'));
const AppearanceScreen           = makeLazy(() => import('../screens/AppearanceScreen'));
const ProfileScreen              = makeLazy(() => import('../screens/ProfileScreen'));
const VideoCallScreen            = makeLazy(() => import('../screens/VideoCallScreen'));
const AudioCallScreen            = makeLazy(() => import('../screens/AudioCallScreen'));
const AccountSettingsScreen      = makeLazy(() => import('../screens/AccountSettingsScreen'));
const PrivacySettingsScreen      = makeLazy(() => import('../screens/PrivacySettingsScreen'));
const NotificationSettingsScreen = makeLazy(() => import('../screens/NotificationSettingsScreen'));
const ChangeNumberScreen         = makeLazy(() => import('../screens/ChangeNumberScreen'));
const NotificationsScreen        = makeLazy(() => import('../screens/NotificationsScreen'));
const LinkedDevicesScreen        = makeLazy(() => import('../screens/LinkedDevicesScreen'));
const BlockedContactsScreen      = makeLazy(() => import('../screens/BlockedContactsScreen'));
const BroadcastScreen            = makeLazy(() => import('../screens/BroadcastScreen'));
const DashboardScreen            = makeLazy(() => import('../screens/DashboardScreen'));

import { IncomingCallManager } from '../components';

const Stack = createNativeStackNavigator<RootStackParamList>();

function ScreenFallback() {
  // Render the app background (not a bare white view) so a not-yet-warmed chunk
  // reads as a brief themed placeholder rather than a flash.
  return (
    <View style={{ flex: 1 }}>
      <AppBg />
    </View>
  );
}

// Instant navigation: screens appear immediately with no slide transition.
const screenOptions = {
  headerShown: false,
  animation: 'none' as const,
  gestureEnabled: true,
} as const;

const modalOptions = {
  headerShown: false,
  animation: 'none' as const,
  gestureEnabled: true,
} as const;

export default function AppNavigator() {
  const { isSignedIn, loading, phone, displayName, isCompanion } = useAuth();

  // ── Presence: mark online while the app is in the foreground ─────────────
  // Lives here (not inside individual screens) so it tracks the full app
  // session — online:true when the app is foregrounded from anywhere,
  // online:false + lastSeen when the user switches to another app entirely.
  // Companions must not write the owner's presence — they'd fight the primary.
  const { userId } = useAuth();
  useWritePresence(isCompanion ? null : userId);

  // ── Warm the lazy screen chunks after startup ─────────────────────────────
  // Every navigated-to screen is React.lazy, so the FIRST navigation to each
  // otherwise blocks on its dynamic import() + module eval. Once the app is
  // signed in and idle, preload them (most-used first, lightly staggered) so by
  // the time the user navigates the chunk is already parsed and the screen
  // appears instantly. preload() is a no-op after the first call.
  useEffect(() => {
    if (!isSignedIn) return;
    const task = InteractionManager.runAfterInteractions(() => {
      const warm = [
        ChatScreen, StatusScreen, CallsScreen, CalendarScreen, // primary tabs
        ProfileScreen, DashboardScreen, ContactsScreen,        // common jumps
        SettingsScreen, BroadcastScreen, NotificationsScreen,  // secondary
      ];
      warm.forEach((screen, i) => {
        setTimeout(() => { void screen.preload?.(); }, i * 120);
      });
    });
    return () => task.cancel();
  }, [isSignedIn]);

  const [profileExists, setProfileExists] = useState<boolean | null>(null);
  const [profileCheckError, setProfileCheckError] = useState(false);

  const checkProfileExists = useCallback(async (retry = 0) => {
    if (phone === '+0000000000') { setProfileExists(true); return; }

    if (isCompanion) { setProfileExists(true); return; }

    try {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      const companionOwner = await AsyncStorage.getItem('linked_device_owner_uid');
      if (companionOwner) { setProfileExists(true); return; }
    } catch {}

    const currentUser = getAuth().currentUser;

    if (!currentUser) {
      if (retry < 10) {
        setTimeout(() => checkProfileExists(retry + 1), 300);
        return;
      }
      setProfileExists(false);
      return;
    }

    if (displayName) {
      setProfileExists(true);
      return;
    }

    try {
      setProfileCheckError(false);
      const res = await endpoints.getMe();
      if (res.ok) {
        setProfileExists(true);
      } else if (res.error.kind === 'api') {
        // Reached the backend: a 404 means the profile hasn't been created yet.
        // Any other HTTP error is treated as a connection issue (retry screen).
        if (res.error.status === 404) setProfileExists(false);
        else setProfileCheckError(true);
      } else {
        // Never reached the backend (offline/timeout) — fail open like before.
        setProfileExists(true);
      }
    } catch (err: any) {
      if (err?.message?.includes('offline') || err?.message === 'Timeout') {
        setProfileExists(true);
      } else {
        setProfileCheckError(true);
      }
    }
  }, [phone, displayName]);

  useEffect(() => {
    if (isSignedIn && !loading) {
      checkProfileExists();
    } else if (!isSignedIn) {
      setProfileExists(null);
      setProfileCheckError(false);
    }
  }, [isSignedIn, loading]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isSignedIn && profileExists === false && !profileCheckError && phone !== '+0000000000' && !isCompanion) {
      (async () => {
        await firebaseSignOut(getAuth());
      })();
    }
  }, [isSignedIn, profileExists, profileCheckError, phone, isCompanion]);

  if (loading) {
    return (
      <View style={styles.splash}>
        <AppBg />
        <ActivityIndicator size="large" color={COLORS.blue} />
      </View>
    );
  }

  if (isSignedIn && profileExists === null && !profileCheckError) {
    return (
      <View style={styles.splash}>
        <AppBg />
        <ActivityIndicator size="large" color={COLORS.blue} />
      </View>
    );
  }

  if (isSignedIn && profileCheckError) {
    return (
      <View style={styles.splash}>
        <AppBg />
        <Text style={styles.errorText}>Connection Issue</Text>
        <Text style={styles.errorSubtext}>
          Could not connect to the server. Please check your internet connection and try again.
        </Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => checkProfileExists()}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.retryButton, { backgroundColor: 'transparent', marginTop: 12 }]}
          onPress={() => { setProfileExists(true); setProfileCheckError(false); }}
        >
          <Text style={[styles.retryButtonText, { color: COLORS.blue }]}>Continue Offline</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const authenticated = isSignedIn && profileExists;

  return (
    <>
      <Stack.Navigator
        initialRouteName={authenticated ? 'Chats' : 'Splash'}
        screenOptions={screenOptions}
      >
          {authenticated ? (
            <>
              {/* Core screens — eager */}
              <Stack.Screen name="Chats" component={ChatsScreen} />

              {/* Secondary screens — lazy */}
              <Stack.Screen name="Chat" component={ChatScreen as any} />
              <Stack.Screen name="Calendar" component={CalendarScreen as any} />
              <Stack.Screen name="Calls" component={CallsScreen as any} />
              <Stack.Screen name="Status" component={StatusScreen as any} />
              <Stack.Screen name="Contacts" component={ContactsScreen as any} />

              {/* Business owner dashboard */}
              <Stack.Screen name="Dashboard" component={DashboardScreen as any} />

              {/* Settings group */}
              <Stack.Screen name="Settings" component={SettingsScreen as any} options={modalOptions} />
              <Stack.Screen name="Appearance" component={AppearanceScreen as any} options={modalOptions} />
              <Stack.Screen name="Profile" component={ProfileScreen as any} options={modalOptions} />

              {/* Call screens — full-screen modal */}
              <Stack.Screen name="VideoCall" component={VideoCallScreen as any} options={modalOptions} />
              <Stack.Screen name="AudioCall" component={AudioCallScreen as any} options={modalOptions} />

              {/* Account sub-screens */}
              <Stack.Screen name="AccountSettings" component={AccountSettingsScreen as any} />
              <Stack.Screen name="PrivacySettings" component={PrivacySettingsScreen as any} />
              <Stack.Screen name="NotificationSettings" component={NotificationSettingsScreen as any} />
              <Stack.Screen name="ChangeNumber" component={ChangeNumberScreen as any} />
              <Stack.Screen name="Notifications" component={NotificationsScreen as any} />
              <Stack.Screen name="LinkedDevices" component={LinkedDevicesScreen as any} />
              <Stack.Screen name="BlockedContacts" component={BlockedContactsScreen as any} />
              <Stack.Screen name="Broadcast" component={BroadcastScreen as any} />
            </>
          ) : (
            <>
              <Stack.Screen name="Splash" component={SplashScreen} />
              <Stack.Screen name="SignIn" component={SignInScreen} />
              <Stack.Screen name="CreateAccount" component={CreateAccountScreen} />
            </>
          )}
        </Stack.Navigator>

      {authenticated && <IncomingCallManager />}
    </>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorText: { color: COLORS.text, fontSize: 18, fontWeight: '600', marginBottom: 8 },
  errorSubtext: { color: COLORS.sub, fontSize: 14, textAlign: 'center', marginBottom: 24, paddingHorizontal: 40 },
  retryButton: { backgroundColor: COLORS.blue, paddingHorizontal: 32, paddingVertical: 12, borderRadius: 8 },
  retryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});