// src/utils/trackProfileView.ts
//
// Records a profile view by calling the recordProfileView Cloud Function.
//
// Running the increment server-side (Issue 8 fix):
//   - Prevents client-side inflation — a motivated caller cannot call
//     increment() in a loop because the server controls the write.
//   - Fixes the first-ever increment: the client-side Firestore rule required
//     `profileViews == resource.data.profileViews + 1`, which errors when the
//     field doesn't exist yet. Admin SDK FieldValue.increment() handles that.
//
// Debounced per-viewer per-day by the AsyncStorage guard in ChatScreen.

import functions from '@react-native-firebase/functions';

export async function trackProfileView(viewedUid: string): Promise<void> {
  if (!viewedUid) return;
  try {
    await functions().httpsCallable('recordProfileView')({ viewedUid });
  } catch (err) {
    console.warn('[trackProfileView] failed:', err);
  }
}
