// ─── Navigation ──────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { View, ActivityIndicator, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { useAuth } from '../context/AuthContext';
import { COLORS } from '../types/theme';
import { AppBg } from '../context/ThemeContext';

import { getAuth, signOut as firebaseSignOut } from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';

// ── Eager imports for screens that are in the critical render path ────────────
import SplashScreen from '../screens/SplashScreen';
import SignInScreen from '../screens/SignInScreen';
import CreateAccountScreen from '../screens/CreateAccountScreen';
import ChatsScreen from '../screens/ChatsScreen';


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

import { IncomingCallManager } from '../components';

const Stack = createNativeStackNavigator<RootStackParamList>();

// Minimal fallback while a lazy screen chunk loads — invisible to the user
// since native screens transition in with an animation anyway.
function ScreenFallback() {
  return <View style={{ flex: 1 }} />;
}

// Shared screen transition options — instant slide with no shadow flicker.
const screenOptions = {
  headerShown: false,
  animation: 'slide_from_right' as const,
  animationDuration: 200,
  gestureEnabled: true,
} as const;

const modalOptions = {
  headerShown: false,
  animation: 'slide_from_bottom' as const,
  animationDuration: 250,
  gestureEnabled: true,
} as const;

export default function AppNavigator() {
  const { isSignedIn, loading, phone, displayName } = useAuth();

  // profileExists: null = still checking, true/false = done
  const [profileExists, setProfileExists] = useState<boolean | null>(null);
  const [profileCheckError, setProfileCheckError] = useState(false);

  // ── Profile existence check ─────────────────────────────────────────────
  // AuthContext.signIn() already fetches the user profile and sets displayName.
  // If displayName is populated we can skip the extra Firestore round-trip.
  // We still fall back to a Firestore check for existing sessions where the
  // displayName may not yet be cached in AsyncStorage.
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
      const fsDb = db as ReturnType<typeof firestore>;
      const snap = await fsDb.collection('users').doc(currentUser.uid).get();
      setProfileExists(snap.exists);
    } catch (err: any) {
      if (err?.code === 'unavailable' || err?.message?.includes('offline') || err?.message === 'Timeout') {
        setProfileExists(true); // optimistic offline
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
      (async () => {
        await firebaseSignOut(getAuth());
      })();
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
            </>
          ) : (
            <>
              <Stack.Screen name="Splash" component={SplashScreen} options={{ animation: 'fade' }} />
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
