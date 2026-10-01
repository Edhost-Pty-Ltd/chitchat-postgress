// ─── ConversationStatusBadge ──────────────────────────────────────────────────
// Compact pill that shows the assignment status of a conversation.

import React, { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, RADIUS } from '../types/theme';
import { AppText } from '../context/ThemeContext';
import { ConversationStatus } from '../types';

interface ConversationStatusBadgeProps {
  status:         ConversationStatus;
  assignedToName: string | null;
  /** compact = small pill only, default = show label text */
  compact?:       boolean;
}

const STATUS_CONFIG: Record<ConversationStatus, {
  icon:  React.ComponentProps<typeof Ionicons>['name'];
  color: string;
  bg:    string;
  label: string;
}> = {
  open:     { icon: 'radio-button-on',   color: COLORS.amber,  bg: 'rgba(245,158,11,0.12)',  label: 'Open'       },
  assigned: { icon: 'person',            color: COLORS.blue,   bg: 'rgba(30,156,240,0.12)',  label: 'Assigned'   },
  resolved: { icon: 'checkmark-circle',  color: COLORS.green,  bg: 'rgba(34,197,94,0.12)',   label: 'Resolved'   },
};

export const ConversationStatusBadge = memo(function ConversationStatusBadge({
  status,
  assignedToName,
  compact = false,
}: ConversationStatusBadgeProps) {
  const cfg   = STATUS_CONFIG[status] ?? STATUS_CONFIG.open;
  const label = status === 'assigned' && assignedToName
    ? assignedToName
    : cfg.label;

  if (compact) {
    return (
      <View style={[styles.dot, { backgroundColor: cfg.color }]} />
    );
  }

  return (
    <View style={[styles.pill, { backgroundColor: cfg.bg }]}>
      <Ionicons name={cfg.icon} size={11} color={cfg.color} />
      <AppText style={[styles.pillText, { color: cfg.color }]} fixedColor numberOfLines={1}>
        {label}
      </AppText>
    </View>
  );
});

const styles = StyleSheet.create({
  pill: {
    flexDirection:  'row',
    alignItems:     'center',
    gap:            4,
    paddingHorizontal: 8,
    paddingVertical:   3,
    borderRadius:   RADIUS.full,
    alignSelf:      'flex-start',
    maxWidth:       130,
  },
  pillText: {
    fontSize:   11,
    fontWeight: '600',
    flexShrink: 1,
  },
  dot: {
    width:        8,
    height:       8,
    borderRadius: 4,
  },
});
