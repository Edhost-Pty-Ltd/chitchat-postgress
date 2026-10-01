// ─── useLinkedDevices Hook ────────────────────────────────────────────────────
//
// Companion linking via Firebase Custom Tokens.
//
// Flow:
//   1. New device (unsigned) → createLinkRequest() → anon sign-in, writes
//      deviceLinkTokens/{requestId} with consumed:false, ownerUid:null.
//   2. New device displays QR (encodes requestId) + displayCode.
//   3. Signed-in device (primary) scans QR or types code.
//   4. Primary calls claimLinkRequest(requestId, ownerUid, ownerName):
//        a. Cloud Function mintCompanionToken() → returns a custom token
//           tagged { companion: true, deviceId } for the primary's uid.
//        b. Firestore transaction writes consumed:true, ownerUid, and the
//           custom token into the link doc, plus a linkedDevices entry.
//   5. New device's pollForApproval() reads the doc, sees the custom token,
//      and signs in with it — its auth.uid is now the owner's uid.
//
// Removal:
//   When the primary deletes users/{owner}/linkedDevices/{deviceId}:
//     • Firestore rules immediately stop honouring that companion's token
//       (see companionStillLinked() in firestore.rules).
//     • The companion's watchCompanionLink() listener fires, and
//       useCompanionLinkGuard() signs it out so the app returns to sign-in.
//
import { useState, useEffect, useRef } from 'react';
import { Platform, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DeviceInfo from 'react-native-device-info';
import firestore from '@react-native-firebase/firestore';
import { getAuth, signOut as fbSignOut } from '@react-native-firebase/auth';
import { getFunctions, httpsCallable } from '@react-native-firebase/functions';
import { db } from '../config/firebase';

export const DEVICE_OWNER_KEY   = 'linked_device_owner_uid';
export const DEVICE_ID_KEY      = 'linked_device_id';
export const LINK_TOKEN_TTL_MS  = 10 * 60 * 1000;

export interface LinkedDevice {
  id:           string;
  name:         string;
  type:         'phone' | 'tablet' | 'desktop' | 'web';
  os:           string;
  platform:     'ios' | 'android' | 'web';
  linkedAt:     Date;
  lastActiveAt: Date;
  isCurrent:    boolean;
}

export interface LinkRequest {
  requestId:   string;
  displayCode: string;
  deviceId:    string;
  deviceName:  string;
  deviceType:  'phone' | 'tablet' | 'desktop' | 'web';
  os:          string;
  platform:    'ios' | 'android' | 'web';
}

const fsDb = () => db as ReturnType<typeof firestore>;

function toDate(raw: any): Date {
  if (!raw) return new Date();
  if (typeof raw.toDate === 'function') return raw.toDate();
  return new Date(raw);
}

function isPermissionDenied(err: any): boolean {
  const code = String(err?.code ?? '');
  return code === 'firestore/permission-denied' || code === 'permission-denied';
}

// ─── Random helpers ───────────────────────────────────────────────────────────

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  const g: any = globalThis as any;
  if (g.crypto && typeof g.crypto.getRandomValues === 'function') {
    g.crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, '0');
  return out;
}

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomDisplayCode(len: number): string {
  const arr = new Uint8Array(len);
  const g: any = globalThis as any;
  if (g.crypto && typeof g.crypto.getRandomValues === 'function') {
    g.crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < len; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[arr[i] % CODE_ALPHABET.length];
  return out;
}

// ─── Device helpers — react-native-device-info backed ─────────────────────────

async function getStableDeviceId(): Promise<string> {
  try {
    const id = await DeviceInfo.getUniqueId();
    if (id && id !== 'unknown') return id;
  } catch {}
  let fallback = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (!fallback) {
    fallback = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    await AsyncStorage.setItem(DEVICE_ID_KEY, fallback);
  }
  return fallback;
}

function detectDeviceType(): LinkedDevice['type'] {
  if (Platform.OS === 'web') return 'web';
  try {
    const t = DeviceInfo.getDeviceType();
    if (t === 'Tablet')  return 'tablet';
    if (t === 'Desktop') return 'desktop';
    return 'phone';
  } catch {
    return 'phone';
  }
}

async function detectDeviceNameAsync(): Promise<string> {
  if (Platform.OS === 'web') return 'Web Browser';
  try {
    const name = await DeviceInfo.getDeviceName();
    if (name && name !== 'unknown') return name;
  } catch {}
  if (Platform.OS === 'ios') return `iPhone (iOS ${(Platform as any).Version})`;
  return `Android Phone (API ${(Platform as any).Version})`;
}

function detectOS(): string {
  if (Platform.OS === 'web') return 'Web Browser';
  try {
    const sysName    = DeviceInfo.getSystemName();
    const sysVersion = DeviceInfo.getSystemVersion();
    const model      = DeviceInfo.getModel();
    return `${sysName} ${sysVersion} · ${model}`;
  } catch {
    const ver = (Platform as any).Version;
    return Platform.OS === 'ios' ? `iOS ${ver}` : `Android ${ver}`;
  }
}

// ─── createLinkRequest (unsigned device) ──────────────────────────────────────

export async function createLinkRequest(): Promise<LinkRequest | null> {
  const requestId   = randomHex(32);
  const displayCode = randomDisplayCode(10);

  // The new device needs a temporary identity to write the token doc — an
  // anonymous Firebase Auth user. It is discarded once the primary claims the
  // request (the companion will sign in with a custom token instead).
  let requesterUid: string | null = null;
  try {
    const auth = getAuth();
    const existing = auth.currentUser;
    if (existing) {
      requesterUid = existing.uid;
    } else {
      const { signInAnonymously } = require('@react-native-firebase/auth');
      const cred = await signInAnonymously(auth);
      requesterUid = cred.user?.uid ?? null;
    }
  } catch (err) {
    console.warn('[useLinkedDevices] anon sign-in failed:', err);
    return null;
  }
  if (!requesterUid) return null;

  const deviceId   = await getStableDeviceId();
  await AsyncStorage.setItem(DEVICE_ID_KEY, deviceId);

  const deviceName = await detectDeviceNameAsync();
  const deviceType = detectDeviceType();
  const os         = detectOS();
  const platform: 'ios' | 'android' | 'web' =
    Platform.OS === 'web' ? 'web' : (Platform.OS as 'ios' | 'android');

  const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);

  try {
    await fsDb().collection('deviceLinkTokens').doc(requestId).set({
      requestId,
      displayCode,
      requesterUid,
      deviceId,
      deviceName,
      deviceType,
      os,
      platform,
      createdAt:   firestore.FieldValue.serverTimestamp(),
      expiresAt,
      consumed:    false,
      ownerUid:    null,
      consumedAt:  null,
    });
  } catch (err) {
    console.error('[useLinkedDevices] createLinkRequest write failed:', err);
    return null;
  }

  return { requestId, displayCode, deviceId, deviceName, deviceType, os, platform };
}

