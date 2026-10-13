// ─── useRegistration Unit Tests ───────────────────────────────────────────────
// Tests: OTP send, verify, resend limits, profile creation via backend API.
// Requirements: 2.1, 2.3, 2.6, 2.7, 3.1, 3.2, 3.4, 3.5

import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';

// ─── Mock @react-native-firebase/auth ─────────────────────────────────────────

const mockConfirm = jest.fn();
const mockSignInWithPhoneNumber = jest.fn();

jest.mock('@react-native-firebase/auth', () => ({
  getAuth: () => ({
    currentUser: { uid: 'test-uid-123' },
  }),
  signInWithPhoneNumber: (...args: any[]) => mockSignInWithPhoneNumber(...args),
}));

// ─── Mock backend endpoints ───────────────────────────────────────────────────

const mockUpdatePhone = jest.fn();
const mockUpdateMe = jest.fn();

jest.mock('../../api/endpoints', () => ({
  endpoints: {
    updatePhone: (...args: any[]) => mockUpdatePhone(...args),
    updateMe: (...args: any[]) => mockUpdateMe(...args),
  },
}));

// ─── Mock mediaService ────────────────────────────────────────────────────────

jest.mock('../../services/mediaService', () => ({
  mediaService: {
    upload: jest.fn().mockResolvedValue('avatars/test-uid-123/photo.jpg'),
  },
  fileSize: jest.fn().mockResolvedValue(1024),
}));

// ─── Import after mocks ──────────────────────────────────────────────────────

import { useRegistration } from '../useRegistration';

// ─── Minimal renderHook ────────────────────────────────────────────────────────

