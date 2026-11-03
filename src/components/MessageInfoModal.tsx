// ─── MessageInfoModal Component ──────────────────────────────────────────────
// Modal for displaying detailed message delivery and read receipt information

import React, { useEffect, useState } from 'react';
import {
  View,
  Modal,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { endpoints } from '../api/endpoints';
import { Avatar } from './index';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';
import { COLORS, RADIUS, SHADOW } from '../types/theme';
import { getDateLabel } from '../utils/dateUtils';

interface MessageInfo {
  userId: string;
  displayName: string;
  photoURL: string | null;
  status: 'delivered' | 'read';
  timestamp: Date;
}

interface MessageInfoModalProps {
  visible: boolean;
  onClose: () => void;
  messageTimestamp: Date | null;
  readBy: string[];
  currentUserId: string;
  isGroup: boolean;
}

export function MessageInfoModal({
  visible,
  onClose,
  messageTimestamp,
  readBy,
  currentUserId,
  isGroup,
}: MessageInfoModalProps) {
  const { FG } = useForeground();
  const { textColor, fontFamily } = useTypography();
  const { bevel } = useGlass();

  const [recipients, setRecipients] = useState<MessageInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const formatTime = (date: Date): string => {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatDate = (date: Date): string => {
    // Use the shared date utility for consistent date labeling
    const dateLabel = getDateLabel(date, 'long');
    
    // If it's not Today/Yesterday, use shorter format for modal
    if (dateLabel !== 'Today' && dateLabel !== 'Yesterday') {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    }
    
    return dateLabel;
  };

  const getInitials = (name: string): string => {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  };

  useEffect(() => {
    if (!visible || !isGroup || readBy.length === 0) return;

    const loadRecipientInfo = async () => {
      setLoading(true);
      try {
        const recipientsList: MessageInfo[] = [];

        for (const userId of readBy) {
          if (userId === currentUserId) continue;
          try {
            const res = await endpoints.getUser(userId);
            if (res.ok) {
              recipientsList.push({
                userId,
                displayName: res.data.displayName ?? res.data.phoneNumber ?? 'Unknown',
                photoURL: res.data.avatarObjectKey,
                status: 'read',
                timestamp: messageTimestamp || new Date(),
              });
            }
          } catch (error) {
            console.warn('[MessageInfoModal] Error fetching user:', userId, error);
          }
        }

        setRecipients(recipientsList);
      } catch (error) {
        console.error('[MessageInfoModal] Error loading recipients:', error);
      } finally {
        setLoading(false);
      }
    };

    loadRecipientInfo();
  }, [visible, isGroup, readBy, currentUserId, messageTimestamp]);

  const readCount = readBy.filter(id => id !== currentUserId).length;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={onClose}
        />
        <View style={[styles.modalContent, { backgroundColor: FG.glassBg }]}>
          <AppBg />

          {/* Handle */}
          <View style={styles.handle} />

          {/* Header */}
          <View style={styles.header}>
            <AppText style={[styles.title, { color: textColor, fontFamily }]}>
              Message Info
            </AppText>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <AppIcon name="close" size={24} color={FG.secondary} />
            </TouchableOpacity>
          </View>

          {/* Delivered Info */}
          <View style={[styles.infoSection, bevel]}>
            <View style={styles.infoRow}>
              <AppIcon name="checkmark-circle" size={20} color={COLORS.blue} />
              <View style={styles.infoContent}>
                <AppText style={[styles.infoLabel, { color: FG.secondary }]}>
                  Delivered
                </AppText>
                <AppText style={[styles.infoValue, { color: textColor, fontFamily }]}>
                  {messageTimestamp
                    ? `${formatDate(messageTimestamp)} at ${formatTime(messageTimestamp)}`
                    : 'Unknown'}
                </AppText>
              </View>
            </View>
          </View>

          {/* Read Receipts */}
          {!isGroup ? (
            <View style={[styles.infoSection, bevel]}>
              <View style={styles.infoRow}>
                <AppIcon
                  name={readCount > 0 ? 'checkmark-done-circle' : 'time-outline'}
                  size={20}
                  color={readCount > 0 ? COLORS.blue : FG.secondary}
                />
                <View style={styles.infoContent}>
                  <AppText style={[styles.infoLabel, { color: FG.secondary }]}>
                    {readCount > 0 ? 'Read' : 'Not read yet'}
                  </AppText>
                  {readCount > 0 && messageTimestamp && (
                    <AppText style={[styles.infoValue, { color: textColor, fontFamily }]}>
                      {`${formatDate(messageTimestamp)} at ${formatTime(messageTimestamp)}`}
                      <AppText style={[styles.approximateNote, { color: FG.secondary }]}>
                        {' '}(approximate)
                      </AppText>
                    </AppText>
                  )}
                </View>
              </View>
            </View>
          ) : (
            <>
              {/* Group Read Count */}
              <View style={[styles.readHeader, { borderBottomColor: FG.glassBorder }]}>
                <AppIcon name="checkmark-done-circle" size={18} color={COLORS.blue} />
                <AppText style={[styles.readHeaderText, { color: textColor, fontFamily }]}>
                  Read by {readCount} {readCount === 1 ? 'person' : 'people'}
                </AppText>
              </View>

              {/* Recipients List */}
              {loading ? (
                <View style={styles.loadingContainer}>
                  <ActivityIndicator size="small" color={COLORS.blue} />
                  <AppText style={[styles.loadingText, { color: FG.secondary }]}>
                    Loading recipients...
                  </AppText>
                </View>
              ) : recipients.length > 0 ? (
                <ScrollView
                  style={styles.recipientsList}
                  showsVerticalScrollIndicator={false}
                >
                  {recipients.map((recipient) => (
                    <View key={recipient.userId} style={[styles.recipientItem, bevel]}>
                      <Avatar
                        initials={getInitials(recipient.displayName)}
                        color={COLORS.blue}
                        size={40}
                        imageUrl={recipient.photoURL}
                      />
                      <View style={styles.recipientInfo}>
                        <AppText style={[styles.recipientName, { color: textColor, fontFamily }]}>
                          {recipient.displayName}
                        </AppText>
                        <AppText style={[styles.recipientTime, { color: FG.secondary }]}>
                          {`${formatDate(recipient.timestamp)} at ${formatTime(recipient.timestamp)}`}
                          <AppText style={{ fontSize: 11 }}> (approx.)</AppText>
                        </AppText>
                      </View>
                      <AppIcon name="checkmark-done" size={16} color={COLORS.blue} />
                    </View>
                  ))}
                </ScrollView>
              ) : (
                <View style={styles.emptyContainer}>
                  <AppIcon name="eye-off-outline" size={32} color={FG.secondary} />
                  <AppText style={[styles.emptyText, { color: FG.secondary }]}>
                    Not read yet
                  </AppText>
                </View>
              )}

              {/* Note about timestamps */}
              <View style={styles.noteContainer}>
                <AppText style={[styles.noteText, { color: FG.secondary }]}>
                  Note: Individual read times are currently approximate. Precise read timestamps
                  will be available in a future update.
                </AppText>
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
  },
  modalContent: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '75%',
    paddingBottom: 20,
    ...SHADOW.glow,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(9,178,238,0.40)',
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(9,178,238,0.15)',
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
  },
  closeBtn: {
    padding: 4,
  },
  infoSection: {
    marginHorizontal: 16,
    marginTop: 12,
    padding: 14,
    borderRadius: RADIUS.lg,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  infoContent: {
    flex: 1,
    gap: 4,
  },
  infoLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  infoValue: {
    fontSize: 15,
  },
  approximateNote: {
    fontSize: 13,
    fontStyle: 'italic',
  },
  readHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    marginTop: 8,
    borderBottomWidth: 1,
  },
  readHeaderText: {
    fontSize: 14,
    fontWeight: '600',
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    gap: 12,
  },
  loadingText: {
    fontSize: 13,
  },
  recipientsList: {
    maxHeight: 300,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  recipientItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderRadius: RADIUS.lg,
    gap: 12,
    marginBottom: 8,
  },
  recipientInfo: {
    flex: 1,
    gap: 2,
  },
  recipientName: {
    fontSize: 14,
    fontWeight: '600',
  },
  recipientTime: {
    fontSize: 12,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    gap: 8,
  },
  emptyText: {
    fontSize: 13,
  },
  noteContainer: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    marginTop: 8,
  },
  noteText: {
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    fontStyle: 'italic',
  },
});
