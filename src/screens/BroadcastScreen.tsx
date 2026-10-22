// ─── Screen: Broadcast Lists ──────────────────────────────────────────────────
//
// Three views live inside one screen, swapped with a local `view` state:
//
//   'list'    — shows all saved broadcast lists + "Create new" button
//   'create'  — pick a name + pick recipients (via ParticipantPickerSheet)
//   'compose' — type a message and send to a chosen list
//
// No navigation push needed — everything is self-contained so the user stays
// on the Chats tab without any stack transition.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useCallback, useRef } from 'react';
import {
  View, ScrollView, TouchableOpacity, TextInput, StyleSheet,
  ActivityIndicator, Alert, Platform, Modal,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '../hooks/useAuth';
import { useContacts } from '../hooks/useContacts';
import {
  useBroadcastLists,
  createBroadcastList,
  updateBroadcastRecipients,
  renameBroadcastList,
  deleteBroadcastList,
  recordBroadcastSend,
} from '../hooks/useBroadcastLists';
import { sendBroadcastMessage } from '../hooks/useChatActions';
import { ParticipantPickerSheet } from '../components/ParticipantPickerSheet';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { BroadcastList } from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────
type BroadcastView = 'list' | 'create' | 'compose' | 'edit';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function formatRelativeDate(date: Date | null): string {
  if (!date) return 'Never sent';
  const diff = Date.now() - date.getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  <  2) return 'Just now';
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days  <  7) return `${days}d ago`;
  return date.toLocaleDateString([], { day: '2-digit', month: 'short' });
}

