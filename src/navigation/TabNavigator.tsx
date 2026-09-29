// ─── Tab Navigator ───────────────────────────────────────────────────────────
// Wraps the five main sections (Chats, Calls, Status, Calendar, Settings) in a
// bottom-tab navigator so switching between them is completely instant — no
// slide/fade animation, no re-mount. The default tab bar is hidden and replaced
// with the existing custom BottomNav pill component so the visual stays identical.

import React, { Suspense, lazy } from 'react';
import { View } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { TabParamList } from '../types';
import { BottomNav } from '../components';

// ── Screen imports ────────────────────────────────────────────────────────────
// ChatsScreen is eager (already in the main chunk); the others are lazy so they
// are only parsed when the user first taps their tab — first-visit cost is
// hidden behind the tab-switch, which is still instant for subsequent visits.
import ChatsScreen from '../screens/ChatsScreen';

function makeLazy<T extends object>(
  factory: () => Promise<{ default: React.ComponentType<T> }>,
) {
  const Lazy = lazy(factory);
  return (props: T) => (
    <Suspense fallback={<View style={{ flex: 1 }} />}>
      <Lazy {...(props as any)} />
    </Suspense>
  );
}

const CallsScreen    = makeLazy(() => import('../screens/CallsScreen'));
const StatusScreen   = makeLazy(() => import('../screens/StatusScreen'));
const CalendarScreen = makeLazy(() => import('../screens/CalenderScreen'));
const SettingsScreen = makeLazy(() => import('../screens/SettingsScreen'));

// ── Custom tab bar ────────────────────────────────────────────────────────────
// The BottomNav pill handles active state, badges, and theming.
// We pass onTabPress so it drives the tab navigator directly — not the stack.
type TabKey = 'chats' | 'calls' | 'status' | 'calendar' | 'settings';
const ROUTE_TO_TAB: Record<string, TabKey> = {
  Chats:    'chats',
  Calls:    'calls',
  Status:   'status',
  Calendar: 'calendar',
  Settings: 'settings',
};
const TAB_TO_ROUTE: Record<TabKey, keyof TabParamList> = {
  chats:    'Chats',
  calls:    'Calls',
  status:   'Status',
  calendar: 'Calendar',
  settings: 'Settings',
};

function CustomTabBar({ state, navigation }: BottomTabBarProps) {
  const activeRoute = state.routes[state.index].name;
  const activeTab   = ROUTE_TO_TAB[activeRoute] ?? 'chats';

  const handleTabPress = (tabId: TabKey) => {
    const routeName = TAB_TO_ROUTE[tabId];
    const target = state.routes.find((r) => r.name === routeName);
    if (!target) return;

    const isFocused = state.routes[state.index].name === routeName;
    const event = navigation.emit({
      type: 'tabPress',
      target: target.key,
      canPreventDefault: true,
    });

    if (!isFocused && !event.defaultPrevented) {
      // navigate to the tab without pushing a new entry onto the stack
      navigation.navigate(routeName as any);
    }
  };

  return <BottomNav active={activeTab} onTabPress={handleTabPress} />;
}

// ── Navigator ─────────────────────────────────────────────────────────────────
const Tab = createBottomTabNavigator<TabParamList>();

export default function TabNavigator() {
  return (
    <Tab.Navigator
      initialRouteName="Chats"
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        // Keeps every tab mounted after first visit → zero re-render cost on
        // subsequent switches. Memory trade-off is acceptable for 5 screens.
        lazy: false,
      }}
    >
      <Tab.Screen name="Chats"    component={ChatsScreen} />
      <Tab.Screen name="Calls"    component={CallsScreen as any} />
      <Tab.Screen name="Status"   component={StatusScreen as any} />
      <Tab.Screen name="Calendar" component={CalendarScreen as any} />
      <Tab.Screen name="Settings" component={SettingsScreen as any} />
    </Tab.Navigator>
  );
}
