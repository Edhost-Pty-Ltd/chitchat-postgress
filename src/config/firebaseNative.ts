// ─── React Native Firebase (Native Module) Initialization — Auth only ────────
// Firebase is used solely as the phone-OTP identity provider; all other data
// lives on the Postgres/Redis/S3 backend. React Native Firebase auto-initializes
// from google-services.json / GoogleService-Info.plist.
// On web, this module is a no-op — we use the Firebase JS SDK directly.

import { Platform } from 'react-native';

if (Platform.OS !== 'web') {
  const { getApps } = require('@react-native-firebase/app');
  const { getAuth } = require('@react-native-firebase/auth');

  try {
    if (getApps().length === 0) {
      console.error(
        '[Firebase Native] No Firebase app initialized. Verify google-services.json ' +
          '(Android) / GoogleService-Info.plist (iOS) is present and the google-services ' +
          'plugin is applied.',
      );
    } else {
      // Touch Auth so a misconfiguration surfaces at startup rather than at sign-in.
      getAuth();
    }
  } catch (error: any) {
    console.error('[Firebase Native] Auth initialization failed:', error?.message ?? error);
  }
}
