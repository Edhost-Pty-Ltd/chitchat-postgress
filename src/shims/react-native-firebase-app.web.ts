// ─── Web Shim: @react-native-firebase/app ────────────────────────────────────
// On web, we use the Firebase JS SDK directly. This shim re-exports the JS SDK
// equivalents so code importing from @react-native-firebase/app works on web.

import { initializeApp, getApps, getApp } from 'firebase/app';

export { initializeApp, getApps, getApp };
export default { initializeApp, getApps, getApp };
