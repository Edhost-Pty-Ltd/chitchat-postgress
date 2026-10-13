// ─── Navigation ──────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { View, ActivityIndicator, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { useAuth } from '../context/AuthContext';
import { COLORS } from '../types/theme';
import { AppBg } from '../context/ThemeContext';

import { getAuth, signOut as firebaseSignOut } from '@react-native-firebase/auth';
import { endpoints } from '../api/endpoints';

// ── Eager imports ─────────────────────────────────────────────────────────────
import SplashScreen      from '../screens/SplashScreen';
import SignInScreen      from '../screens/SignInScreen';
import CreateAccountScreen from '../screens/CreateAccountScreen';
import TabNavigator      from './TabNavigator';

// ── Lazy imports — only parsed/executed when first navigated to ───────────────
// React Navigation does not support React.lazy() directly on Stack.Screen.
// Each lazy component is wrapped in a Suspense boundary so the navigator
// always receives a real synchronous component reference.
function makeLazy<T extends object>(factory: () => Promise<{ default: React.ComponentType<T> }>) {
  const Lazy = lazy(factory);
  const Wrapped = (props: T) => (
    <Suspense fallback={<ScreenFallback />}>
      <Lazy {...(props as any)} />
    </Suspense>
  );
  return Wrapped;
}

const ChatScreen                 = makeLazy(() => import('../screens/ChatScreen'));
const ContactsScreen             = makeLazy(() => import('../screens/ContactsScreen'));
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

import { IncomingCallManager } from '../components';

const Stack = createNativeStackNavigator<RootStackParamList>();

// Minimal fallback while a lazy screen chunk loads.
function ScreenFallback() {
  return <View style={{ flex: 1 }} />;
}

// ── Transition presets ────────────────────────────────────────────────────────
// Push screens: platform-native slide — 'default' uses the OS animation (slide
// on iOS, fade-up on Android). 180 ms is snappier than the previous 200 ms.
const screenOptions = {
  headerShown:              false,
  animation:                'default' as const,
  animationDuration:        180,
  gestureEnabled:           true,
  fullScreenGestureEnabled: true,   // allows swipe-back from anywhere on screen
} as const;

// Modal-style push (settings, profile, calls) — slide up from bottom.
const modalOptions = {
  headerShown:     false,
  animation:       'slide_from_bottom' as const,
  animationDuration: 220,
  gestureEnabled:  true,
} as const;