// ─── BroadcastScreen (exported, used as the Broadcast tab body) ───────────────
export default function BroadcastScreen() {
  const { user }  = useAuth();
  const userId    = user?.uid ?? null;
  const insets    = useSafeAreaInsets();

  const { FG }                    = useForeground();
  const { fontFamily, textColor } = useTypography();
  const { bevel }                 = useGlass();

  const { lists, loading } = useBroadcastLists(userId);
  const { contacts }       = useContacts();

  // ── View state ──────────────────────────────────────────────────────────────
  const [view,         setView]         = useState<BroadcastView>('list');
  const [activeList,   setActiveList]   = useState<BroadcastList | null>(null);

  // ── Create / Edit state ─────────────────────────────────────────────────────
  const [listName,     setListName]     = useState('');
  const [nameError,    setNameError]    = useState('');
  const [pickerOpen,   setPickerOpen]   = useState(false);
  const [selected,     setSelected]     = useState<string[]>([]);
  const [saving,       setSaving]       = useState(false);

  // ── Compose state ───────────────────────────────────────────────────────────
  const [message,           setMessage]           = useState('');
  const [sending,           setSending]           = useState(false);
  const [progress,          setProgress]          = useState({ done: 0, total: 0 });
  const [composePickerOpen, setComposePickerOpen] = useState(false);
  const [savingRecipients,  setSavingRecipients]  = useState(false);
  const isSendingRef = useRef(false);

  // ── Delete state ────────────────────────────────────────────────────────────
  const [deletingId,   setDeletingId]   = useState<string | null>(null);

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const resetCreate = () => {
    setListName('');
    setNameError('');
    setSelected([]);
    setSaving(false);
  };

  const resetCompose = () => {
    setMessage('');
    setSending(false);
    setProgress({ done: 0, total: 0 });
    isSendingRef.current = false;
  };

  // Resolve UIDs → display names for the recipient count subtitle
  const resolveNames = useCallback((uids: string[]): string => {
    if (uids.length === 0) return 'No recipients';
    const names = uids
      .slice(0, 3)
      .map(uid => contacts.find(c => c.userId === uid)?.displayName ?? 'Contact');
    const extra = uids.length - names.length;
    return names.join(', ') + (extra > 0 ? ` +${extra} more` : '');
  }, [contacts]);

  // ── Create ──────────────────────────────────────────────────────────────────
  const handleCreate = async () => {
    if (!listName.trim()) { setNameError('Please enter a list name.'); return; }
    if (selected.length === 0) { setNameError('Select at least one contact.'); return; }
    if (!userId) return;

    setSaving(true);
    try {
      await createBroadcastList(userId, listName.trim(), selected);
      resetCreate();
      setView('list');
    } catch (err) {
      console.error('[BroadcastScreen] createBroadcastList:', err);
      setNameError('Failed to create list. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // ── Save edit ────────────────────────────────────────────────────────────────
  const handleSaveEdit = async () => {
    if (!activeList) return;
    if (!listName.trim()) { setNameError('Please enter a list name.'); return; }
    if (selected.length === 0) { setNameError('Select at least one contact.'); return; }

    setSaving(true);
    try {
      await renameBroadcastList(activeList.id, listName.trim());
      await updateBroadcastRecipients(activeList.id, selected);
      resetCreate();
      setView('list');
    } catch (err) {
      console.error('[BroadcastScreen] saveEdit:', err);
      setNameError('Failed to save changes. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // ── Delete ───────────────────────────────────────────────────────────────────
  const handleDelete = (list: BroadcastList) => {
    Alert.alert(
      `Delete "${list.name}"?`,
      'This will permanently remove the list. Messages already sent won\'t be affected.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeletingId(list.id);
            try {
              await deleteBroadcastList(list.id);
            } catch (err) {
              Alert.alert('Error', 'Failed to delete list.');
            } finally {
              setDeletingId(null);
            }
          },
        },
      ],
    );
  };

  // ── Update recipients from the compose view ──────────────────────────────────
  const handleUpdateComposeRecipients = async (ids: string[]) => {
    if (!activeList) return;
    if (ids.length === 0) {
      Alert.alert('No recipients', 'Select at least one contact.');
      return;
    }
    setSavingRecipients(true);
    try {
      await updateBroadcastRecipients(activeList.id, ids);
      // Patch activeList locally so the compose view reflects the change instantly
      // without waiting for the Firestore onSnapshot round-trip.
      setActiveList({ ...activeList, recipients: ids });
    } catch (err) {
      console.error('[BroadcastScreen] updateComposeRecipients:', err);
      Alert.alert('Error', 'Failed to update recipients. Please try again.');
    } finally {
      setSavingRecipients(false);
    }
  };

  // ── Send ──────────────────────────────────────────────────────────────────────
  const handleSend = async () => {
    if (isSendingRef.current || !activeList || !userId) return;
    if (!message.trim()) return;

    isSendingRef.current = true;
    setSending(true);
    setProgress({ done: 0, total: activeList.recipients.length });

    try {
      const { sent, failed } = await sendBroadcastMessage(
        userId,
        activeList.recipients,
        message.trim(),
        (done, total) => setProgress({ done, total }),
      );

      await recordBroadcastSend(activeList.id, message.trim());

      resetCompose();
      setView('list');

      const label = failed > 0
        ? `Sent to ${sent} contact${sent !== 1 ? 's' : ''}. ${failed} failed.`
        : `Sent to ${sent} contact${sent !== 1 ? 's' : ''}.`;

      Alert.alert('Broadcast sent', label);
    } catch (err) {
      console.error('[BroadcastScreen] sendBroadcast:', err);
      Alert.alert('Error', 'Failed to send broadcast. Please try again.');
      isSendingRef.current = false;
      setSending(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────

  // ── VIEW: list ───────────────────────────────────────────────────────────────
  if (view === 'list') {
    return (
      <View style={styles.root}>
        <AppBg />

        {/* Empty state */}
        {!loading && lists.length === 0 && (
          <View style={styles.emptyWrap}>
            <AppIcon name="megaphone-outline" size={56} color={COLORS.sub} />
            <AppText style={[styles.emptyTitle, { color: textColor, fontFamily }]}>
              No broadcast lists yet
            </AppText>
            <AppText style={[styles.emptyBody, { color: FG.secondary }]}>
              Create a list to send one message to multiple contacts at once. Each recipient gets it as a private message.
            </AppText>
          </View>
        )}

        {/* Loading */}
        {loading && (
          <View style={styles.emptyWrap}>
            <ActivityIndicator size="large" color={COLORS.blue} />
            <AppText style={[styles.emptyBody, { color: FG.secondary }]}>Loading…</AppText>
          </View>
        )}

        {/* List rows */}
        {!loading && lists.length > 0 && (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.listContent}
          >
            {lists.map((list) => (
              <View key={list.id} style={[styles.listCard, bevel]}>
                {/* Icon */}
                <View style={styles.listIconWrap}>
                  <LinearGradient colors={GRADIENTS.primary} style={styles.listIcon}>
                    <AppIcon name="megaphone" size={20} color="#fff" fixedColor />
                  </LinearGradient>
                </View>

                {/* Info */}
                <TouchableOpacity
                  style={styles.listInfo}
                  activeOpacity={0.75}
                  onPress={() => {
                    setActiveList(list);
                    setView('compose');
                  }}
                >
                  <AppText style={[styles.listName, { color: textColor, fontFamily }]} numberOfLines={1}>
                    {list.name}
                  </AppText>
                  <AppText style={[styles.listMeta, { color: FG.secondary }]} numberOfLines={1}>
                    {list.recipients.length} recipient{list.recipients.length !== 1 ? 's' : ''}
                    {'  ·  '}
                    {formatRelativeDate(list.lastSentAt)}
                  </AppText>
                  {list.lastMessage && (
                    <AppText style={[styles.listPreview, { color: FG.secondary }]} numberOfLines={1}>
                      {list.lastMessage}
                    </AppText>
                  )}
                </TouchableOpacity>

                {/* Actions */}
                <View style={styles.listActions}>
                  {/* Edit */}
                  <TouchableOpacity
                    onPress={() => {
                      setActiveList(list);
                      setListName(list.name);
                      setSelected(list.recipients);
                      setView('edit');
                    }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={styles.actionBtn}
                  >
                    <AppIcon name="create-outline" size={18} color={COLORS.blue} fixedColor />
                  </TouchableOpacity>

                  {/* Delete */}
                  {deletingId === list.id ? (
                    <ActivityIndicator size="small" color={COLORS.missed} style={styles.actionBtn} />
                  ) : (
                    <TouchableOpacity
                      onPress={() => handleDelete(list)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={styles.actionBtn}
                    >
                      <AppIcon name="trash-outline" size={18} color={COLORS.missed} fixedColor />
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            ))}
          </ScrollView>
        )}

        {/* Create FAB */}
        <TouchableOpacity
          style={[styles.fab, bevel, { bottom: 20 }]}
          activeOpacity={0.85}
          onPress={() => { resetCreate(); setView('create'); }}
        >
          <LinearGradient colors={GRADIENTS.primary} style={styles.fabGrad}>
            <AppIcon name="add" size={26} color="#fff" fixedColor />
          </LinearGradient>
        </TouchableOpacity>
      </View>
    );
  }

  // ── VIEW: create / edit ───────────────────────────────────────────────────────
  if (view === 'create' || view === 'edit') {
    const isEdit = view === 'edit';
    return (
      <View style={styles.root}>
        <AppBg />

        {/* Sub-header */}
        <View style={[styles.subHeader, { paddingTop: insets.top + 8 }]}>
          <TouchableOpacity
            onPress={() => { resetCreate(); setView('list'); }}
            style={styles.backBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            disabled={saving}
          >
            <AppIcon name="chevron-back" size={22} color={COLORS.blue} fixedColor />
          </TouchableOpacity>
          <AppText style={[styles.subHeaderTitle, { color: textColor, fontFamily }]}>
            {isEdit ? 'Edit List' : 'New Broadcast List'}
          </AppText>
          {/* Save / Create button */}
          <TouchableOpacity
            onPress={isEdit ? handleSaveEdit : handleCreate}
            activeOpacity={0.85}
            disabled={saving}
          >
            <LinearGradient colors={GRADIENTS.primary} style={styles.saveBtn}>
              {saving
                ? <ActivityIndicator size="small" color="#fff" />
                : <AppText fixedColor style={styles.saveBtnText}>{isEdit ? 'Save' : 'Create'}</AppText>
              }
            </LinearGradient>
          </TouchableOpacity>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.formContent}
        >
          {/* List name */}
          <AppText style={[styles.fieldLabel, { color: FG.secondary }]}>LIST NAME</AppText>
          <View style={[styles.inputCard, bevel]}>
            <AppIcon name="megaphone-outline" size={18} color={COLORS.sub} />
            <TextInput
              style={[styles.inputField, { color: textColor, fontFamily }]}
              placeholder="e.g. VIP Customers, Promotions…"
              placeholderTextColor={COLORS.textFaint}
              value={listName}
              onChangeText={(t) => { setListName(t); setNameError(''); }}
              returnKeyType="done"
              autoFocus={!isEdit}
            />
          </View>
          {nameError ? (
            <AppText style={styles.fieldError}>{nameError}</AppText>
          ) : null}

          {/* Recipients */}
          <AppText style={[styles.fieldLabel, { color: FG.secondary, marginTop: 20 }]}>
            RECIPIENTS ({selected.length})
          </AppText>

          <TouchableOpacity
            style={[styles.recipientsCard, bevel]}
            activeOpacity={0.8}
            onPress={() => setPickerOpen(true)}
          >
            <View style={styles.recipientsLeft}>
              <AppIcon name="people-outline" size={20} color={COLORS.blue} fixedColor />
              <View style={{ flex: 1 }}>
                <AppText style={[styles.recipientsTitle, { color: textColor, fontFamily }]}>
                  {selected.length === 0 ? 'Select contacts' : `${selected.length} contact${selected.length !== 1 ? 's' : ''} selected`}
                </AppText>
                {selected.length > 0 && (
                  <AppText style={[styles.recipientsSub, { color: FG.secondary }]} numberOfLines={1}>
                    {resolveNames(selected)}
                  </AppText>
                )}
              </View>
            </View>
            <AppIcon name="chevron-forward" size={16} color={COLORS.sub} />
          </TouchableOpacity>

          {/* Tip */}
          <View style={styles.tipCard}>
            <AppIcon name="information-circle-outline" size={16} color={COLORS.blue} fixedColor />
            <AppText style={[styles.tipText, { color: FG.secondary }]}>
              Each recipient receives your message as a private one-on-one message. They won't know others were included.
            </AppText>
          </View>
        </ScrollView>

        {/* Participant picker sheet — reusing the existing component */}
        <ParticipantPickerSheet
          visible={pickerOpen}
          selected={selected}
          title="Select Recipients"
          onConfirm={(ids) => { setSelected(ids); setNameError(''); }}
          onClose={() => setPickerOpen(false)}
        />
      </View>
    );
  }

  // ── VIEW: compose ─────────────────────────────────────────────────────────────
  if (view === 'compose' && activeList) {
    const canSend = message.trim().length > 0 && !sending;
    const progressPct = progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;

    return (
      <View style={styles.root}>
        <AppBg />

        {/* Sub-header */}
        <View style={[styles.subHeader, { paddingTop: insets.top + 8 }]}>
          <TouchableOpacity
            onPress={() => { resetCompose(); setView('list'); }}
            style={styles.backBtn}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            disabled={sending}
          >
            <AppIcon name="chevron-back" size={22} color={COLORS.blue} fixedColor />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <AppText style={[styles.subHeaderTitle, { color: textColor, fontFamily }]} numberOfLines={1}>
              {activeList.name}
            </AppText>
            <AppText style={[styles.subHeaderSub, { color: FG.secondary }]}>
              {activeList.recipients.length} recipient{activeList.recipients.length !== 1 ? 's' : ''}
            </AppText>
          </View>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.composeContent}
        >
          {/* Recipients — tappable, opens picker to edit inline */}
          <AppText style={[styles.fieldLabel, { color: FG.secondary }]}>RECIPIENTS</AppText>
          <TouchableOpacity
            style={[styles.recipientsCard, bevel]}
            activeOpacity={0.8}
            onPress={() => setComposePickerOpen(true)}
            disabled={sending || savingRecipients}
          >
            <View style={styles.recipientsLeft}>
              <AppIcon name="people" size={20} color={COLORS.blue} fixedColor />
              <View style={{ flex: 1 }}>
                <AppText style={[styles.recipientsTitle, { color: textColor, fontFamily }]}>
                  {activeList.recipients.length} recipient{activeList.recipients.length !== 1 ? 's' : ''}
                </AppText>
                <AppText style={[styles.recipientsSub, { color: FG.secondary }]} numberOfLines={1}>
                  {resolveNames(activeList.recipients)}
                </AppText>
              </View>
            </View>
            {savingRecipients
              ? <ActivityIndicator size="small" color={COLORS.blue} />
              : <AppIcon name="create-outline" size={18} color={COLORS.blue} fixedColor />
            }
          </TouchableOpacity>

          {/* Message input */}
          <AppText style={[styles.fieldLabel, { color: FG.secondary }]}>MESSAGE</AppText>
          <View style={[styles.messageCard, bevel]}>
            <TextInput
              style={[styles.messageInput, { color: textColor, fontFamily }]}
              placeholder="Type your announcement…"
              placeholderTextColor={COLORS.textFaint}
              value={message}
              onChangeText={setMessage}
              multiline
              numberOfLines={6}
              textAlignVertical="top"
              autoFocus
              maxLength={2000}
              editable={!sending}
            />
            <AppText style={[styles.charCount, { color: FG.secondary }]}>
              {message.length}/2000
            </AppText>
          </View>

          {/* Send progress bar */}
          {sending && (
            <View style={styles.progressWrap}>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${progressPct}%` as any }]} />
              </View>
              <AppText style={[styles.progressText, { color: FG.secondary }]}>
                Sending… {progress.done}/{progress.total}
              </AppText>
            </View>
          )}

          {/* Broadcast tip */}
          <View style={styles.tipCard}>
            <AppIcon name="shield-checkmark-outline" size={16} color={COLORS.blue} fixedColor />
            <AppText style={[styles.tipText, { color: FG.secondary }]}>
              Each contact receives this as a private message. No one sees who else received it.
            </AppText>
          </View>
        </ScrollView>

        {/* Send button */}
        <View style={[styles.sendBar, { paddingBottom: insets.bottom + 12 }]}>
          <TouchableOpacity
            onPress={handleSend}
            activeOpacity={canSend ? 0.85 : 1}
            disabled={!canSend}
            style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
          >
            <LinearGradient
              colors={canSend ? GRADIENTS.primary : ['#ccc', '#aaa']}
              style={styles.sendBtnGrad}
            >
              {sending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <AppIcon name="megaphone" size={18} color="#fff" fixedColor />
                  <AppText fixedColor style={styles.sendBtnText}>
                    Broadcast to {activeList.recipients.length} contact{activeList.recipients.length !== 1 ? 's' : ''}
                  </AppText>
                </>
              )}
            </LinearGradient>
          </TouchableOpacity>
        </View>

        {/* Participant picker — edit recipients without leaving the compose view */}
        <ParticipantPickerSheet
          visible={composePickerOpen}
          selected={activeList.recipients}
          title="Edit Recipients"
          onConfirm={(ids) => {
            setComposePickerOpen(false);
            handleUpdateComposeRecipients(ids);
          }}
          onClose={() => setComposePickerOpen(false)}
        />
      </View>
    );
  }

  return null;
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1 },

  // Empty / loading state
  emptyWrap: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 36, gap: 14,
  },
  emptyTitle: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  emptyBody:  { fontSize: 14, textAlign: 'center', lineHeight: 20 },

  // List
  listContent: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 120, gap: 10 },

  listCard: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: RADIUS.lg, padding: 14, gap: 12,
  },
  listIconWrap: {},
  listIcon: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    ...SHADOW.button,
  },
  listInfo:    { flex: 1, gap: 2 },
  listName:    { fontSize: 15, fontWeight: '700' },
  listMeta:    { fontSize: 12 },
  listPreview: { fontSize: 12, fontStyle: 'italic' },

  listActions: { flexDirection: 'row', gap: 4 },
  actionBtn:   { padding: 6 },

  // FAB
  fab: {
    position: 'absolute', right: 20,
    borderRadius: RADIUS.full, overflow: 'hidden',
    ...SHADOW.button,
  },
  fabGrad: {
    width: 56, height: 56, borderRadius: RADIUS.full,
    alignItems: 'center', justifyContent: 'center',
  },

  // Sub-header (create / compose)
  subHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingBottom: 12, gap: 12,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(9,178,238,0.10)',
  },
  subHeaderTitle: { flex: 1, fontSize: 17, fontWeight: '700' },
  subHeaderSub:   { fontSize: 12, marginTop: 1 },

  saveBtn: {
    paddingHorizontal: 18, paddingVertical: 9,
    borderRadius: RADIUS.full, minWidth: 70,
    alignItems: 'center', justifyContent: 'center',
    ...SHADOW.button,
  },
  saveBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },

  // Form (create / edit)
  formContent: { paddingHorizontal: 16, paddingBottom: 40 },

  fieldLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginBottom: 8, marginLeft: 2 },
  fieldError: { fontSize: 12, color: COLORS.missed, marginTop: 4, marginLeft: 2 },

  inputCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: RADIUS.md, paddingHorizontal: 14, paddingVertical: 14,
  },
  inputField: { flex: 1, fontSize: 15, padding: 0 },

  recipientsCard: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: RADIUS.md, paddingHorizontal: 14, paddingVertical: 14,
    gap: 12,
  },
  recipientsLeft:  { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  recipientsTitle: { fontSize: 15, fontWeight: '600' },
  recipientsSub:   { fontSize: 12, marginTop: 2 },

  tipCard: {
    flexDirection: 'row', alignItems: 'flex-start',
    gap: 8, marginTop: 16,
    padding: 12, borderRadius: RADIUS.md,
    backgroundColor: 'rgba(9,178,238,0.07)',
    borderWidth: 1, borderColor: 'rgba(9,178,238,0.15)',
  },
  tipText: { flex: 1, fontSize: 12, lineHeight: 17 },

  // Compose
  composeContent: { paddingHorizontal: 16, paddingBottom: 20, gap: 12 },

  messageCard: {
    borderRadius: RADIUS.md, padding: 14,
  },
  messageInput: {
    fontSize: 15, minHeight: 140, lineHeight: 22,
  },
  charCount: { fontSize: 11, textAlign: 'right', marginTop: 6 },

  progressWrap: { gap: 6 },
  progressTrack: {
    height: 4, borderRadius: 2,
    backgroundColor: 'rgba(0,0,0,0.08)', overflow: 'hidden',
  },
  progressFill: {
    height: '100%', borderRadius: 2,
    backgroundColor: COLORS.blue,
  },
  progressText: { fontSize: 12 },

  // Send bar
  sendBar: {
    paddingHorizontal: 16, paddingTop: 12,
    borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.06)',
    backgroundColor: 'rgba(255,255,255,0.6)',
  },
  sendBtn:         { borderRadius: RADIUS.md, overflow: 'hidden' },
  sendBtnDisabled: { opacity: 0.5 },
  sendBtnGrad: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 15, borderRadius: RADIUS.md,
    ...SHADOW.button,
  },
  sendBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
