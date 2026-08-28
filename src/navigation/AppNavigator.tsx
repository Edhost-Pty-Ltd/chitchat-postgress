// ─── Navigation ──────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { View, ActivityIndicator, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { useAuth } from '../context/AuthContext';
import { COLORS } from '../types/theme';
import { AppBg } from '../context/ThemeContext';

import auth, { getAuth, signOut as firebaseSignOut } from '@react-native-firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../config/firebase';

import SplashScreen      from '../screens/SplashScreen';
import SignInScreen       from '../screens/SignInScreen';
import ChatsScreen        from '../screens/ChatsScreen';
import ChatScreen         from '../screens/ChatScreen';
import CallsScreen        from '../screens/CallsScreen';
import StatusScreen       from '../screens/StatusScreen';
import ContactsScreen     from '../screens/ContactsScreen';

import SettingsScreen     from '../screens/SettingsScreen';
import AppearanceScreen  from '../screens/AppearanceScreen';
import ProfileScreen     from '../screens/ProfileScreen';
import CreateAccountScreen from '../screens/CreateAccountScreen';
import VideoCallScreen    from '../screens/VideoCallScreen';
import AudioCallScreen    from '../screens/AudioCallScreen';

import AccountSettingsScreen      from '../screens/AccountSettingsScreen';
import PrivacySettingsScreen      from '../screens/PrivacySettingsScreen';
import NotificationSettingsScreen from '../screens/NotificationSettingsScreen';
import ChangeNumberScreen         from '../screens/ChangeNumberScreen';
import NotificationsScreen        from '../screens/NotificationsScreen';
import LinkedDevicesScreen        from '../screens/LinkedDevicesScreen';
import BlockedContactsScreen      from '../screens/BlockedContactsScreen';
import { IncomingCallManager } from '../components';

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function AppNavigator() {
  const { isSignedIn, loading, phone } = useAuth();
  
  console.log('[AppNavigator] Component render - isSignedIn:', isSignedIn, 'loading:', loading);

  // Profile existence state: null = loading, true/false = checked
  const [profileExists, setProfileExists] = useState<boolean | null>(null);
  const [profileCheckError, setProfileCheckError] = useState<boolean>(false);

  const checkProfileExists = useCallback(async (retry = 0) => {
    // Demo mode bypass — no Firebase user, skip Firestore check
    if (phone === '+0000000000') {
      console.log('[AppNavigator] Demo mode detected, skipping profile check');
      setProfileExists(true);
      return;
    }

    const authInstance = getAuth();
    const currentUser = authInstance.currentUser;
    console.log('[AppNavigator] checkProfileExists - currentUser:', currentUser?.uid, 'retry:', retry);

    if (!currentUser) {
      // Native Firebase auth may not have hydrated yet right after OTP
      // verification on a fresh install. Retry before concluding there is no
      // user — otherwise we'd set profileExists=false and erroneously sign the
      // user out, bouncing them back to the verify screen.
      if (retry < 10) {
        console.log('[AppNavigator] currentUser not ready, retrying in 500ms...');
        setTimeout(() => checkProfileExists(retry + 1), 500);
        return;
      }
      console.log('[AppNavigator] No current user after retries, setting profileExists to false');
      setProfileExists(false);
      return;
    }

    try {
      setProfileCheckError(false);
      setProfileExists(null); // reset to loading state
      console.log('[AppNavigator] Checking profile existence for user:', currentUser.uid);
      
      const userDocRef = doc(db, 'users', currentUser.uid);
      
      // Attempt to get document with timeout handling
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), 10000) // Reduced to 10 seconds
      );
      
      const userDoc = await Promise.race([
        getDoc(userDocRef),
        timeoutPromise
      ]);
      
      const exists = (userDoc as any).exists();
      console.log('[AppNavigator] Profile exists:', exists);
      setProfileExists(exists);
    } catch (error: any) {
      console.error('[AppNavigator] Profile check failed:', error);
      
      // If it's an offline error or timeout, allow user to continue (assume profile exists)
      // This prevents blocking the app when there's no internet
      if (error?.code === 'unavailable' || error?.message?.includes('offline') || error?.message === 'Timeout') {
        console.warn('[AppNavigator] Network unavailable or timeout, assuming profile exists');
        setProfileExists(true); // Optimistic: assume profile exists
      } else {
        setProfileCheckError(true);
      }
    }
  }, [phone]); // Re-create when phone changes (e.g., demo mode)

  // Check profile existence when user is authenticated
  useEffect(() => {
    console.log('[AppNavigator] Auth state changed - isSignedIn:', isSignedIn, 'loading:', loading);
    if (isSignedIn && !loading) {
      // Small delay to ensure Firebase auth state is fully synced
      const timer = setTimeout(() => {
        checkProfileExists();
      }, 100);
      return () => clearTimeout(timer);
    } else if (!isSignedIn) {
      // Reset profile state when signed out
      console.log('[AppNavigator] User signed out, resetting profile state');
      setProfileExists(null);
      setProfileCheckError(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn, loading]); // Removed checkProfileExists from deps to prevent re-runs

  // If user is authenticated but has no profile, sign them out
  // This forces them to go through the proper SignIn → CreateAccount flow
  useEffect(() => {
    console.log('[AppNavigator] Profile check state - isSignedIn:', isSignedIn, 'profileExists:', profileExists, 'profileCheckError:', profileCheckError);
    if (isSignedIn && profileExists === false && !profileCheckError && phone !== '+0000000000') {
      console.log('[AppNavigator] User authenticated without profile, signing out...');
      (async () => {
        const authInstance = getAuth();
        await firebaseSignOut(authInstance);
        // Auth context will handle the cleanup via onAuthStateChanged
      })();
    }
  }, [isSignedIn, profileExists, profileCheckError, phone]);

  // While hydrating from AsyncStorage show a branded splash
  if (loading) {
    return (
      <View style={styles.splash}>
        <AppBg />
        <ActivityIndicator size="large" color={COLORS.blue} />
      </View>
    );
  }

  // Show loading while checking profile existence
  if (isSignedIn && profileExists === null && !profileCheckError) {
    return (
      <View style={styles.splash}>
        <AppBg />
        <ActivityIndicator size="large" color={COLORS.blue} />
      </View>
    );
  }

  // Show error screen with retry if profile check failed
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
          onPress={() => {
            // Allow user to continue in offline mode
            setProfileExists(true);
            setProfileCheckError(false);
          }}
        >
          <Text style={[styles.retryButtonText, { color: COLORS.blue }]}>Continue Offline</Text>
        </TouchableOpacity>
      </View>
    );
  }

  console.log('[AppNavigator] Render decision - isSignedIn:', isSignedIn, 'profileExists:', profileExists, 'loading:', loading);

  return (
    <>
      <Stack.Navigator
        initialRouteName={
          isSignedIn && profileExists
            ? 'Chats'
            : 'Splash'
        }
        screenOptions={{ headerShown: false }}
      >
        {isSignedIn && profileExists ? (
          // ── Authenticated screens with profile ───────────────────────────
          <>
            <Stack.Screen name="Chats"       component={ChatsScreen}       />
            <Stack.Screen name="Chat"        component={ChatScreen}        />
            <Stack.Screen name="Calls"       component={CallsScreen}       />
            <Stack.Screen name="Status"      component={StatusScreen}      />
            <Stack.Screen name="Contacts"    component={ContactsScreen}    />
            <Stack.Screen name="Settings"    component={SettingsScreen}    />
            <Stack.Screen name="Appearance"      component={AppearanceScreen}      />
            <Stack.Screen name="Profile"         component={ProfileScreen}         />
            <Stack.Screen name="VideoCall"       component={VideoCallScreen}       />
            <Stack.Screen name="AudioCall"       component={AudioCallScreen}       />

            <Stack.Screen name="AccountSettings"      component={AccountSettingsScreen}      />
            <Stack.Screen name="PrivacySettings"      component={PrivacySettingsScreen}      />
            <Stack.Screen name="NotificationSettings" component={NotificationSettingsScreen} />
            <Stack.Screen name="ChangeNumber"         component={ChangeNumberScreen}         />
            <Stack.Screen name="Notifications"        component={NotificationsScreen}        />
            <Stack.Screen name="LinkedDevices"        component={LinkedDevicesScreen}        />
            <Stack.Screen name="BlockedContacts"      component={BlockedContactsScreen}      />
          </>
        ) : (
          // ── Unauthenticated screens (or authenticated without profile) ───
          <>
            <Stack.Screen name="Splash"         component={SplashScreen}         />
            <Stack.Screen name="SignIn"         component={SignInScreen}          />
            <Stack.Screen name="CreateAccount"  component={CreateAccountScreen}   />
          </>
        )}
      </Stack.Navigator>
      
      {/* Incoming call overlay - shows over all screens */}
      {isSignedIn && profileExists && <IncomingCallManager />}
    </>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  errorSubtext: {
    color: COLORS.sub,
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 24,
    paddingHorizontal: 40,
  },
  retryButton: {
    backgroundColor: COLORS.blue,
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryButtonText: {
    color: COLORS.white,
    fontSize: 16,
    fontWeight: '600',
  },
});