// ─── pollForApproval (unsigned device) ────────────────────────────────────────
// Waits until the primary has claimed the token and written the custom token,
// then hands the custom token to the caller.

export function pollForApproval(
  requestId:  string,
  onApproved: (info: { ownerUid: string; customToken: string }) => void,
  onExpired:  () => void,
): () => void {
  let stopped = false;
  const expiryTimer = setTimeout(() => { if (!stopped) onExpired(); }, LINK_TOKEN_TTL_MS);

  const unsub = fsDb().collection('deviceLinkTokens').doc(requestId).onSnapshot(
    (snap) => {
      if (stopped || !snap.exists()) return;
      const data = snap.data()!;
      if (!data.consumed || !data.ownerUid) return;
      if (!data.companionCustomToken) return; // primary is still finishing up

      const expiresAt = toDate(data.expiresAt);
      if (new Date() > expiresAt) { onExpired(); return; }

      stopped = true;
      clearTimeout(expiryTimer);
      onApproved({
        ownerUid:    data.ownerUid,
        customToken: data.companionCustomToken,
      });
    },
    (err) => console.warn('[useLinkedDevices] poll error:', err),
  );

  return () => { stopped = true; clearTimeout(expiryTimer); unsub(); };
}

// ─── claimLinkRequest (primary device) ────────────────────────────────────────

