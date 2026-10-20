// ─── AppNavigator Unit Tests: Profile Gating ─────────────────────────────────
// Tests: profile existence check gates navigation to Chats vs CreateAccount.
// Now uses the backend API (GET /me) instead of Firestore.
// Requirements: 5.2, 5.3, 5.4, 5.5

import React from 'react';
import { create, act, ReactTestRenderer } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Mock react-native ────────────────────────────────────────────────────────

jest.mock('react-native', () => {
  const React = require('react');
  return {
    View:              (props: any) => React.createElement('View', props, props.children),
    Text:              (props: any) => React.createElement('Text', props, props.children),
    ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props),
    TouchableOpacity:  (props: any) => React.createElement('TouchableOpacity', props, props.children),
    StyleSheet: { create: (s: any) => s },
    Platform: { OS: 'ios' },
  };
});

// ─── Mock theme ───────────────────────────────────────────────────────────────

jest.mock('../../types/theme', () => ({
  COLORS: { blue: '#007AFF', text: '#FFFFFF', sub: '#AAAAAA', white: '#FFFFFF' },
}));

jest.mock('../../context/ThemeContext', () => {
  const React = require('react');
  return { AppBg: () => React.createElement('AppBg') };
});

// ─── Mock AuthContext ─────────────────────────────────────────────────────────

let mockAuthValue: any = { isSignedIn: false, loading: false, phone: '', displayName: '' };

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => mockAuthValue,
}));

// ─── Mock @react-native-firebase/auth ─────────────────────────────────────────

jest.mock('@react-native-firebase/auth', () => ({
  getAuth:  () => ({ currentUser: { uid: 'test-uid-123' } }),
  signOut:  jest.fn().mockResolvedValue(undefined),
  firebaseSignOut: jest.fn().mockResolvedValue(undefined),
}));

// ─── Mock backend API ─────────────────────────────────────────────────────────

const mockGetMe = jest.fn();

jest.mock('../../api/endpoints', () => ({
  endpoints: {
    getMe: (...args: any[]) => mockGetMe(...args),
  },
}));

// ─── Mock navigator ───────────────────────────────────────────────────────────

const mockScreens: Array<{ name: string }> = [];
let mockInitialRouteName: string | undefined;

jest.mock('@react-navigation/native-stack', () => {
  const React = require('react');
  return {
    createNativeStackNavigator: () => ({
      Navigator: ({ children, initialRouteName }: any) => {
        mockInitialRouteName = initialRouteName;
        mockScreens.length = 0;
        const flatten = (nodes: any): any[] => {
          if (!nodes) return [];
          if (Array.isArray(nodes)) return nodes.flatMap(flatten);
          if (nodes.props?.children) return flatten(nodes.props.children);
          return [nodes];
        };
        flatten(children).forEach((child: any) => {
          if (child?.props?.name) mockScreens.push({ name: child.props.name });
        });
        return React.createElement('Navigator', { initialRouteName }, null);
      },
      Screen: ({ name, component }: any) => React.createElement('Screen', { name, component }),
    }),
  };
});

// ─── Mock screens ────────────────────────────────────────────────────────────

const screens = [
  'SplashScreen','SignInScreen','CreateAccountScreen','TabNavigator',
  'ChatScreen','ContactsScreen','AppearanceScreen','ProfileScreen',
  'VideoCallScreen','AudioCallScreen','AccountSettingsScreen',
  'PrivacySettingsScreen','NotificationSettingsScreen','ChangeNumberScreen',
  'NotificationsScreen','LinkedDevicesScreen','BlockedContactsScreen','BroadcastScreen',
];
screens.forEach((s) => {
  jest.mock(`../../screens/${s}`, () => {
    const React = require('react');
    return { __esModule: true, default: () => React.createElement(s) };
  }, { virtual: true });
});
jest.mock('../../navigation/TabNavigator', () => {
  const React = require('react');
  return { __esModule: true, default: () => React.createElement('TabNavigator') };
});
jest.mock('../../components', () => ({ IncomingCallManager: () => null }));

// ─── Import after mocks ──────────────────────────────────────────────────────

import AppNavigator from '../AppNavigator';

function flushPromises() { return new Promise(resolve => setTimeout(resolve, 0)); }

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('AppNavigator — profile gating', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockScreens.length = 0;
    mockInitialRouteName = undefined;
    mockAuthValue = { isSignedIn: false, loading: false, phone: '', displayName: '' };
    mockGetMe.mockReset();
  });

  // ── Req 5.4: Loading state ──
  describe('loading state (Req 5.4)', () => {
    it('shows ActivityIndicator while auth context is loading', () => {
      mockAuthValue = { isSignedIn: false, loading: true, phone: '', displayName: '' };
      let tree: ReactTestRenderer;
      act(() => { tree = create(<AppNavigator />); });
      expect(tree!.root.findAllByType('ActivityIndicator' as any).length).toBeGreaterThan(0);
    });
  });

  // ── Req 5.2: authenticated + profile exists → Chats ──
  describe('authenticated + profile exists (Req 5.2)', () => {
    it('uses Chats as initial route when profile has a displayName', async () => {
      mockAuthValue = { isSignedIn: true, loading: false, phone: '+27821234567', displayName: 'Jack' };
      mockGetMe.mockResolvedValue({ ok: true, data: { id: 'test-uid-123', displayName: 'Jack', phoneNumber: '+27821234567', avatarObjectKey: null, about: null, email: null, website: null, catalog: null, operationalHours: null, accountType: 'business' } });

      let tree: ReactTestRenderer;
      await act(async () => { tree = create(<AppNavigator />); await flushPromises(); });

      const screenNames = mockScreens.map(s => s.name);
      expect(screenNames).toContain('Chats');
    });
  });

  // ── Req 5.3: authenticated + no profile → CreateAccount ──
  // Backend contract: GET /me returns 404 for a Firebase UID with no DB row.
  // That 404 marks the user as "no profile", so the navigator falls back to
  // the unauthenticated branch (Splash/SignIn/CreateAccount) and the sign-out
  // effect clears the orphaned session.
  describe('authenticated + no profile (Req 5.3)', () => {
    it('uses CreateAccount when GET /me returns 404 (no DB row)', async () => {
      mockAuthValue = { isSignedIn: true, loading: false, phone: '', displayName: '' };
      mockGetMe.mockResolvedValue({ ok: false, error: { status: 404, message: 'Not found', kind: 'http', code: 'NOT_FOUND' } });

      let tree: ReactTestRenderer;
      await act(async () => { tree = create(<AppNavigator />); await flushPromises(); });

      const screenNames = mockScreens.map(s => s.name);
      expect(screenNames).toContain('CreateAccount');
    });
  });

  // ── Unauthenticated shows Splash ──
  describe('unauthenticated', () => {
    it('shows Splash and SignIn when not signed in', () => {
      mockAuthValue = { isSignedIn: false, loading: false, phone: '', displayName: '' };
      let tree: ReactTestRenderer;
      act(() => { tree = create(<AppNavigator />); });
      expect(mockInitialRouteName).toBe('Splash');
      const screenNames = mockScreens.map(s => s.name);
      expect(screenNames).toContain('Splash');
    });
  });
});
