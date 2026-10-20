// ─── Companion link detection ─────────────────────────────────────────────────
// verifyCompanionStillLinked / watchCompanionLink: a 401 AUTH_TOKEN_REVOKED (or
// a device list without this device) means "removed", network-class failures
// are transient, and the socket `device:removed` event signs out instantly.

const mockListDevices = jest.fn();
jest.mock('../../api/endpoints', () => ({
  endpoints: { listDevices: (...args: any[]) => mockListDevices(...args) },
}));

type Handler = (payload: unknown) => void;
const mockSocketHandlers = new Map<string, Set<Handler>>();
jest.mock('../../realtime/socket', () => ({
  socketClient: {
    subscribe: (event: string, handler: Handler) => {
      let set = mockSocketHandlers.get(event);
      if (!set) { set = new Set(); mockSocketHandlers.set(event, set); }
      set.add(handler);
      return () => { set!.delete(handler); };
    },
    disconnect: jest.fn(),
  },
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios', Version: '17.0' },
  Alert: { alert: jest.fn() },
}));

const mockStorage = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => mockStorage.get(k) ?? null),
    setItem: jest.fn(async (k: string, v: string) => { mockStorage.set(k, v); }),
    multiRemove: jest.fn(async (keys: string[]) => { keys.forEach((k) => mockStorage.delete(k)); }),
  },
}));

jest.mock('@react-native-firebase/auth', () => ({
  getAuth: () => ({ currentUser: null }),
  signOut: jest.fn(async () => {}),
}));

jest.mock('react-native-device-info', () => ({
  __esModule: true,
  default: {
    getUniqueId: async () => 'device-A',
    getDeviceType: () => 'Handset',
    getDeviceName: async () => 'Test Phone',
    getSystemName: () => 'iOS',
    getSystemVersion: () => '17.0',
    getModel: () => 'iPhone',
  },
}));

import { ApiError, NetworkError } from '../../api/errors';
import { verifyCompanionStillLinked, watchCompanionLink } from '../useLinkedDevices';

const listed = (...ids: string[]) => ({
  ok: true,
  data: {
    devices: ids.map((id) => ({
      id, name: id, type: 'phone', os: '', platform: 'ios', linkedAt: '', lastActiveAt: '',
    })),
  },
});
const failed = (error: unknown) => ({ ok: false, error });
const revoked = () =>
  failed(new ApiError(401, 'AUTH_TOKEN_REVOKED', 'This companion device has been removed'));

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const emitSocket = (event: string, payload: unknown) =>
  [...(mockSocketHandlers.get(event) ?? [])].forEach((h) => h(payload));

beforeEach(() => {
  mockListDevices.mockReset();
  mockSocketHandlers.clear();
  mockStorage.clear();
});

describe('verifyCompanionStillLinked', () => {
  it('returns false on 401 AUTH_TOKEN_REVOKED', async () => {
    mockListDevices.mockResolvedValue(revoked());
    await expect(verifyCompanionStillLinked('owner')).resolves.toBe(false);
  });

  it('returns false when a successful list no longer contains this device', async () => {
    mockListDevices.mockResolvedValue(listed('device-B'));
    await expect(verifyCompanionStillLinked('owner')).resolves.toBe(false);
  });

  it('returns true while this device is listed', async () => {
    mockListDevices.mockResolvedValue(listed('device-B', 'device-A'));
    await expect(verifyCompanionStillLinked('owner')).resolves.toBe(true);
  });

  it.each([
    ['a network error', new NetworkError('Network request failed')],
    ['a timeout', new NetworkError('Timeout')],
    ['a 500', new ApiError(500, 'INTERNAL', 'boom')],
    ['a 401 with another code', new ApiError(401, 'AUTH_TOKEN_MISSING', 'Missing authentication token')],
    ['a 403', new ApiError(403, 'COMPANION_NOT_ALLOWED', 'nope')],
  ])('treats %s as transient (stays linked)', async (_label, error) => {
    mockListDevices.mockResolvedValue(failed(error));
    await expect(verifyCompanionStillLinked('owner')).resolves.toBe(true);
  });

  it('treats a thrown request as transient', async () => {
    mockListDevices.mockRejectedValue(new Error('kaboom'));
    await expect(verifyCompanionStillLinked('owner')).resolves.toBe(true);
  });
});

describe('watchCompanionLink', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('fires onRemoved once when the socket reports this device removed', async () => {
    mockListDevices.mockResolvedValue(listed('device-A'));
    const onRemoved = jest.fn();
    watchCompanionLink('owner', onRemoved);
    await flush();

    emitSocket('device:removed', { deviceId: 'device-A' });
    emitSocket('device:removed', { deviceId: 'device-A' });

    expect(onRemoved).toHaveBeenCalledTimes(1);
    // The socket handler and the poll are torn down after firing.
    expect(mockSocketHandlers.get('device:removed')?.size ?? 0).toBe(0);
    const calls = mockListDevices.mock.calls.length;
    await jest.advanceTimersByTimeAsync(30_000);
    expect(mockListDevices.mock.calls.length).toBe(calls);
  });

  it('ignores device:removed for other devices', async () => {
    mockListDevices.mockResolvedValue(listed('device-A'));
    const onRemoved = jest.fn();
    const stop = watchCompanionLink('owner', onRemoved);
    await flush();

    emitSocket('device:removed', { deviceId: 'device-B' });
    emitSocket('device:removed', undefined);

    expect(onRemoved).not.toHaveBeenCalled();
    stop();
  });

  it('falls back to polling: fires on 401 AUTH_TOKEN_REVOKED', async () => {
    mockListDevices.mockResolvedValueOnce(listed('device-A')).mockResolvedValue(revoked());
    const onRemoved = jest.fn();
    watchCompanionLink('owner', onRemoved);
    await flush();
    expect(onRemoved).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });

  it('keeps the session on network errors', async () => {
    mockListDevices.mockResolvedValue(failed(new NetworkError('Device is offline')));
    const onRemoved = jest.fn();
    const stop = watchCompanionLink('owner', onRemoved);
    await flush();
    await jest.advanceTimersByTimeAsync(40_000);
    await flush();

    expect(mockListDevices.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(onRemoved).not.toHaveBeenCalled();
    stop();
  });

  it('unsubscribe stops both the socket listener and the poll', async () => {
    mockListDevices.mockResolvedValue(listed('device-A'));
    const onRemoved = jest.fn();
    const stop = watchCompanionLink('owner', onRemoved);
    await flush();
    stop();

    const calls = mockListDevices.mock.calls.length;
    emitSocket('device:removed', { deviceId: 'device-A' });
    await jest.advanceTimersByTimeAsync(30_000);

    expect(onRemoved).not.toHaveBeenCalled();
    expect(mockListDevices.mock.calls.length).toBe(calls);
    expect(mockSocketHandlers.get('device:removed')?.size ?? 0).toBe(0);
  });
});
