// ─── Notification Test Panel ─────────────────────────────────────────────────
// DEVELOPMENT ONLY: Test panel for verifying notification system
// Add this component to any screen to test notifications manually

import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { AppText } from '../context/ThemeContext';
import { useNotifications } from '../context/NotificationContext';

export function NotificationTestPanel() {
  const { pushNotification, notifications, unreadCount } = useNotifications();

  const testMessage = () => {
    console.log('[TEST] Triggering test message notification');
    pushNotification({
      type: 'message',
      title: 'Test User',
      body: 'This is a test message notification',
      contactId: 'test-user-123',
    });
  };

  const testCall = () => {
    console.log('[TEST] Triggering test call notification');
    pushNotification({
      type: 'call',
      title: 'Missed Call',
      body: 'Test Caller tried to call you',
      contactId: 'test-caller-123',
    });
  };

  const testSystem = () => {
    console.log('[TEST] Triggering test system notification');
    pushNotification({
      type: 'system',
      title: 'System Update',
      body: 'Test system notification',
    });
  };

  return (
    <View style={styles.container}>
      <AppText style={styles.title}>
        Notification Test Panel (Dev Only)
      </AppText>
      
      <AppText style={styles.info}>
        Current notifications: {notifications.length} (Unread: {unreadCount})
      </AppText>

      <View style={styles.buttons}>
        <TouchableOpacity style={[styles.button, styles.messageBtn]} onPress={testMessage}>
          <AppText style={styles.buttonText}>Test Message</AppText>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.button, styles.callBtn]} onPress={testCall}>
          <AppText style={styles.buttonText}>Test Call</AppText>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.button, styles.systemBtn]} onPress={testSystem}>
          <AppText style={styles.buttonText}>Test System</AppText>
        </TouchableOpacity>
      </View>

      <AppText style={styles.hint}>
        Check console logs for detailed output
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    backgroundColor: '#fff3cd',
    borderRadius: 8,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 8,
    borderWidth: 2,
    borderColor: '#ffc107',
    zIndex: 1000,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8,
    color: '#856404',
  },
  info: {
    fontSize: 12,
    marginBottom: 12,
    color: '#856404',
  },
  buttons: {
    flexDirection: 'row',
    gap: 8,
  },
  button: {
    flex: 1,
    padding: 12,
    borderRadius: 6,
    alignItems: 'center',
  },
  messageBtn: {
    backgroundColor: '#09B2EE',
  },
  callBtn: {
    backgroundColor: '#10b981',
  },
  systemBtn: {
    backgroundColor: '#6b7280',
  },
  buttonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  hint: {
    fontSize: 10,
    marginTop: 8,
    fontStyle: 'italic',
    color: '#856404',
  },
});
