// ─── AssignmentSheet ─────────────────────────────────────────────────────────
// Modal bottom sheet for assigning / transferring / resolving / reopening a
// conversation. Surfaces the available actions based on the current status and
// the acting user's role.

import React, { useState, useCallback, memo } from 'react';
import {
  View, Modal, TouchableOpacity, FlatList,
  StyleSheet, ActivityIndicator, Image,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, RADIUS, SHADOW, GRADIENTS, GLASS } from '../types/theme';
import { AppText, AppIcon, useForeground, useGlass } from '../context/ThemeContext';
import { TeamAgent, ConversationStatus } from '../types';
import {
  assignConversation,
  takeConversation,
  resolveConversation,
  reopenConversation,
} from '../hooks/useTeamInbox';

interface AssignmentSheetProps {
  visible:        boolean;
  onClose:        () => void;
  chatId:         string;
  currentStatus:  ConversationStatus;
  assignedTo:     string | null;
  assignedToName: string | null;
  agents:         TeamAgent[];
  actorUid:       string;
  actorName:      string;
  isAdmin:        boolean;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function stringToColor(str: string): string {
  const colors = ['#f97316', '#8b5cf6', '#ec4899', '#06b6d4', '#10b981', '#f59e0b', '#6366f1', '#e11d48'];
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export const AssignmentSheet = memo(function AssignmentSheet({
  visible,
  onClose,
  chatId,
  currentStatus,
  assignedTo,
  assignedToName,
  agents,
  actorUid,
  actorName,
  isAdmin,
}: AssignmentSheetProps) {
  const { FG }   = useForeground();
  const { bevel } = useGlass();
  const [loading, setLoading]       = useState(false);
  const [error,   setError]         = useState<string | null>(null);
  const [view,    setView]          = useState<'actions' | 'pickAgent'>('actions');

  const actor = { uid: actorUid, name: actorName };

  const reset = useCallback(() => {
    setView('actions');
    setError(null);
    setLoading(false);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const doAssign = useCallback(async (agent: TeamAgent) => {
    setLoading(true);
    setError(null);
    try {
      await assignConversation(chatId, actor, { uid: agent.uid, name: agent.displayName }, assignedTo);
      handleClose();
    } catch {
      setError('Failed to assign conversation. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [chatId, actor, assignedTo, handleClose]);

  const doTake = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await takeConversation(chatId, actor, assignedTo);
      handleClose();
    } catch {
      setError('Failed to take conversation. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [chatId, actor, assignedTo, handleClose]);

  const doResolve = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await resolveConversation(chatId, actor);
      handleClose();
    } catch {
      setError('Failed to resolve conversation. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [chatId, actor, handleClose]);

  const doReopen = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await reopenConversation(chatId, actor);
      handleClose();
    } catch {
      setError('Failed to reopen conversation. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [chatId, actor, handleClose]);

  const isMyConversation = assignedTo === actorUid;

  // ── Agent picker ──────────────────────────────────────────────────────────
  if (view === 'pickAgent') {
    const pickableAgents = agents.filter((a) => a.uid !== actorUid || isAdmin);

    return (
      <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={handleClose} />
        <View style={[styles.sheet, { backgroundColor: FG.glassBg || 'rgba(255,255,255,0.97)' }]}>
          {/* Header */}
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <TouchableOpacity onPress={() => setView('actions')} style={styles.backBtn}>
              <AppIcon name="chevron-back" size={22} color={COLORS.blue} fixedColor />
            </TouchableOpacity>
            <AppText style={styles.sheetTitle}>
              {assignedTo ? 'Transfer to' : 'Assign to'}
            </AppText>
            <View style={{ width: 36 }} />
          </View>

          {pickableAgents.length === 0 ? (
            <View style={styles.emptyAgents}>
              <AppIcon name="people-outline" size={40} color={COLORS.sub} />
              <AppText style={styles.emptyText}>No agents available</AppText>
            </View>
          ) : (
            <FlatList
              data={pickableAgents}
              keyExtractor={(a) => a.uid}
              contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
              ItemSeparatorComponent={() => <View style={styles.separator} />}
              renderItem={({ item: agent }) => {
                const isCurrentlyAssigned = agent.uid === assignedTo;
                const color = stringToColor(agent.displayName);
                return (
                  <TouchableOpacity
                    style={[styles.agentRow, bevel, isCurrentlyAssigned && styles.agentRowActive]}
                    activeOpacity={0.75}
                    disabled={loading || isCurrentlyAssigned}
                    onPress={() => doAssign(agent)}
                  >
                    <View style={[styles.agentAvatar, { backgroundColor: color }]}>
                      {agent.photoURL ? (
                        <Image source={{ uri: agent.photoURL }} style={styles.agentAvatarImg} />
                      ) : (
                        <AppText style={styles.agentAvatarText} fixedColor>
                          {getInitials(agent.displayName)}
                        </AppText>
                      )}
                    </View>
                    <View style={{ flex: 1 }}>
                      <AppText style={styles.agentName}>{agent.displayName}</AppText>
                      <AppText style={styles.agentRole}>
                        {agent.role === 'admin' ? 'Admin' : 'Agent'}{isCurrentlyAssigned ? ' · Currently assigned' : ''}
                      </AppText>
                    </View>
                    {isCurrentlyAssigned && (
                      <Ionicons name="checkmark-circle" size={20} color={COLORS.blue} />
                    )}
                    {loading && !isCurrentlyAssigned && (
                      <ActivityIndicator size="small" color={COLORS.blue} />
                    )}
                  </TouchableOpacity>
                );
              }}
            />
          )}
        </View>
      </Modal>
    );
  }

  // ── Action list ───────────────────────────────────────────────────────────
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={handleClose} />
      <View style={[styles.sheet, { backgroundColor: FG.glassBg || 'rgba(255,255,255,0.97)' }]}>
        {/* Drag handle */}
        <View style={styles.sheetHandle} />

        {/* Header */}
        <View style={styles.sheetHeader}>
          <View style={{ width: 36 }} />
          <AppText style={styles.sheetTitle}>Conversation</AppText>
          <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
            <AppIcon name="close" size={20} color={COLORS.sub} />
          </TouchableOpacity>
        </View>

        {/* Current assignment info */}
        <View style={[styles.statusCard, bevel]}>
          <View style={styles.statusRow}>
            <Ionicons
              name={
                currentStatus === 'resolved' ? 'checkmark-circle' :
                currentStatus === 'assigned' ? 'person-circle'    : 'radio-button-on'
              }
              size={18}
              color={
                currentStatus === 'resolved' ? COLORS.green :
                currentStatus === 'assigned' ? COLORS.blue  : COLORS.amber
              }
            />
            <AppText style={styles.statusLabel}>
              {currentStatus === 'resolved'
                ? 'Resolved'
                : currentStatus === 'assigned'
                ? `Assigned to ${assignedToName ?? 'an agent'}`
                : 'Unassigned'}
            </AppText>
          </View>
        </View>

        {/* Error */}
        {error && (
          <View style={styles.errorBanner}>
            <AppText style={styles.errorText} fixedColor>{error}</AppText>
          </View>
        )}

        {/* Actions */}
        <View style={styles.actionList}>
          {/* Assign / Transfer — admin or unassigned owner */}
          {currentStatus !== 'resolved' && isAdmin && (
            <ActionRow
              icon="person-add-outline"
              label={assignedTo ? 'Transfer to another agent' : 'Assign to agent'}
              onPress={() => setView('pickAgent')}
              loading={false}
              bevel={bevel}
            />
          )}

          {/* Take over — for agents and for admins who aren't the assignee */}
          {currentStatus !== 'resolved' && !isMyConversation && (
            <ActionRow
              icon="hand-left-outline"
              label="Take this conversation"
              sublabel={assignedTo ? `Currently with ${assignedToName}` : undefined}
              onPress={doTake}
              loading={loading}
              bevel={bevel}
            />
          )}

          {/* Resolve — anyone assigned to it, or an admin */}
          {currentStatus !== 'resolved' && (isAdmin || isMyConversation) && (
            <ActionRow
              icon="checkmark-circle-outline"
              label="Mark as resolved"
              color={COLORS.green}
              onPress={doResolve}
              loading={loading}
              bevel={bevel}
            />
          )}

          {/* Reopen — resolved conversations */}
          {currentStatus === 'resolved' && isAdmin && (
            <ActionRow
              icon="refresh-circle-outline"
              label="Reopen conversation"
              onPress={doReopen}
              loading={loading}
              bevel={bevel}
            />
          )}
        </View>
      </View>
    </Modal>
  );
});

// ─── ActionRow ────────────────────────────────────────────────────────────────
interface ActionRowProps {
  icon:      React.ComponentProps<typeof Ionicons>['name'];
  label:     string;
  sublabel?: string;
  color?:    string;
  onPress:   () => void;
  loading:   boolean;
  bevel:     object;
}

const ActionRow = memo(function ActionRow({
  icon, label, sublabel, color = COLORS.blue, onPress, loading, bevel,
}: ActionRowProps) {
  return (
    <TouchableOpacity
      style={[styles.actionRow, bevel]}
      activeOpacity={0.75}
      onPress={onPress}
      disabled={loading}
    >
      <View style={[styles.actionIcon, { backgroundColor: `${color}18` }]}>
        <Ionicons name={icon} size={20} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <AppText style={[styles.actionLabel, { color }]}>{label}</AppText>
        {sublabel && <AppText style={styles.actionSublabel}>{sublabel}</AppText>}
      </View>
      {loading
        ? <ActivityIndicator size="small" color={color} />
        : <Ionicons name="chevron-forward" size={16} color={COLORS.sub} />}
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheet: {
    position:     'absolute',
    bottom:       0,
    left:         0,
    right:        0,
    borderTopLeftRadius:  24,
    borderTopRightRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.97)',
    paddingBottom:   40,
    ...SHADOW.card,
  },
  sheetHandle: {
    width: 36, height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.border,
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 4,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems:    'center',
    paddingHorizontal: 16,
    paddingVertical:   12,
  },
  sheetTitle: {
    flex: 1, textAlign: 'center',
    fontSize: 16, fontWeight: '700',
    color: COLORS.text,
  },
  backBtn:  { width: 36, alignItems: 'flex-start' },
  closeBtn: { width: 36, alignItems: 'flex-end' },

  statusCard: {
    marginHorizontal: 16,
    marginBottom:     12,
    borderRadius:     RADIUS.md,
    paddingHorizontal: 14,
    paddingVertical:   10,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           8,
  },
  statusLabel: {
    fontSize: 14, fontWeight: '500',
    color: COLORS.text,
  },

  errorBanner: {
    marginHorizontal: 16,
    marginBottom:     10,
    backgroundColor: 'rgba(232,67,67,0.10)',
    borderRadius:    RADIUS.sm,
    padding:         10,
  },
  errorText: { fontSize: 13, color: COLORS.missed },

  actionList: { paddingHorizontal: 16, gap: 8 },
  actionRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           12,
    borderRadius:  RADIUS.md,
    paddingHorizontal: 14,
    paddingVertical:   13,
  },
  actionIcon: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
  },
  actionLabel:   { fontSize: 15, fontWeight: '600', color: COLORS.text },
  actionSublabel:{ fontSize: 12, color: COLORS.sub, marginTop: 1 },

  // Agent picker styles
  agentRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           12,
    borderRadius:  RADIUS.md,
    paddingHorizontal: 14,
    paddingVertical:   12,
    marginVertical:    4,
  },
  agentRowActive: { opacity: 0.6 },
  agentAvatar: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  agentAvatarImg: { width: 40, height: 40, borderRadius: 20 },
  agentAvatarText: { fontSize: 14, fontWeight: '700', color: '#fff' },
  agentName: { fontSize: 15, fontWeight: '600', color: COLORS.text },
  agentRole: { fontSize: 12, color: COLORS.sub, marginTop: 1 },

  separator: { height: 0 },
  emptyAgents: {
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: 48, gap: 12,
  },
  emptyText: { fontSize: 14, color: COLORS.sub },
});