export async function claimLinkRequest(
  requestId: string,
  ownerUid:  string,
  ownerName: string | null,
): Promise<{ success: boolean; error?: string }> {
  if (!ownerUid) return { success: false, error: 'You must be signed in.' };

  // 1. Ask the Cloud Function to mint a companion custom token.
  let customToken: string;
  try {
    const fn = httpsCallable(getFunctions(), 'mintCompanionToken');
    const res: any = await fn({ requestId });
    customToken = res?.data?.customToken;
    if (!customToken || typeof customToken !== 'string') {
      throw new Error('Cloud Function returned no token.');
    }
  } catch (err: any) {
    console.error('[useLinkedDevices] mintCompanionToken failed:', err);
    return { success: false, error: err?.message ?? 'Could not mint companion token.' };
  }

  // 2. Transactionally claim the token and register the device.
  const tokenRef = fsDb().collection('deviceLinkTokens').doc(requestId);
  try {
    await fsDb().runTransaction(async (tx) => {
      const snap = await tx.get(tokenRef);
      if (!snap.exists()) throw new Error('Request not found. It may have expired.');

      const data = snap.data()!;
      if (data.consumed) throw new Error('This request has already been used.');
      if (data.ownerUid) throw new Error('This request has already been claimed.');

      const expiresAt = toDate(data.expiresAt);
      if (new Date() > expiresAt) throw new Error('This request has expired.');

      tx.update(tokenRef, {
        consumed:             true,
        ownerUid,
        companionCustomToken: customToken,
        consumedAt:           firestore.FieldValue.serverTimestamp(),
        consumedByName:       ownerName ?? null,
      });

      const deviceRef = fsDb()
        .collection('users').doc(ownerUid)
        .collection('linkedDevices').doc(data.deviceId);

      tx.set(deviceRef, {
        name:         data.deviceName ?? 'Companion Device',
        type:         data.deviceType ?? 'phone',
        os:           data.os         ?? '',
        platform:     data.platform   ?? 'android',
        linkedAt:     firestore.FieldValue.serverTimestamp(),
        lastActiveAt: firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    return { success: true };
  } catch (err: any) {
    console.error('[useLinkedDevices] claimLinkRequest transaction failed:', err);
    return { success: false, error: err?.message ?? 'Failed to claim link request.' };
  }
}

// ─── findRequestByDisplayCode (primary device) ────────────────────────────────

export async function findRequestByDisplayCode(
  displayCode: string,
): Promise<{ requestId: string } | null> {
  const code = displayCode.trim().toUpperCase();
  if (code.length !== 10) return null;

  const snap = await fsDb()
    .collection('deviceLinkTokens')
    .where('displayCode', '==', code)
    .where('consumed',    '==', false)
    .limit(1)
    .get();

  if (snap.empty) return null;
  const doc = snap.docs[0];
  const expiresAt = toDate(doc.data().expiresAt);
  if (new Date() > expiresAt) return null;
  return { requestId: doc.id };
}

// ─── useLinkedDevices (primary device) ────────────────────────────────────────

export function useLinkedDevices(ownerUid: string | null) {
  const [devices,    setDevices]    = useState<LinkedDevice[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [myDeviceId, setMyDeviceId] = useState<string | null>(null);

  useEffect(() => {
    getStableDeviceId().then(setMyDeviceId);
  }, []);

  useEffect(() => {
    if (!ownerUid) { setDevices([]); setLoading(false); return; }

    const unsub = fsDb()
      .collection('users').doc(ownerUid)
      .collection('linkedDevices')
      .orderBy('linkedAt', 'asc')
      .onSnapshot(
        (snap) => {
          const result: LinkedDevice[] = snap.docs.map((doc) => {
            const d = doc.data();
            return {
              id:           doc.id,
              name:         d.name         ?? 'Unknown Device',
              type:         d.type         ?? 'phone',
              os:           d.os           ?? '',
              platform:     d.platform     ?? 'android',
              linkedAt:     toDate(d.linkedAt),
              lastActiveAt: toDate(d.lastActiveAt),
              isCurrent:    doc.id === myDeviceId,
            };
          });
          result.sort((a, b) => (a.isCurrent ? -1 : b.isCurrent ? 1 : 0));
          setDevices(result);
          setLoading(false);
        },
        () => setLoading(false),
      );

    return () => unsub();
  }, [ownerUid, myDeviceId]);

  return { devices, loading, myDeviceId };
}

// ─── registerCurrentDevice (primary device) ───────────────────────────────────

export async function registerCurrentDevice(
  ownerUid:   string,
  deviceName?: string,
): Promise<string> {
  const deviceId = await getStableDeviceId();
  await AsyncStorage.setItem(DEVICE_ID_KEY, deviceId);

  const name = deviceName ?? (await detectDeviceNameAsync());

  await fsDb()
    .collection('users').doc(ownerUid)
    .collection('linkedDevices').doc(deviceId)
    .set({
      name,
      type:         detectDeviceType(),
      os:           detectOS(),
      platform:     Platform.OS === 'web' ? 'web' : Platform.OS,
      linkedAt:     firestore.FieldValue.serverTimestamp(),
      lastActiveAt: firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

  return deviceId;
}

// ─── updateDeviceLastActive ───────────────────────────────────────────────────
export async function updateDeviceLastActive(ownerUid: string): Promise<void> {
  const deviceId = await getStableDeviceId();
  try {
    await fsDb()
      .collection('users').doc(ownerUid)
      .collection('linkedDevices').doc(deviceId)
      .update({ lastActiveAt: firestore.FieldValue.serverTimestamp() });
  } catch {}
}

// ─── requireOwnerSession (shared by removeDevice / removeAllOtherDevices) ─────
// Waits for Firebase Auth to restore the session, force-refreshes the ID token,
// and fails with a clear message if the session can't satisfy the Firestore rule
//     allow delete: if isOwner(userId) && !isCompanion();
// instead of surfacing a generic [firestore/permission-denied].
async function requireOwnerSession(ownerUid: string, action: string) {
  // Wait up to 5 seconds for Firebase Auth to restore the session.
  // getAuth().currentUser can be null right after app launch even for
  // signed-in users because auth state is restored asynchronously.
  const auth = getAuth();
  let currentUser = auth.currentUser;

  if (!currentUser) {
    await new Promise<void>((resolve) => {
      const unsub = auth.onAuthStateChanged((u) => {
        unsub();
        currentUser = u;
        resolve();
      });
      // Resolve after 5s even if auth never fires (offline / slow restore)
      setTimeout(resolve, 5000);
    });
  }

  if (!currentUser) {
    throw new Error(`You must be signed in to ${action}.`);
  }

  // Force-refresh the ID token so Firestore gets a fresh JWT, and read its
  // claims so we can see exactly what the rules will see.
  const tok = await currentUser.getIdTokenResult(true);

  if (currentUser.uid !== ownerUid) {
    throw new Error('Only the account owner can remove devices.');
  }
  if (tok.claims?.companion === true) {
    throw new Error(
      'This session is flagged as a companion device, so it cannot remove devices. ' +
      'Sign out completely and sign back in on the primary phone.',
    );
  }

  return currentUser;
}

export async function removeDevice(ownerUid: string, deviceId: string): Promise<void> {
  await requireOwnerSession(ownerUid, 'remove a device');

  await fsDb()
    .collection('users').doc(ownerUid)
    .collection('linkedDevices').doc(deviceId)
    .delete();
}

export async function removeAllOtherDevices(ownerUid: string, currentDeviceId: string): Promise<void> {
  await requireOwnerSession(ownerUid, 'remove devices');

  const snap = await fsDb()
    .collection('users').doc(ownerUid)
    .collection('linkedDevices')
    .get();
  const batch = fsDb().batch();
  snap.docs.forEach((doc) => {
    if (doc.id !== currentDeviceId) batch.delete(doc.ref);
  });
  await batch.commit();
}

// ─── verifyCompanionStillLinked ───────────────────────────────────────────────
// Called on the companion device at launch. If the primary has removed this
// device from linkedDevices, the companion signs itself out.
export async function verifyCompanionStillLinked(ownerUid: string): Promise<boolean> {
  try {
    const deviceId = await getStableDeviceId();
    const snap = await fsDb()
      .collection('users').doc(ownerUid)
      .collection('linkedDevices').doc(deviceId)
      .get();
    return snap.exists();
  } catch (err) {
    // The rules deny a removed companion — treat that as "no longer linked".
    if (isPermissionDenied(err)) return false;
    return true; // network error — don't force a sign-out on transient failure
  }
}

// ─── watchCompanionLink (companion device) ────────────────────────────────────
// Live listener on this device's own linkedDevices doc. Calls onRemoved() the
// moment the primary deletes it (or the rules start denying this session).
// Fires at most once. Returns an unsubscribe function.
export function watchCompanionLink(
  ownerUid:  string,
  onRemoved: () => void,
): () => void {
  let stopped = false;
  let unsub: (() => void) | null = null;

  const fireOnce = () => {
    if (stopped) return;
    stopped = true;
    if (unsub) { try { unsub(); } catch {} }
    onRemoved();
  };

  getStableDeviceId().then((deviceId) => {
    if (stopped) return;
    unsub = fsDb()
      .collection('users').doc(ownerUid)
      .collection('linkedDevices').doc(deviceId)
      .onSnapshot(
        (snap) => {
          if (stopped) return;
          // Ignore the offline cache — only a server-confirmed "missing" counts.
          if (snap.metadata?.fromCache) return;
          if (!snap.exists()) fireOnce();
        },
        (err) => {
          if (isPermissionDenied(err)) fireOnce();
          else console.warn('[useLinkedDevices] companion watch error:', err);
        },
      );
  });

  return () => {
    stopped = true;
    if (unsub) { try { unsub(); } catch {} }
  };
}

// ─── signOutRemovedCompanion ──────────────────────────────────────────────────
// Wipes the stored link info and signs Firebase Auth out. The app's auth state
// listener then drops back to the sign-in screen.
export async function signOutRemovedCompanion(): Promise<void> {
  try { await clearDeviceLink(); } catch {}
  try { await fbSignOut(getAuth()); } catch {}
}

// ─── useCompanionLinkGuard (mount once, app-wide, inside the auth provider) ───
// On a companion device, watches for removal and signs out immediately.
//   useCompanionLinkGuard(isCompanion, ownerUid);
export function useCompanionLinkGuard(
  isCompanion: boolean,
  ownerUid:    string | null,
  onRemoved?:  () => void,
) {
  const handled = useRef(false);

  useEffect(() => {
    if (!isCompanion || !ownerUid) return;
    handled.current = false;

    const stop = watchCompanionLink(ownerUid, async () => {
      if (handled.current) return;
      handled.current = true;
      await signOutRemovedCompanion();
      onRemoved?.();
      Alert.alert(
        'Device removed',
        'This device was removed from the account by the primary phone. Please sign in again.',
      );
    });

    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCompanion, ownerUid]);
}

// ─── helpers ──────────────────────────────────────────────────────────────────
export async function getStoredOwnerUid(): Promise<string | null> {
  return AsyncStorage.getItem(DEVICE_OWNER_KEY);
}

export async function clearDeviceLink(): Promise<void> {
  await AsyncStorage.multiRemove([DEVICE_OWNER_KEY, DEVICE_ID_KEY]);
}

// Kept as a no-op so nothing imports it by accident and crashes.
export async function signOutAnonymousRequester(): Promise<void> {
  try {
    const auth = getAuth();
    if (auth.currentUser?.isAnonymous) await fbSignOut(auth);
  } catch {}
}