// ─── Screen: Notifications Inbox ────────────────────────────────────────────
import React from 'react';
import {
  View, FlatList, TouchableOpacity, StyleSheet, Platform,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNotifications, AppNotification, NotifType } from '../context/NotificationContext';
import { useAuth } from '../hooks/useAuth';
import { getOrCreateDirectChat } from '../hooks/useChatActions';
import { COLORS, RADIUS, SHADOW, GRADIENTS, GLASS } from '../types/theme';
import { RootStackParamList } from '../types';

type NavProp = NativeStackNavigationProp<RootStackParamList>;

const ICON_MAP: Record<NotifType, React.ComponentProps<typeof AppIcon>['name']> = {
  message:       'chatbubble-outline',
  call:          'call-outline',
  number_change: 'phone-portrait-outline',
  system:        'information-circle-outline',
};

const TYPE_COLOR: Record<NotifType, string> = {
  message:       COLORS.blue,
  call:          COLORS.green,
  number_change: '#f59e0b',
  system:        COLORS.sub,
};

function NotifRow({ notif }: { notif: AppNotification }) {
  const navigation = useNavigation<NavProp>();
  const { FG }     = useForeground();
  const { textColor, fontFamily } = useTypography();
  const { markRead } = useNotifications();
  const { bevel } = useGlass();
  const { user } = useAuth();

  const handlePress = async () => {
    markRead(notif.id);
    
    // If notification has a contactId (user ID), open chat with them
    if (notif.contactId && user?.uid) {
      try {
        const chatId = await getOrCreateDirectChat(user.uid, notif.contactId);
        // We don't have display name here, but ChatScreen will fetch it
        navigation.navigate('Chat', { 
          chatId, 
          displayName: notif.title, // Use title as temporary display name
          isGroup: false,
          otherUserId: notif.contactId,
        });
      } catch (error) {
        console.error('[NotifRow] Failed to open chat:', error);
        // Fallback: just navigate to Chats screen
        navigation.navigate('Chats');
      }
    } else {
      // No contactId or not logged in - just go to Chats
      navigation.navigate('Chats');
    }
  };

  const iconName  = ICON_MAP[notif.type];
  const iconColor = TYPE_COLOR[notif.type];

  return (
    <TouchableOpacity
      style={[
        styles.row,
        notif.read
          ? bevel
          : {
              backgroundColor: 'rgba(74,153,233,0.08)',
              borderWidth: 1,
              borderColor: 'rgba(74,153,233,0.28)',
            },
      ]}
      activeOpacity={0.75}
      onPress={handlePress}
    >
      {/* Unread dot */}
      {!notif.read && <View style={styles.unreadDot} />}

      {/* Icon tile */}
      <View style={[styles.iconTile, { backgroundColor: `${iconColor}18`, borderColor: `${iconColor}30` }]}>
        <AppIcon name={iconName} size={20} color={iconColor} fixedColor />
      </View>

      {/* Text */}
      <View style={styles.textWrap}>
        <AppText style={[styles.title, { color: textColor, fontFamily }]} numberOfLines={1}>
          {notif.title}
        </AppText>
        <AppText style={[styles.body, { color: FG.secondary }]} numberOfLines={2}>
          {notif.body}
        </AppText>
      </View>

      {/* Time */}
      <AppText style={[styles.time, { color: FG.secondary }]}>{notif.time}</AppText>
    </TouchableOpacity>
  );
}

export default function NotificationsScreen() {
  const navigation = useNavigation<NavProp>();
  const { FG }     = useForeground();
  const { textColor, fontFamily } = useTypography();
  const { notifications, unreadCount, markAllRead, clearAll } = useNotifications();
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.root}>
      <AppBg />

      {/* Header */}
      <View style={[styles.header, { backgroundColor: FG.glassBg, borderBottomColor: FG.glassBorder, paddingTop: Platform.OS === 'web' ? 16 : insets.top + 12 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <AppIcon name="chevron-back" size={26} color={COLORS.blue} fixedColor />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <AppText style={[styles.headerTitle, { color: textColor, fontFamily }]}>
            Notifications
          </AppText>
          {unreadCount > 0 && (
            <View style={styles.headerBadge}>
              <AppText fixedColor style={styles.headerBadgeText}>{unreadCount}</AppText>
            </View>
          )}
        </View>
        <View style={styles.headerActions}>
          {unreadCount > 0 && (
            <TouchableOpacity onPress={markAllRead} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <AppIcon name="checkmark-done-outline" size={22} color={COLORS.blue} fixedColor />
            </TouchableOpacity>
          )}
          {notifications.length > 0 && (
            <TouchableOpacity onPress={clearAll} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <AppIcon name="trash-outline" size={20} color={COLORS.sub} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* List */}
      <FlatList
        data={notifications}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <NotifRow notif={item} />}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <View style={styles.emptyIconWrap}>
              <LinearGradient colors={['rgba(74,153,233,0.12)', 'rgba(74,153,233,0.04)']} style={styles.emptyIconGrad}>
                <AppIcon name="notifications-off-outline" size={40} color={COLORS.sub} />
              </LinearGradient>
            </View>
            <AppText style={[styles.emptyTitle, { color: textColor }]}>All caught up</AppText>
            <AppText style={[styles.emptySub, { color: FG.secondary }]}>
              New messages, calls and alerts will appear here.
            </AppText>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingTop: 0, paddingBottom: 12, paddingHorizontal: 14,
    borderBottomWidth: 1, gap: 10,
  },
  back:         {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.8)',
  },
  headerCenter: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle:  { fontSize: 17, fontWeight: '700', color: COLORS.text },
  headerBadge:  {
    backgroundColor: COLORS.blue, borderRadius: 10,
    minWidth: 20, height: 20, paddingHorizontal: 5,
    alignItems: 'center', justifyContent: 'center',
  },
  headerBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  headerActions:   { flexDirection: 'row', gap: 14, alignItems: 'center' },

  list: { padding: 14, paddingBottom: 40 },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14, paddingVertical: 12,
    position: 'relative',
  },
  unreadDot: {
    position: 'absolute', left: 6, top: '50%',
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: COLORS.blue,
    marginTop: -4,
  },
  iconTile: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, flexShrink: 0,
  },
  textWrap: { flex: 1 },
  title:    { fontSize: 13, fontWeight: '700', color: COLORS.text, marginBottom: 2 },
  body:     { fontSize: 12, color: COLORS.sub, lineHeight: 17 },
  time:     { fontSize: 10, color: COLORS.sub, flexShrink: 0 },

  empty: { flex: 1, alignItems: 'center', paddingTop: 80, gap: 12, paddingHorizontal: 32 },
  emptyIconWrap: {},
  emptyIconGrad: {
    width: 88, height: 88, borderRadius: 44,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 4,
  },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: COLORS.text, textAlign: 'center' },
  emptySub:   { fontSize: 13, color: COLORS.sub, textAlign: 'center', lineHeight: 20 },
});