export default function AppNavigator() {
  const { isSignedIn, loading, phone, displayName } = useAuth();

  // profileExists: null = still checking, true/false = done
  const [profileExists, setProfileExists] = useState<boolean | null>(null);
  const [profileCheckError, setProfileCheckError] = useState(false);

  // ── Profile existence check ─────────────────────────────────────────────
  const checkProfileExists = useCallback(async (retry = 0) => {
    if (phone === '+0000000000') { setProfileExists(true); return; }

    const currentUser = getAuth().currentUser;

    if (!currentUser) {
      if (retry < 10) {
        setTimeout(() => checkProfileExists(retry + 1), 300);
        return;
      }
      setProfileExists(false);
      return;
    }

    // Fast path: displayName already populated in AuthContext means profile exists
    if (displayName) {
      setProfileExists(true);
      return;
    }

    try {
      setProfileCheckError(false);
      const res = await endpoints.getMe();
      if (res.ok) {
        // 200 → user row exists in the DB. displayName may be null (profile
        // incomplete) but the account is real — let them through.
        setProfileExists(true);
      } else if (!res.ok && (res.error as any)?.status === 404) {
        // 404 → no DB row for this Firebase UID → new user, route to sign-up.
        setProfileExists(false);
      } else {
        // Any other HTTP error (401, 500, …) or a NetworkError returned as
        // { ok: false } — treat optimistically so a transient backend issue
        // never locks the user out.
        setProfileExists(true);
      }
    } catch (err: any) {
      // Treat any network/timeout failure optimistically — let the user in and
      // let individual screens handle offline gracefully. The AbortError name
      // is the canonical signal from the 10s timeout in ApiClient.
      const isNetworkIssue =
        err?.name === 'AbortError' ||
        err?.message?.includes('Timeout') ||
        err?.message?.includes('offline') ||
        err?.message?.includes('Network request failed');
      if (isNetworkIssue) {
        setProfileExists(true); // optimistic: server unreachable, let user in
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

  // Sign out users authenticated without a profile
  useEffect(() => {
    if (isSignedIn && profileExists === false && !profileCheckError && phone !== '+0000000000') {
      (async () => { await firebaseSignOut(getAuth()); })();
    }
  }, [isSignedIn, profileExists, profileCheckError, phone]);

  // ── Loading states ──────────────────────────────────────────────────────

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
        initialRouteName={authenticated ? 'Tabs' : 'Splash'}
        screenOptions={screenOptions}
      >
        {authenticated ? (
          <>
            {/* ── Authenticated root: tab navigator (instant switching) ── */}
            <Stack.Screen
              name="Tabs"
              component={TabNavigator}
              options={{ animation: 'none' }}
            />

            {/* ── Push screens ─────────────────────────────────────────── */}
            <Stack.Screen name="Chat"      component={ChatScreen as any} />
            <Stack.Screen name="Contacts"  component={ContactsScreen as any} />
            <Stack.Screen name="Broadcast" component={BroadcastScreen as any} />

            {/* Account sub-screens */}
            <Stack.Screen name="AccountSettings"      component={AccountSettingsScreen as any} />
            <Stack.Screen name="PrivacySettings"      component={PrivacySettingsScreen as any} />
            <Stack.Screen name="NotificationSettings" component={NotificationSettingsScreen as any} />
            <Stack.Screen name="ChangeNumber"         component={ChangeNumberScreen as any} />
            <Stack.Screen name="Notifications"        component={NotificationsScreen as any} />
            <Stack.Screen name="LinkedDevices"        component={LinkedDevicesScreen as any} />
            <Stack.Screen name="BlockedContacts"      component={BlockedContactsScreen as any} />

            {/* ── Modal-style screens ───────────────────────────────────── */}
            <Stack.Screen name="Settings"   component={TabNavigator}        options={{ animation: 'none' }} />
            <Stack.Screen name="Appearance" component={AppearanceScreen as any} options={modalOptions} />
            <Stack.Screen name="Profile"    component={ProfileScreen as any}    options={modalOptions} />

            {/* ── Full-screen call modals ───────────────────────────────── */}
            <Stack.Screen name="VideoCall" component={VideoCallScreen as any} options={modalOptions} />
            <Stack.Screen name="AudioCall" component={AudioCallScreen as any} options={modalOptions} />

            {/* ── Legacy direct-route stubs (keep for deep links / old navigate() calls) */}
            <Stack.Screen name="Chats"    component={TabNavigator} options={{ animation: 'none' }} />
            <Stack.Screen name="Calls"    component={TabNavigator} options={{ animation: 'none' }} />
            <Stack.Screen name="Status"   component={TabNavigator} options={{ animation: 'none' }} />
            <Stack.Screen name="Calendar" component={TabNavigator} options={{ animation: 'none' }} />
          </>
        ) : (
          <>
            <Stack.Screen name="Splash"        component={SplashScreen}        options={{ animation: 'fade' }} />
            <Stack.Screen name="SignIn"        component={SignInScreen} />
            <Stack.Screen name="CreateAccount" component={CreateAccountScreen} />
          </>
        )}
      </Stack.Navigator>

      {authenticated && <IncomingCallManager />}
    </>
  );
}

const styles = StyleSheet.create({
  splash:          { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorText:       { color: COLORS.text, fontSize: 18, fontWeight: '600', marginBottom: 8 },
  errorSubtext:    { color: COLORS.sub, fontSize: 14, textAlign: 'center', marginBottom: 24, paddingHorizontal: 40 },
  retryButton:     { backgroundColor: COLORS.blue, paddingHorizontal: 32, paddingVertical: 12, borderRadius: 8 },
  retryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
