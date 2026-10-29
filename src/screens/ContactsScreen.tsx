// ─── Screen: Contacts ────────────────────────────────────────────────────────
import React, { useState } from 'react';
import { View, FlatList, TouchableOpacity, StyleSheet, TextInput, Alert, ActivityIndicator } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Avatar } from '../components';
import { COLORS, RADIUS, SHADOW, GRADIENTS, GLASS } from '../types/theme';
import { RootStackParamList } from '../types';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';
import { useContacts, AppContact } from '../hooks/useContacts';
import { useAuth } from '../hooks/useAuth';
import { useOutgoingCall } from '../hooks/useOutgoingCall';
import { useCallContext } from '../context/CallContext';

type NavProp = NativeStackNavigationProp<RootStackParamList, 'Contacts'>;

// Helper to get initials from display name
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// Helper to get avatar color based on userId
function getAvatarColor(userId: string): string {
  const colors = [COLORS.blue, COLORS.blueDark, COLORS.green, COLORS.amber, COLORS.missed];
  const index = userId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % colors.length;
  return colors[index];
}

export default function ContactsScreen() {
  const navigation = useNavigation<NavProp>();
  const { user } = useAuth();
  const { contacts, loading, error, hasPermission } = useContacts();
  const outgoingCall = useOutgoingCall();
  
  const { FG } = useForeground();
  const { fontFamily, textColor } = useTypography();
  const { bevel } = useGlass();
  const [query, setQuery] = useState('');
  const [calling, setCalling] = useState(false);
  const [callingContactId, setCallingContactId] = useState<string | null>(null);

  // Filter contacts based on search query
  const data = query.trim()
    ? contacts.filter((c) => 
        c.displayName.toLowerCase().includes(query.toLowerCase()) ||
        c.phone.includes(query)
      )
    : contacts;

  // Handle call button press
  const handleCall = async (contact: AppContact) => {
    if (!user) {
      Alert.alert('Error', 'You must be logged in to make calls');
      return;
    }

    if (!contact.isSaved) {
      Alert.alert(
        'Contact Not on Chit-Chat',
        `${contact.displayName} is not registered on Chit-Chat yet.`,
        [{ text: 'OK' }]
      );
      return;
    }

    setCalling(true);
    setCallingContactId(contact.userId);

    try {
      console.log('[ContactsScreen] Initiating call to:', contact.displayName);
      
      const callId = await outgoingCall.initiateCall(
        user.uid,
        contact.userId,
        {
          userId: user.uid,
          displayName: user.displayName || 'You',
          photoUrl: user.photoURL,
        },
        {
          userId: contact.userId,
          displayName: contact.displayName,
          photoUrl: contact.firebasePhotoURL || null,
        }
      );

      if (callId) {
        // Navigate to call screen
        navigation.navigate('AudioCall', {
          callId,
          isOutgoing: true,
          otherParty: {
            userId: contact.userId,
            displayName: contact.displayName,
            photoUrl: contact.firebasePhotoURL || null,
          },
        });
      } else {
        Alert.alert('Call Failed', 'Unable to initiate call');
      }
    } catch (err) {
      console.error('[ContactsScreen] Call failed:', err);
      Alert.alert('Call Failed', 'Unable to start call. Please try again.');
    } finally {
      setCalling(false);
      setCallingContactId(null);
    }
  };

  // Handle chat navigation
  const handleChat = (contact: AppContact) => {
    // For now, contacts must be on the app to chat
    if (!contact.isSaved) {
      Alert.alert(
        'Contact Not Available',
        `${contact.displayName} is not on Chit-Chat yet.`
      );
      return;
    }

    // Navigate to chat (implementation depends on your chat system)
    // You might need to create or find an existing chat first
    Alert.alert('Chat', `Opening chat with ${contact.displayName}`);
  };

  const renderItem = ({ item }: { item: AppContact }) => {
    const isCurrentlyCalling = calling && callingContactId === item.userId;
    const canCall = item.isSaved; // Only registered users can be called

    return (
      <TouchableOpacity
        style={[styles.contactCard, bevel]}
        activeOpacity={0.75}
        onPress={() => handleChat(item)}
        disabled={!canCall}
      >
        <Avatar 
          initials={getInitials(item.displayName)} 
          color={getAvatarColor(item.userId)} 
          size={48} 
        />
        <View style={styles.contactMeta}>
          <AppText style={[styles.contactName, { color: textColor, fontFamily }]}>
            {item.displayName}
          </AppText>
          <AppText style={[styles.contactSub, { color: FG.secondary }]} numberOfLines={1}>
            {canCall ? 'On Chit-Chat' : 'Not on Chit-Chat'}
          </AppText>
        </View>
        
        {/* Call button - only enabled for registered users */}
        {canCall ? (
          <TouchableOpacity 
            activeOpacity={0.85}
            onPress={() => handleCall(item)}
            disabled={calling}
          >
            {isCurrentlyCalling ? (
              <View style={styles.callBtn}>
                <ActivityIndicator size="small" color="#fff" />
              </View>
            ) : (
              <LinearGradient colors={GRADIENTS.primary} style={styles.callBtn}>
                <AppIcon name="call" size={15} color="#fff" fixedColor />
              </LinearGradient>
            )}
          </TouchableOpacity>
        ) : (
          <View style={styles.callBtnDisabled}>
            <AppIcon name="call" size={15} color={COLORS.sub} />
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.root}>
      <AppBg />

      <View style={styles.header}>
        <AppText style={[styles.title, { color: textColor, fontFamily }]}>Contacts</AppText>
        <TouchableOpacity activeOpacity={0.85}>
          <LinearGradient colors={GRADIENTS.primary} style={styles.addBtn}>
            <AppIcon name="add" size={20} color="#fff" fixedColor />
          </LinearGradient>
        </TouchableOpacity>
      </View>

      {/* Glass search bar */}
      <View style={styles.searchWrap}>
        <AppIcon name="search-outline" size={16} color={COLORS.sub} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search contacts"
          placeholderTextColor={COLORS.sub}
          value={query}
          onChangeText={setQuery}
          editable={!loading}
        />
      </View>

      {/* Loading state */}
      {loading ? (
        <View style={styles.centerWrap}>
          <ActivityIndicator size="large" color={COLORS.blue} />
          <AppText style={styles.centerText}>Loading contacts...</AppText>
        </View>
      ) : error ? (
        <View style={styles.centerWrap}>
          <AppIcon name="alert-circle-outline" size={48} color={COLORS.missed} />
          <AppText style={styles.centerText}>Failed to load contacts</AppText>
          <AppText style={styles.errorText}>{error}</AppText>
        </View>
      ) : !hasPermission ? (
        <View style={styles.centerWrap}>
          <AppIcon name="lock-closed-outline" size={48} color={COLORS.sub} />
          <AppText style={styles.centerText}>Contacts Permission Required</AppText>
          <AppText style={styles.hintText}>
            Please allow contacts access in your device settings
          </AppText>
        </View>
      ) : (
        <FlatList
          data={data}
          keyExtractor={(item) => item.userId}
          renderItem={renderItem}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          removeClippedSubviews
          maxToRenderPerBatch={15}
          windowSize={10}
          initialNumToRender={15}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <AppIcon name="people-outline" size={48} color={COLORS.sub} />
              <AppText style={styles.emptyText}>No contacts found</AppText>
              {query.trim() && (
                <AppText style={styles.hintText}>Try a different search</AppText>
              )}
            </View>
          }
          ListHeaderComponent={
            contacts.length > 0 ? (
              <View style={styles.headerInfo}>
                <AppText style={styles.headerInfoText}>
                  {contacts.filter(c => c.isSaved).length} of {contacts.length} on Chit-Chat
                </AppText>
              </View>
            ) : null
          }
        />
      )}

      {/* Calling overlay */}
      {calling && (
        <View style={styles.callingOverlay}>
          <ActivityIndicator size="large" color="#fff" />
          <AppText fixedColor style={styles.callingText}>Starting call...</AppText>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.sky1 },

  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 56, paddingBottom: 10,
  },
  title:  { fontSize: 26, fontWeight: '800', color: COLORS.text },
  addBtn: { 
    width: 34, 
    height: 34, 
    borderRadius: RADIUS.sm, 
    alignItems: 'center', 
    justifyContent: 'center', 
    ...SHADOW.button,
  },

  searchWrap: {
    flexDirection: 'row', 
    alignItems: 'center', 
    gap: 8,
    marginHorizontal: 14, 
    marginBottom: 10,
    backgroundColor: 'rgba(9,178,238,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(9,178,238,0.18)',
    borderRadius: RADIUS.full,
    paddingHorizontal: 14, 
    paddingVertical: 10,
  },
  searchInput: { flex: 1, fontSize: 14, color: COLORS.text, padding: 0 },

  headerInfo: {
    marginBottom: 10,
    paddingHorizontal: 4,
  },
  headerInfoText: {
    fontSize: 12,
    color: COLORS.sub,
    fontWeight: '600',
  },

  listContent: { paddingHorizontal: 14, paddingBottom: 20 },

  // Glass card per contact with blue-tinted glassmorphism
  contactCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  contactMeta: { flex: 1 },
  contactName: { fontSize: 14, fontWeight: '700', color: COLORS.text },
  contactSub:  { fontSize: 12, color: COLORS.sub, marginTop: 3 },
  callBtn: { 
    width: 34, 
    height: 34, 
    borderRadius: RADIUS.sm, 
    alignItems: 'center', 
    justifyContent: 'center',
    shadowColor: '#09B2EE',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.40,
    shadowRadius: 12,
    elevation: 10,
  },
  callBtnDisabled: { 
    width: 34, 
    height: 34, 
    borderRadius: RADIUS.sm, 
    alignItems: 'center', 
    justifyContent: 'center',
    backgroundColor: 'rgba(9,178,238,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(9,178,238,0.15)',
  },

  centerWrap: { alignItems: 'center', paddingTop: 80, gap: 12, paddingHorizontal: 40 },
  centerText: { fontSize: 15, color: COLORS.sub, fontWeight: '600', textAlign: 'center' },
  errorText:  { fontSize: 13, color: COLORS.missed, textAlign: 'center' },
  hintText:   { fontSize: 13, color: COLORS.sub, textAlign: 'center' },

  emptyWrap: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyText: { fontSize: 15, color: COLORS.sub, fontWeight: '600' },

  callingOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.8)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  callingText: { fontSize: 16, color: '#fff', fontWeight: '600' },
});
