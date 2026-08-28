// ─── Web Shim: @react-native-firebase/functions ──────────────────────────────
// On web, we use the Firebase JS SDK functions. This shim re-exports the JS SDK
// equivalents so code importing from @react-native-firebase/functions works on web.

import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'firebase/functions';

export { getFunctions, httpsCallable, connectFunctionsEmulator };
export default { getFunctions, httpsCallable, connectFunctionsEmulator };
