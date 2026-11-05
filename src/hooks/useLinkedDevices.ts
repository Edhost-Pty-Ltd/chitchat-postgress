//
// Companion linking via the backend device-link API + Firebase Custom Tokens.
//
// Flow:
//   1. New device (unsigned) → createLinkRequest() → anon Firebase sign-in so
//      it can authenticate to the backend, then POST /device-links with
//      consumed:false, ownerUid:null.
//   2. New device displays QR (encodes requestId) + displayCode.
//   3. Signed-in device (primary) scans QR or types code (findRequestByDisplayCode
//      → GET /device-links?code=).
//   4. Primary calls claimLinkRequest(requestId, ownerUid, ownerName):
//        a. POST /device-links/claim marks the token consumed, records ownerUid,
//           and registers the companion in linked_devices (atomic server-side).
//   5. Companion polls GET /device-links/:requestId; once consumed the backend
//      mints a Firebase custom token tagged { companion: true } for the owner
//      and returns it so the companion can signInWithCustomToken.
//
// Removal:
//   removeDevice()/removeAllOtherDevices() call the backend to delete the
//   linked_devices rows. From then on EVERY request from the removed companion
//   is rejected with 401 AUTH_TOKEN_REVOKED, and the backend emits
//   `device:removed` { deviceId } to the owner's sockets. The companion's
//   watchCompanionLink() reacts to the socket event instantly and keeps a poll
//   as fallback; either path signs it out.
//
// Firebase is used ONLY for Auth here (anon sign-in + custom-token sign-in +
// token claims); all device/link state lives in Postgres via the API.
//
import { useState, useEffect, useRef } from 'react';
import { Platform, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { endpoints } from '../api/endpoints';
import type { ApiError, NetworkError } from '../api/errors';
import { socketClient } from '../realtime/socket';

// ── Platform-aware Firebase Auth helpers ──────────────────────────────────────
// @react-native-firebase/auth works on iOS/Android only; the firebase/auth JS
// SDK is used on Web. Import the correct one so this module works on all
// platforms without crashing.

let _getAuth: () => any;
let _fbSignOut: (auth: any) => Promise<void>;
let _signInAnonymously: (auth: any) => Promise<any>;

if (Platform.OS === 'web') {
  const webAuth = require('firebase/auth');
  // firebase.ts already initialises the JS SDK app and exports it as default.
  const webApp = require('../config/firebase').default;

  _getAuth = () => webAuth.getAuth(webApp);
  _fbSignOut = (auth: any) => webAuth.signOut(auth);
  _signInAnonymously = (auth: any) => webAuth.signInAnonymously(auth);
} else {
  const nativeAuth = require('@react-native-firebase/auth');
  const mod = nativeAuth.default ?? nativeAuth;
  _getAuth = () => mod.getAuth ? mod.getAuth() : mod();
  _fbSignOut = (auth: any) => mod.signOut ? mod.signOut(auth) : (mod().signOut ? auth.signOut() : auth.signOut());
  _signInAnonymously = async (auth: any) => {
    // @react-native-firebase/auth v7+ exports signInAnonymously as a function
    if (typeof mod.signInAnonymously === 'function') return mod.signInAnonymously(auth);
    // Older shape: auth object has the method directly
    if (typeof auth.signInAnonymously === 'function') return auth.signInAnonymously();
    throw new Error('signInAnonymously not found in @react-native-firebase/auth');
  };
}

const getAuth         = _getAuth;
const fbSignOut       = (auth: any) => _fbSignOut(auth);
const _doSignInAnon   = (auth: any) => _signInAnonymously(auth);

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

function toDate(raw: any): Date {
  if (!raw) return new Date();
  if (typeof raw.toDate === 'function') return raw.toDate();
  return new Date(raw);
}

// In-process "device list changed" signal so a mounted useLinkedDevices list
// refreshes right after this device links or removes a device, instead of
// waiting for the next poll.
const deviceListListeners = new Set<() => void>();
function notifyDeviceListChanged(): void {
  for (const listener of deviceListListeners) {
    try { listener(); } catch {}
  }
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
let DeviceInfo: any = null;
try {
  DeviceInfo = require('react-native-device-info').default ?? require('react-native-device-info');
} catch (err) {
  console.warn('[useLinkedDevices] react-native-device-info unavailable, using fallbacks:', err);
  DeviceInfo = null;
}

async function getStableDeviceId(): Promise<string> {
  try {
    if (DeviceInfo) {
      const id = await DeviceInfo.getUniqueId();
      if (id && id !== 'unknown') return id;
    }
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
    if (!DeviceInfo) return 'phone';
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
    if (!DeviceInfo) throw new Error('device-info unavailable');
    const name = await DeviceInfo.getDeviceName();
    if (name && name !== 'unknown') return name;
  } catch {}
  if (Platform.OS === 'ios') return `iPhone (iOS ${(Platform as any).Version})`;
  return `Android Phone (API ${(Platform as any).Version})`;
}

function detectOS(): string {
  if (Platform.OS === 'web') return 'Web Browser';
  try {
    if (!DeviceInfo) throw new Error('device-info unavailable');
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

  // The new device needs a temporary anonymous identity so it can authenticate
  // to the backend. Only reuse an existing session if it's already anonymous;
  // otherwise mint a fresh anon UID (a real account must not link to itself).
  let requesterUid: string | null = null;
  try {
    const auth = getAuth();
    const existing = auth.currentUser;
    if (existing && existing.isAnonymous) {
      requesterUid = existing.uid;
    } else {
      const cred = await _doSignInAnon(auth);
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

  const res = await endpoints.createDeviceLink({
    requestId,
    displayCode,
    requesterUid,
    deviceId,
    deviceName,
    deviceType,
    os,
    platform,
  });
  if (!res.ok) {
    console.error('[useLinkedDevices] createLinkRequest failed:', res.error.message);
    return null;
  }

  return { requestId, displayCode, deviceId, deviceName, deviceType, os, platform };
}

// ─── pollForApproval (unsigned device) ────────────────────────────────────────
// Polls the backend until the primary has claimed the token, then hands the
// minted companion custom token to the caller.

export function pollForApproval(
  requestId:  string,
  onApproved: (info: { ownerUid: string; customToken: string }) => void,
  onExpired:  () => void,
): () => void {
  let stopped = false;
  const expiryTimer = setTimeout(() => {
    if (!stopped) { stopped = true; onExpired(); }
  }, LINK_TOKEN_TTL_MS);

  const tick = async () => {
    if (stopped) return;
    try {
      const res = await endpoints.getDeviceLink(requestId);
      if (stopped) return;
      if (res.ok) {
        const d = res.data;
        if (d.expired) {
          stopped = true;
          clearTimeout(expiryTimer);
          onExpired();
          return;
        }
        if (d.consumed && d.ownerUid && d.customToken) {
          stopped = true;
          clearTimeout(expiryTimer);
          onApproved({ ownerUid: d.ownerUid, customToken: d.customToken });
          return;
        }
      }
    } catch (err) {
      console.warn('[useLinkedDevices] poll error:', err);
    }
    if (!stopped) setTimeout(tick, 2000);
  };
  void tick();

  return () => { stopped = true; clearTimeout(expiryTimer); };
}

// ─── claimLinkRequest (primary device) ────────────────────────────────────────

export async function claimLinkRequest(
  requestId: string,
  ownerUid:  string,
  ownerName: string | null,
): Promise<{ success: boolean; error?: string }> {
  if (!ownerUid) return { success: false, error: 'You must be signed in.' };
  try {
    const res = await endpoints.claimDeviceLink(requestId, ownerName);
    if (!res.ok) return { success: false, error: res.error.message };
    notifyDeviceListChanged();
    return { success: true };
  } catch (err: any) {
    console.error('[useLinkedDevices] claimLinkRequest failed:', err);
    return { success: false, error: err?.message ?? 'Failed to claim link request.' };
  }
}

// ─── findRequestByDisplayCode (primary device) ────────────────────────────────

export async function findRequestByDisplayCode(
  displayCode: string,
): Promise<{ requestId: string } | null> {
  const code = displayCode.trim().toUpperCase();
  if (code.length !== 10) return null;
  const res = await endpoints.findDeviceLinkByCode(code);
  if (!res.ok || !res.data.requestId) return null;
  return { requestId: res.data.requestId };
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
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      try {
        const res = await endpoints.listDevices();
        if (cancelled) return;
        if (res.ok) {
          const result: LinkedDevice[] = res.data.devices.map((d) => ({
            id:           d.id,
            name:         d.name ?? 'Unknown Device',
            type:         d.type ?? 'phone',
            os:           d.os ?? '',
            platform:     d.platform ?? 'android',
            linkedAt:     toDate(d.linkedAt),
            lastActiveAt: toDate(d.lastActiveAt),
            isCurrent:    d.id === myDeviceId,
          }));
          result.sort((a, b) => (a.isCurrent ? -1 : b.isCurrent ? 1 : 0));
          setDevices(result);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    // Light polling keeps the list fresh; local link/remove actions and the
    // backend's device:removed event (sent to all of the owner's devices)
    // refresh it immediately.
    timer = setInterval(load, 15000);
    const reload = () => { if (!cancelled) void load(); };
    deviceListListeners.add(reload);
    const unsubscribeRemoved = socketClient.subscribe('device:removed', reload);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      deviceListListeners.delete(reload);
      unsubscribeRemoved();
    };
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
  const platform: 'ios' | 'android' | 'web' =
    Platform.OS === 'web' ? 'web' : (Platform.OS as 'ios' | 'android');

  await endpoints.registerDevice({
    deviceId,
    name,
    type: detectDeviceType(),
    os: detectOS(),
    platform,
  });

  return deviceId;
}

// ─── updateDeviceLastActive ───────────────────────────────────────────────────
export async function updateDeviceLastActive(_ownerUid: string): Promise<void> {
  try {
    const deviceId = await getStableDeviceId();
    await endpoints.touchDevice(deviceId);
  } catch {}
}

// ─── requireOwnerSession (shared by removeDevice / removeAllOtherDevices) ─────
// Ensures a real (non-companion) owner session before a destructive device op.
// The backend also authorizes by token, so this is a fast client-side guard
// that gives a clear message rather than a generic 403.
async function requireOwnerSession(ownerUid: string, action: string) {
  const auth = getAuth();
  let currentUser = auth.currentUser;

  if (!currentUser) {
    await new Promise<void>((resolve) => {
      const unsub = auth.onAuthStateChanged((u: any) => {
        unsub();
        currentUser = u;
        resolve();
      });
      setTimeout(resolve, 5000);
    });
  }

  if (!currentUser) throw new Error(`You must be signed in to ${action}.`);

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
  const res = await endpoints.removeDevice(deviceId);
  if (!res.ok) throw new Error(res.error.message);
  notifyDeviceListChanged();
}

export async function removeAllOtherDevices(ownerUid: string, currentDeviceId: string): Promise<void> {
  await requireOwnerSession(ownerUid, 'remove devices');
  const res = await endpoints.removeOtherDevices(currentDeviceId);
  if (!res.ok) throw new Error(res.error.message);
  notifyDeviceListChanged();
}

// ─── Companion link status (companion device) ─────────────────────────────────
// Once the primary removes a companion, the backend rejects EVERY request from
// it with 401 AUTH_TOKEN_REVOKED, so that response is the authoritative
// "removed" signal. A successful device list that no longer contains this
// device means the same thing. Anything else (offline, timeout, 5xx, a token
// that hasn't been restored yet) is transient and must NOT force a sign-out.
type CompanionLinkState = 'linked' | 'removed' | 'unknown';

function isCompanionRevoked(error: ApiError | NetworkError): boolean {
  return error.kind === 'api' && error.status === 401 && error.code === 'AUTH_TOKEN_REVOKED';
}

async function checkCompanionLink(deviceId: string): Promise<CompanionLinkState> {
  try {
    const res = await endpoints.listDevices();
    if (res.ok) return res.data.devices.some((d) => d.id === deviceId) ? 'linked' : 'removed';
    return isCompanionRevoked(res.error) ? 'removed' : 'unknown';
  } catch {
    return 'unknown';
  }
}

// ─── verifyCompanionStillLinked ───────────────────────────────────────────────
// Called on the companion at launch. Returns false only when the backend says
// this device was removed; transient failures keep the session.
export async function verifyCompanionStillLinked(_ownerUid: string): Promise<boolean> {
  try {
    const deviceId = await getStableDeviceId();
    return (await checkCompanionLink(deviceId)) !== 'removed';
  } catch {
    return true; // couldn't read the device id — don't force a sign-out
  }
}

// ─── watchCompanionLink (companion device) ────────────────────────────────────
// Calls onRemoved() as soon as this device is removed from the owner's account:
//   • instantly, via the backend's `device:removed` socket event, and
//   • as a fallback, via a 10s poll (401 AUTH_TOKEN_REVOKED or a device list
//     without this device). Network errors are ignored until the next tick.
// Fires at most once. Returns an unsubscribe function.
export function watchCompanionLink(
  ownerUid:  string,
  onRemoved: () => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeSocket: (() => void) | null = null;

  const teardown = () => {
    if (timer) { clearInterval(timer); timer = null; }
    if (unsubscribeSocket) {
      try { unsubscribeSocket(); } catch {}
      unsubscribeSocket = null;
    }
  };

  const fireOnce = () => {
    if (stopped) return;
    stopped = true;
    teardown();
    onRemoved();
  };

  (async () => {
    let deviceId: string;
    try {
      deviceId = await getStableDeviceId();
    } catch (err) {
      console.warn('[useLinkedDevices] companion watch could not read device id:', err);
      return;
    }
    if (stopped) return;

    // Instant path. The handler is kept by the shared socket client and bound
    // whenever the socket is (or later becomes) connected by the app.
    try {
      unsubscribeSocket = socketClient.subscribe('device:removed', (payload) => {
        const removedId = (payload as { deviceId?: unknown } | null | undefined)?.deviceId;
        if (removedId === deviceId) fireOnce();
      });
    } catch (err) {
      console.warn('[useLinkedDevices] device:removed subscription failed, polling only:', err);
    }

    // Fallback path: poll the backend.
    const check = async () => {
      if (stopped) return;
      if ((await checkCompanionLink(deviceId)) === 'removed') fireOnce();
    };
    void check();
    timer = setInterval(check, 10000);
  })();

  return () => {
    stopped = true;
    teardown();
  };
}

// ─── signOutRemovedCompanion ──────────────────────────────────────────────────
// Wipes the stored link info, signs Firebase Auth out and drops the realtime
// connection, which was authenticated as the owner and must not outlive the
// removed session. The auth state listener then drops back to sign-in.
export async function signOutRemovedCompanion(): Promise<void> {
  try { await clearDeviceLink(); } catch {}
  try { await fbSignOut(getAuth()); } catch {}
  try { socketClient.disconnect(); } catch {}
}

// ─── useCompanionLinkGuard (mount once, app-wide, inside the auth provider) ───
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
