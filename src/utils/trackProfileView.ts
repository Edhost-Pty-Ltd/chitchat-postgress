// src/utils/trackProfileView.ts
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';

/**
 * Increments profileViews and profileViewsToday on users/{viewedUid}.
 *
 * Uses .update() (not .set+merge) so it unambiguously hits the `allow update`
 * rule that permits non-owner counter writes.
 *
 * profileViewsToday resets to 1 on a new calendar day — detected by comparing
 * the stored profileViewsDayKey with today's key before writing.
 *
 * Debounced per-viewer per-day in AsyncStorage by the call site in ChatScreen.
 */
export async function trackProfileView(viewedUid: string): Promise<void> {
  if (!viewedUid) return;
  try {
    const fsDb = db as ReturnType<typeof firestore>;
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    // Read the stored day key to decide increment vs reset for today's counter
    const userSnap = await fsDb.collection('users').doc(viewedUid).get();
    const storedDayKey: string = userSnap.exists
      ? (userSnap.data()?.profileViewsDayKey ?? '')
      : '';

    // When it's a new day, reset today's counter to 1.
    // When it's the same day, increment by 1.
    const todayValue = storedDayKey === todayKey
      ? firestore.FieldValue.increment(1)
      : 1;

    // Use update() — unambiguously triggers the `allow update` rule path.
    // The user doc always exists by the time a chat is open, so update() is safe.
    await fsDb.collection('users').doc(viewedUid).update({
      profileViews:          firestore.FieldValue.increment(1),
      profileViewsToday:     todayValue,
      profileViewsDayKey:    todayKey,
      profileViewsUpdatedAt: firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.warn('[trackProfileView] failed:', err);
  }
}
