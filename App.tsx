import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { enableScreens } from 'react-native-screens';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// Import Firebase config FIRST to ensure it's initialized before any contexts
import './src/config/firebase';

import { AuthProvider, useAuth } from './src/context/AuthContext';
import { ThemeProvider } from './src/context/ThemeContext';
import { CallProvider } from './src/context/CallContext';
import { NotificationProvider } from './src/context/NotificationContext';
import { FloatingCallProvider } from './src/context/FloatingCallContext';
import { CartProvider } from './src/context/CartContext';
import AppNavigator from './src/navigation/AppNavigator';
import ToastOverlay from './src/components/ToastNotification';
import { FloatingCallManager } from './src/components/FloatingCallManager';
import { BiometricGate } from './src/components/BiometricGate';
import { usePushNotifications } from './src/hooks/usePushNotifications';

// Disable native screens on web to avoid touch/interaction issues
if (Platform.OS === 'web') {
  enableScreens(false);

  // Lock html/body/#root to viewport so the gradient fills the screen
  // and there is no white background showing on overscroll.
  if (typeof document !== 'undefined') {
    const css = `
      html, body, #root { height: 100%; margin: 0; overflow: hidden; }
      body { background-color: #0a2463; overscroll-behavior: none; }
    `;
    const style = document.createElement('style');
    style.appendChild(document.createTextNode(css));
    document.head.appendChild(style);
  }
} else {
  enableScreens(true);
}

// On web, refresh the inactivity timer on any user interaction
function ActivityWatcher() {
  const { refreshActivity } = useAuth();

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const events = ['mousemove', 'keydown', 'pointerdown', 'touchstart', 'scroll'];
    events.forEach((e) => window.addEventListener(e, refreshActivity, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, refreshActivity));
  }, [refreshActivity]);

  return null;
}

// Push notification setup.
//
// The registration is keyed on the OWNER uid (from AuthContext), not the
// Firebase Auth uid. On a companion device the two differ — the companion
// has its own anonymous auth uid, but notifications belong to the owner's
// account, so tokens are stored under users/{ownerUid}/pushTokens/{deviceId}
// and every linked device registers its own token independently.
function PushNotificationManager() {
  const { ownerUid } = useAuth();
  usePushNotifications(ownerUid);
  return null;
}

export default function App() {
  // Global handler for unhandled promise rejections
  useEffect(() => {
    if (Platform.OS === 'web') {
      // Web-specific promise rejection handler
      const handleRejection = (event: PromiseRejectionEvent) => {
        const error = event.reason;
        // Suppress auth/no-current-user errors as they're expected before sign-in
        if (error?.code === 'auth/no-current-user' || error?.message?.includes('no-current-user')) {
          console.warn('[App] Suppressed expected auth error:', error.message);
          event.preventDefault();
          return;
        }
        // Let other errors through
        console.error('[App] Unhandled promise rejection:', error);
      };

      if (typeof window !== 'undefined') {
        window.addEventListener('unhandledrejection', handleRejection as any);
        return () => window.removeEventListener('unhandledrejection', handleRejection as any);
      }
    } else {
      // React Native - use global error handler
      const ErrorUtils = (global as any).ErrorUtils;
      if (ErrorUtils) {
        const originalHandler = ErrorUtils.getGlobalHandler();

        ErrorUtils.setGlobalHandler((error: any, isFatal?: boolean) => {
          // Suppress auth/no-current-user errors
          if (error?.code === 'auth/no-current-user' || error?.message?.includes('no-current-user')) {
            console.warn('[App] Suppressed expected auth error:', error.message);
            return;
          }
          // Pass other errors to original handler
          if (originalHandler) {
            originalHandler(error, isFatal);
          }
        });

        return () => {
          if (originalHandler) {
            ErrorUtils.setGlobalHandler(originalHandler);
          }
        };
      }
    }
  }, []);

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <CallProvider>
            <NotificationProvider>
              <FloatingCallProvider>
                <CartProvider>
                  <ActivityWatcher />
                  <PushNotificationManager />
                  <NavigationContainer>
                    <StatusBar style="auto" />
                    <AppNavigator />
                    <ToastOverlay />
                    <FloatingCallManager />
                    <BiometricGate />
                  </NavigationContainer>
                </CartProvider>
              </FloatingCallProvider>
            </NotificationProvider>
          </CallProvider>
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}