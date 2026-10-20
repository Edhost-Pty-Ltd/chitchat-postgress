// ─── usePushNotifications: push token is tied to the linked device id ─────────

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => {}),
  AndroidImportance: { MAX: 5 },
  getPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: 'ExponentPushToken[abc]' })),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponseAsync: jest.fn(async () => null),
  scheduleNotificationAsync: jest.fn(async () => {}),
}));

jest.mock('../useNotificationReply', () => ({
  registerChatReplyCategory: jest.fn(),
  handleNotificationReply: jest.fn(async () => false),
}));

jest.mock('../useLinkedDevices', () => ({ DEVICE_ID_KEY: 'linked_device_id' }));

const mockStorage = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(async (k: string) => mockStorage.get(k) ?? null) },
}));

const mockRegisterPushToken = jest.fn();
jest.mock('../../api/endpoints', () => ({
  endpoints: {
    registerPushToken: (...a: any[]) => mockRegisterPushToken(...a),
    removePushToken: jest.fn(),
  },
}));

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { usePushNotifications } from '../usePushNotifications';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const settle = () => new Promise((r) => setTimeout(r, 0));

async function mount(userId: string | null) {
  function Probe() { usePushNotifications(userId); return null; }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Probe));
    for (let i = 0; i < 10; i++) await settle();
  });
  return () => act(() => renderer.unmount());
}

let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  mockStorage.clear();
  mockRegisterPushToken.mockReset().mockResolvedValue({ ok: true, data: { ok: true } });
  // react-test-renderer logs a deprecation notice on React 19.
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => { consoleErrorSpy.mockRestore(); });

it('passes the stored linked-device id as the third argument', async () => {
  mockStorage.set('linked_device_id', 'device-123');
  const unmount = await mount('owner-1');
  expect(mockRegisterPushToken).toHaveBeenCalledWith('ExponentPushToken[abc]', 'ios', 'device-123');
  unmount();
});

it('passes null when no device id is stored yet', async () => {
  const unmount = await mount('owner-1');
  expect(mockRegisterPushToken).toHaveBeenCalledWith('ExponentPushToken[abc]', 'ios', null);
  unmount();
});

it('does nothing while signed out', async () => {
  const unmount = await mount(null);
  expect(mockRegisterPushToken).not.toHaveBeenCalled();
  unmount();
});
