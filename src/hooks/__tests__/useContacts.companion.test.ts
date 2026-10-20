// ─── useContacts: companion + synced-contacts behaviour ───────────────────────
// Companion: no device permission, shows the owner's synced list.
// Primary: uploads the matched snapshot once (deduped across hook instances),
// and falls back to the synced list when contacts permission is denied.

const mockAuth = { ownerUid: 'owner' as string | null, isCompanion: false };
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

const mockRequestPermissions = jest.fn();
const mockGetContacts = jest.fn();
jest.mock('expo-contacts/legacy', () => ({
  requestPermissionsAsync: (...a: any[]) => mockRequestPermissions(...a),
  getContactsAsync: (...a: any[]) => mockGetContacts(...a),
  Fields: { Name: 'name', PhoneNumbers: 'phoneNumbers', Image: 'image' },
}));

const mockListSynced = jest.fn();
const mockReplaceSynced = jest.fn();
const mockMatch = jest.fn();
jest.mock('../../api/endpoints', () => ({
  endpoints: {
    listSyncedContacts: (...a: any[]) => mockListSynced(...a),
    replaceSyncedContacts: (...a: any[]) => mockReplaceSynced(...a),
    matchContacts: (...a: any[]) => mockMatch(...a),
  },
}));

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useContacts } from '../useContacts';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type HookValue = ReturnType<typeof useContacts>;

const settle = () => new Promise((r) => setTimeout(r, 0));

async function mountHooks(count = 1) {
  const results: { current: HookValue | null }[] = [];
  const probes = Array.from({ length: count }, (_, i) => {
    const ref: { current: HookValue | null } = { current: null };
    results.push(ref);
    return function Probe() { ref.current = useContacts(); return null; };
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  const tree = () => React.createElement(React.Fragment, null, ...probes.map((P, i) => React.createElement(P, { key: i })));
  await act(async () => {
    renderer = TestRenderer.create(tree());
    for (let i = 0; i < 10; i++) await settle();
  });
  return {
    results,
    rerender: async () => act(async () => { renderer.update(tree()); for (let i = 0; i < 5; i++) await settle(); }),
    unmount: () => act(() => renderer.unmount()),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockReplaceSynced.mockResolvedValue({ ok: true, data: { saved: 2 } });
});

afterEach(() => { jest.restoreAllMocks(); });

it('companion: skips device permissions and maps the synced list', async () => {
  mockAuth.ownerUid = 'owner-companion';
  mockAuth.isCompanion = true;
  mockListSynced.mockResolvedValue({
    ok: true,
    data: {
      contacts: [
        { phone: '+27820000002', displayName: 'Zed', userId: null, isSaved: false, avatarObjectKey: null },
        { phone: '+27820000001', displayName: 'Amy', userId: 'u-amy', isSaved: true, avatarObjectKey: 'avatars/amy.jpg' },
      ],
    },
  });

  const { results, unmount } = await mountHooks();
  const hook = results[0].current!;

  expect(mockRequestPermissions).not.toHaveBeenCalled();
  expect(mockGetContacts).not.toHaveBeenCalled();
  expect(mockReplaceSynced).not.toHaveBeenCalled();
  expect(hook.hasPermission).toBe(true);
  expect(hook.loading).toBe(false);
  expect(hook.contacts).toEqual([
    { userId: 'u-amy', phone: '+27820000001', displayName: 'Amy', isSaved: true, firebasePhotoURL: 'avatars/amy.jpg' },
    { userId: '+27820000002', phone: '+27820000002', displayName: 'Zed', isSaved: false, firebasePhotoURL: undefined },
  ]);
  unmount();
});

it('primary: uploads the matched snapshot once across hook instances, re-renders and identical reloads', async () => {
  mockAuth.ownerUid = 'owner-primary';
  mockAuth.isCompanion = false;
  mockRequestPermissions.mockResolvedValue({ status: 'granted', canAskAgain: true });
  mockGetContacts.mockResolvedValue({
    data: [
      { name: 'Bob', phoneNumbers: [{ number: '+27820000003' }] },
      { name: 'Amy', phoneNumbers: [{ number: '+27820000001' }] },
    ],
  });
  mockMatch.mockResolvedValue({
    ok: true,
    data: { matches: [{ userId: 'u-amy', phoneNumber: '+27820000001', displayName: 'Amy', avatarObjectKey: 'avatars/amy.jpg' }] },
  });

  const { results, rerender, unmount } = await mountHooks(2);

  expect(mockReplaceSynced).toHaveBeenCalledTimes(1);
  expect(mockReplaceSynced).toHaveBeenCalledWith([
    { phone: '+27820000001', displayName: 'Amy', userId: 'u-amy', isSaved: true, avatarObjectKey: 'avatars/amy.jpg' },
    { phone: '+27820000003', displayName: 'Bob', userId: null, isSaved: false, avatarObjectKey: null },
  ]);
  expect(results[0].current!.contacts.map((c) => c.displayName)).toEqual(['Amy', 'Bob']);

  await rerender();
  await act(async () => { await results[0].current!.reload(); for (let i = 0; i < 5; i++) await settle(); });
  expect(mockReplaceSynced).toHaveBeenCalledTimes(1);
  unmount();
});

it('primary: does not upload when matching partially failed', async () => {
  mockAuth.ownerUid = 'owner-partial';
  mockAuth.isCompanion = false;
  mockRequestPermissions.mockResolvedValue({ status: 'granted', canAskAgain: true });
  mockGetContacts.mockResolvedValue({ data: [{ name: 'Amy', phoneNumbers: [{ number: '+27820000001' }] }] });
  mockMatch.mockResolvedValue({ ok: false, error: { kind: 'network', code: 'NETWORK', message: 'offline' } });

  const { results, unmount } = await mountHooks();

  expect(results[0].current!.contacts).toHaveLength(1);
  expect(mockReplaceSynced).not.toHaveBeenCalled();
  unmount();
});

it('primary: permission denied falls back to the synced list and never uploads', async () => {
  mockAuth.ownerUid = 'owner-denied';
  mockAuth.isCompanion = false;
  mockRequestPermissions.mockResolvedValue({ status: 'denied', canAskAgain: false });
  mockListSynced.mockResolvedValue({
    ok: true,
    data: { contacts: [{ phone: '+27820000001', displayName: 'Amy', userId: 'u-amy', isSaved: true, avatarObjectKey: null }] },
  });

  const { results, unmount } = await mountHooks();
  const hook = results[0].current!;

  expect(mockGetContacts).not.toHaveBeenCalled();
  expect(mockReplaceSynced).not.toHaveBeenCalled();
  expect(hook.hasPermission).toBe(false);
  expect(hook.canAskAgain).toBe(false);
  expect(hook.error).toMatch(/permission denied/i);
  expect(hook.contacts).toEqual([
    { userId: 'u-amy', phone: '+27820000001', displayName: 'Amy', isSaved: true, firebasePhotoURL: undefined },
  ]);
  unmount();
});

it('waits for auth before loading', async () => {
  mockAuth.ownerUid = null;
  mockAuth.isCompanion = false;

  const { results, unmount } = await mountHooks();

  expect(results[0].current!.loading).toBe(false);
  expect(mockRequestPermissions).not.toHaveBeenCalled();
  expect(mockListSynced).not.toHaveBeenCalled();
  unmount();
});