function renderHook<T>(hookFn: () => T): { result: { current: T }; rerender: () => void } {
  const result: { current: T } = {} as any;
  let renderer: ReactTestRenderer;

  function TestComponent() {
    result.current = hookFn();
    return null;
  }

  act(() => { renderer = create(React.createElement(TestComponent)); });
  const rerender = () => { act(() => { renderer.update(React.createElement(TestComponent)); }); };
  return { result, rerender };
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('useRegistration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSignInWithPhoneNumber.mockResolvedValue({ confirm: mockConfirm });
    mockConfirm.mockResolvedValue({ user: { uid: 'test-uid-123' } });
    mockUpdatePhone.mockResolvedValue({ ok: true, data: { phoneNumber: '+27821234567' } });
    mockUpdateMe.mockResolvedValue({ ok: true, data: { id: 'test-uid-123', displayName: 'TestUser', phoneNumber: '+27821234567', avatarObjectKey: null, about: null, email: null, website: null, catalog: null, operationalHours: null, accountType: 'business' } });
  });

  // ── Req 2.1: OTP send triggers signInWithPhoneNumber ──
  describe('submitRegistration — OTP send (Req 2.1)', () => {
    it('calls signInWithPhoneNumber with the provided phone number', async () => {
      const { result } = renderHook(() => useRegistration());
      await act(async () => { await result.current.submitRegistration('TestUser', '+27821234567', null); });
      expect(mockSignInWithPhoneNumber).toHaveBeenCalledWith('+27821234567');
    });

    it('transitions step to "otp" on success', async () => {
      const { result } = renderHook(() => useRegistration());
      expect(result.current.registrationStep).toBe('form');
      await act(async () => { await result.current.submitRegistration('TestUser', '+27821234567', null); });
      expect(result.current.registrationStep).toBe('otp');
    });

    it('sets error and step to "error" when signInWithPhoneNumber fails', async () => {
      mockSignInWithPhoneNumber.mockRejectedValue({ code: 'auth/invalid-phone-number' });
      const { result } = renderHook(() => useRegistration());
      await act(async () => { await result.current.submitRegistration('TestUser', '+invalid', null); });
      expect(result.current.registrationStep).toBe('error');
      expect(result.current.error).toBe('Invalid phone number. Use format +27XXXXXXXXX');
    });
  });

  // ── Req 2.3: verifyOTP calls confirmation.confirm ──
  describe('verifyOTP (Req 2.3)', () => {
    it('calls confirm on the stored confirmation result with the provided code', async () => {
      const { result } = renderHook(() => useRegistration());
      await act(async () => { await result.current.submitRegistration('TestUser', '+27821234567', null); });
      await act(async () => { await result.current.verifyOTP('123456'); });
      expect(mockConfirm).toHaveBeenCalledWith('123456');
    });

    it('returns false and sets error when no confirmation is pending', async () => {
      const { result } = renderHook(() => useRegistration());
      let returnValue = true;
      await act(async () => { returnValue = await result.current.verifyOTP('123456'); });
      expect(returnValue).toBe(false);
      expect(result.current.error).toBe('No confirmation pending — please resend OTP');
    });

    it('transitions to "done" on successful verification', async () => {
      const { result } = renderHook(() => useRegistration());
      await act(async () => { await result.current.submitRegistration('TestUser', '+27821234567', null); });
      await act(async () => { await result.current.verifyOTP('123456'); });
      expect(result.current.registrationStep).toBe('done');
    });

    it('sets error when confirm throws', async () => {
      mockConfirm.mockRejectedValue({ code: 'auth/invalid-verification-code' });
      const { result } = renderHook(() => useRegistration());
      await act(async () => { await result.current.submitRegistration('TestUser', '+27821234567', null); });
      await act(async () => { await result.current.verifyOTP('000000'); });
      expect(result.current.registrationStep).toBe('error');
      expect(result.current.error).toBe('Incorrect code. Please try again.');
    });
  });

  // ── Req 2.6, 2.7: Resend count increments and disables after 3 ──
  describe('resendOTP — resend limiting (Req 2.6, 2.7)', () => {
    it('starts with resendCount 0 and canResend true', () => {
      const { result } = renderHook(() => useRegistration());
      expect(result.current.resendCount).toBe(0);
      expect(result.current.canResend).toBe(true);
    });

    it('increments resendCount on each successful resend', async () => {
      const { result } = renderHook(() => useRegistration());
      await act(async () => { await result.current.submitRegistration('TestUser', '+27821234567', null); });
      await act(async () => { await result.current.resendOTP(); });
      expect(result.current.resendCount).toBe(1);
      expect(result.current.canResend).toBe(true);
    });

    it('returns false and stops calling signInWithPhoneNumber after 3 resends', async () => {
      const { result } = renderHook(() => useRegistration());
      await act(async () => { await result.current.submitRegistration('TestUser', '+27821234567', null); });
      mockSignInWithPhoneNumber.mockClear();
      await act(async () => { await result.current.resendOTP(); });
      await act(async () => { await result.current.resendOTP(); });
      await act(async () => { await result.current.resendOTP(); });
      expect(result.current.resendCount).toBe(3);
      expect(result.current.canResend).toBe(false);
      mockSignInWithPhoneNumber.mockClear();
      let returnValue = true;
      await act(async () => { returnValue = await result.current.resendOTP(); });
      expect(returnValue).toBe(false);
      expect(mockSignInWithPhoneNumber).not.toHaveBeenCalled();
    });
  });

  // ── Req 3.1, 3.2: createProfile writes to backend ──
  describe('createProfile — backend write (Req 3.1, 3.2)', () => {
    it('calls updatePhone and updateMe with correct fields', async () => {
      const { result } = renderHook(() => useRegistration());
      await act(async () => { await result.current.submitRegistration('TestUser', '+27821234567', null); });
      await act(async () => { await result.current.verifyOTP('123456'); });
      expect(mockUpdatePhone).toHaveBeenCalledWith('+27821234567');
      expect(mockUpdateMe).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'TestUser', avatarObjectKey: null }));
    });

    it('transitions to "done" on successful profile creation', async () => {
      const { result } = renderHook(() => useRegistration());
      await act(async () => { await result.current.submitRegistration('TestUser', '+27821234567', null); });
      await act(async () => { await result.current.verifyOTP('123456'); });
      expect(result.current.registrationStep).toBe('done');
    });
  });

  // ── Req 3.4: Image upload stores to object store ──
  describe('createProfile — image upload (Req 3.4)', () => {
    it('passes avatarObjectKey to updateMe when image provided', async () => {
      const { result } = renderHook(() => useRegistration());
      await act(async () => { await result.current.submitRegistration('TestUser', '+27821234567', 'file:///tmp/photo.jpg'); });
      await act(async () => { await result.current.verifyOTP('123456'); });
      expect(mockUpdateMe).toHaveBeenCalledWith(expect.objectContaining({ avatarObjectKey: 'avatars/test-uid-123/photo.jpg' }));
    });

    it('sets avatarObjectKey to null when no image provided', async () => {
      const { result } = renderHook(() => useRegistration());
      await act(async () => { await result.current.submitRegistration('TestUser', '+27821234567', null); });
      await act(async () => { await result.current.verifyOTP('123456'); });
      expect(mockUpdateMe).toHaveBeenCalledWith(expect.objectContaining({ avatarObjectKey: null }));
    });
  });

  // ── Req 3.5: retryProfileCreation works without re-verification ──
  describe('retryProfileCreation (Req 3.5)', () => {
    it('retries profile creation without calling signInWithPhoneNumber again', async () => {
      mockUpdateMe.mockRejectedValueOnce(new Error('Network error'));
      const { result } = renderHook(() => useRegistration());
      await act(async () => { await result.current.submitRegistration('TestUser', '+27821234567', null); });
      await act(async () => { await result.current.verifyOTP('123456'); });
      expect(result.current.registrationStep).toBe('error');
      mockSignInWithPhoneNumber.mockClear();
      mockConfirm.mockClear();
      mockUpdateMe.mockResolvedValue({ ok: true, data: { id: 'test-uid-123', displayName: 'TestUser', phoneNumber: '+27821234567', avatarObjectKey: null, about: null, email: null, website: null, catalog: null, operationalHours: null, accountType: 'business' } });
      await act(async () => { await result.current.retryProfileCreation(); });
      expect(mockSignInWithPhoneNumber).not.toHaveBeenCalled();
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(result.current.registrationStep).toBe('done');
    });
  });

  // ── proceedWithoutPhoto ──
  describe('proceedWithoutPhoto', () => {
    it('creates profile with null avatarObjectKey', async () => {
      const { mediaService } = await import('../../services/mediaService');
      (mediaService.upload as jest.Mock).mockRejectedValueOnce(new Error('Upload failed'));
      const { result } = renderHook(() => useRegistration());
      await act(async () => { await result.current.submitRegistration('TestUser', '+27821234567', 'file:///tmp/photo.jpg'); });
      await act(async () => { await result.current.verifyOTP('123456'); });
      expect(result.current.registrationStep).toBe('error');
      (mediaService.upload as jest.Mock).mockClear();
      await act(async () => { await result.current.proceedWithoutPhoto(); });
      expect(mediaService.upload).not.toHaveBeenCalled();
      expect(mockUpdateMe).toHaveBeenCalledWith(expect.objectContaining({ avatarObjectKey: null }));
      expect(result.current.registrationStep).toBe('done');
    });
  });
});
