import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockConfirm = jest.fn();
const mockSignInWithPhoneNumber = jest.fn();
const mockGetMe = jest.fn();
const mockUpdateMe = jest.fn();

jest.mock('@react-native-firebase/auth', () => ({
  getAuth: () => ({ currentUser: { uid: 'test-uid-123' } }),
  signInWithPhoneNumber: (...args: any[]) => mockSignInWithPhoneNumber(...args),
}));

// The hook must never touch the backend. Keeping these mocks gives the test a
// direct regression assertion for the registration-order security guarantee.
jest.mock('../../api/endpoints', () => ({
  endpoints: {
    getMe: (...args: any[]) => mockGetMe(...args),
    updateMe: (...args: any[]) => mockUpdateMe(...args),
  },
}));

import { useRegistration } from '../useRegistration';

function renderHook<T>(hookFn: () => T): { result: { current: T } } {
  const result: { current: T } = {} as any;
  let renderer: ReactTestRenderer;
  function TestComponent() {
    result.current = hookFn();
    return null;
  }
  act(() => { renderer = create(React.createElement(TestComponent)); });
  void renderer!;
  return { result };
}

describe('useRegistration — OTP only', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSignInWithPhoneNumber.mockResolvedValue({ confirm: mockConfirm });
    mockConfirm.mockResolvedValue({ user: { uid: 'test-uid-123' } });
  });

  it('sends OTP to the supplied phone and transitions to otp', async () => {
    const { result } = renderHook(() => useRegistration());
    await act(async () => {
      await result.current.submitRegistration('Acme', '+27821234567', null);
    });
    expect(mockSignInWithPhoneNumber).toHaveBeenCalledWith(
      expect.objectContaining({ currentUser: expect.anything() }),
      '+27821234567',
    );
    expect(result.current.registrationStep).toBe('otp');
  });

  it('verifies OTP but does not create a backend profile', async () => {
    const { result } = renderHook(() => useRegistration());
    await act(async () => {
      await result.current.submitRegistration('Acme', '+27821234567', null);
      await result.current.verifyOTP('123456');
    });
    expect(mockConfirm).toHaveBeenCalledWith('123456');
    expect(result.current.registrationStep).toBe('verified');
    expect(mockGetMe).not.toHaveBeenCalled();
    expect(mockUpdateMe).not.toHaveBeenCalled();
  });

  it('rejects OTP when no confirmation is pending', async () => {
    const { result } = renderHook(() => useRegistration());
    let ok = true;
    await act(async () => { ok = await result.current.verifyOTP('123456'); });
    expect(ok).toBe(false);
    expect(result.current.error).toContain('No confirmation pending');
  });

  it('maps Firebase verification errors', async () => {
    mockConfirm.mockRejectedValueOnce({ code: 'auth/invalid-verification-code' });
    const { result } = renderHook(() => useRegistration());
    await act(async () => {
      await result.current.submitRegistration('Acme', '+27821234567', null);
      await result.current.verifyOTP('000000');
    });
    expect(result.current.registrationStep).toBe('error');
    expect(result.current.error).toBe('Incorrect code. Please try again.');
  });

  it('allows at most three OTP resends', async () => {
    const { result } = renderHook(() => useRegistration());
    await act(async () => {
      await result.current.submitRegistration('Acme', '+27821234567', null);
    });
    for (let i = 0; i < 3; i += 1) {
      await act(async () => { await result.current.resendOTP(); });
    }
    expect(result.current.resendCount).toBe(3);
    expect(result.current.canResend).toBe(false);
    mockSignInWithPhoneNumber.mockClear();
    let ok = true;
    await act(async () => { ok = await result.current.resendOTP(); });
    expect(ok).toBe(false);
    expect(mockSignInWithPhoneNumber).not.toHaveBeenCalled();
  });
});
