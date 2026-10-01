// ─── Screen: Linked Devices & Team ───────────────────────────────────────────
//
// Devices tab — real Firestore-backed linked devices, QR scanning, code entry,
// and remote sign-out.
//
// COMPANION NOTE
//   On a companion device the entire Devices tab is read-only. Every action
//   (link, remove, remove all) is disabled and greyed out. The user sees a
//   notice at the top explaining that device management happens on the
//   primary phone.
//
import React, {
  useState, useCallback, useMemo, useEffect, memo,
} from 'react';
import {
  View, TouchableOpacity, StyleSheet, ScrollView, Modal, Platform,
  FlatList, TextInput, ActivityIndicator, Alert, Image,
  KeyboardAvoidingView, Dimensions,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { LinearGradient }   from 'expo-linear-gradient';
import { Ionicons }         from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import firestore             from '@react-native-firebase/firestore';

let CameraView: any = null;
let useCameraPermissions: any = () => [{ status: 'undetermined' }, async () => ({ status: 'granted' })];
if (Platform.OS !== 'web') {
  try {
    const cam = require('expo-camera');
    CameraView = cam.CameraView;
    useCameraPermissions = cam.useCameraPermissions;
  } catch {}
}

import {
  AppBg, AppText, AppIcon, useForeground, useTypography, useGlass,
} from '../context/ThemeContext';
import { useAuth }      from '../context/AuthContext';
import { useTeamInbox } from '../context/TeamInboxContext';
import { useInboxConversations } from '../hooks/useTeamInbox';
import { addAgent, removeAgent, updateAgentRole } from '../hooks/useTeamAgents';
import {
  useLinkedDevices,
  claimLinkRequest,
  findRequestByDisplayCode,
  removeDevice,
  removeAllOtherDevices,
  LinkedDevice,
} from '../hooks/useLinkedDevices';
import { ConversationStatusBadge } from '../components/ConversationStatusBadge';
import { AssignmentSheet }          from '../components/AssignmentSheet';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { TeamAgent, AgentRole, InboxConversation } from '../types';
import { db } from '../config/firebase';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];
type ScreenTab   = 'devices' | 'team';
type InboxTab    = 'all' | 'mine' | 'unassigned' | 'resolved';

const DEVICE_ICON: Record<LinkedDevice['type'], IoniconName> = {
  phone:   'phone-portrait-outline',
  tablet:  'tablet-portrait-outline',
  desktop: 'desktop-outline',
  web:     'globe-outline',
};

const LINK_QR_PATTERN = /^chitchat:\/\/link\/([0-9a-f]{64})$/i;

function getInitials(name: string): string {
  const p = name.trim().split(/\s+/);
  return p.length >= 2 ? (p[0][0] + p[1][0]).toUpperCase() : name.slice(0, 2).toUpperCase();
}

function stringToColor(s: string): string {
  const pal = ['#f97316','#8b5cf6','#ec4899','#06b6d4','#10b981','#f59e0b','#6366f1','#e11d48'];
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return pal[Math.abs(h) % pal.length];
}

function formatTime(d: Date | null): string {
  if (!d) return '';
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7)  return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: '2-digit', month: 'short' });
}

function formatRelative(d: Date): string {
  const m = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const dy = Math.floor(h / 24);
  if (dy === 1) return 'yesterday';
  if (dy < 7)  return `${dy}d ago`;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

const memberCache = new Map<string, { displayName: string; photoURL: string | null }>();
async function fetchMemberInfo(uid: string) {
  if (memberCache.has(uid)) return memberCache.get(uid)!;
  try {
    const snap = await (db as ReturnType<typeof firestore>).collection('users').doc(uid).get();
    const info = snap.exists()
      ? { displayName: snap.data()!.displayName ?? uid, photoURL: snap.data()!.photoURL ?? null }
      : { displayName: uid, photoURL: null };
    memberCache.set(uid, info);
    return info;
  } catch { return { displayName: uid, photoURL: null }; }
}

// ─── DeviceCard — supports a `readOnly` variant for companions ───────────────
interface DeviceCardProps {
  device: LinkedDevice;
  FG: any;
  textColor: string;
  fontFamily: string;
  readOnly?: boolean;
  onRemove?: () => void;
}
function DeviceCard({ device, FG, textColor, fontFamily, readOnly, onRemove }: DeviceCardProps) {
  const { bevel } = useGlass();
  return (
    <View style={[S.card, bevel, readOnly && S.cardReadOnly]}>
      <View style={[S.deviceIconWrap, readOnly && S.iconWrapReadOnly]}>
        <AppIcon
          name={DEVICE_ICON[device.type]}
          size={22}
          color={readOnly ? COLORS.sub : COLORS.blue}
          fixedColor
        />
      </View>
      <View style={S.deviceInfo}>
        <View style={S.deviceNameRow}>
          <AppText style={[S.deviceName, { color: readOnly ? COLORS.sub : textColor, fontFamily }]} numberOfLines={1}>
            {device.name}
          </AppText>
          {device.isCurrent && (
            <LinearGradient colors={GRADIENTS.primary} style={S.currentBadge}>
              <AppText fixedColor style={S.currentBadgeTxt}>This device</AppText>
            </LinearGradient>
          )}
        </View>
        <AppText style={[S.deviceMeta, { color: FG.secondary }]}>{device.os}</AppText>
        <View style={S.deviceDetailRow}>
          <AppIcon name="time-outline" size={12} color={FG.secondary} />
          <AppText style={[S.deviceDetail, { color: FG.secondary }]}>
            Linked {device.linkedAt.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}
          </AppText>
        </View>
        <View style={S.deviceDetailRow}>
          <AppIcon name="radio-outline" size={12} color={FG.secondary} />
          <AppText style={[S.deviceDetail, { color: FG.secondary }]}>
            Last active {formatRelative(device.lastActiveAt)}
          </AppText>
        </View>
      </View>
      {!device.isCurrent && onRemove && !readOnly && (
        <TouchableOpacity onPress={onRemove} style={S.logoutBtn} activeOpacity={0.8}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <AppIcon name="log-out-outline" size={20} color={COLORS.missed} fixedColor />
        </TouchableOpacity>
      )}
      {!device.isCurrent && readOnly && (
        <View style={S.logoutBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <AppIcon name="lock-closed-outline" size={18} color={COLORS.sub} />
        </View>
      )}
    </View>
  );
}

// ─── AgentCard ────────────────────────────────────────────────────────────────
interface AgentCardProps {
  agent: TeamAgent; isAdmin: boolean; ownerUid: string;
  onRemove: (a: TeamAgent) => void;
  onRoleChange: (a: TeamAgent, r: AgentRole) => void;
  textColor: string; fontFamily: string;
  readOnly?: boolean;
}
const AgentCard = memo(function AgentCard({
  agent, isAdmin, ownerUid, onRemove, onRoleChange, textColor, fontFamily, readOnly,
}: AgentCardProps) {
  const { bevel } = useGlass();
  const color = stringToColor(agent.displayName);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <View style={[S.card, bevel, readOnly && S.cardReadOnly]}>
      <View style={[S.agentAvatar, { backgroundColor: readOnly ? COLORS.sub : color }]}>
        {agent.photoURL
          ? <Image source={{ uri: agent.photoURL }} style={S.agentAvatarImg} />
          : <AppText style={S.agentAvatarTxt} fixedColor>{getInitials(agent.displayName)}</AppText>}
      </View>
      <View style={S.deviceInfo}>
        <View style={S.deviceNameRow}>
          <AppText style={[S.deviceName, { color: readOnly ? COLORS.sub : textColor, fontFamily }]} numberOfLines={1}>
            {agent.displayName}
          </AppText>
          <View style={[S.rolePill, agent.role === 'admin' ? S.roleAdmin : S.roleAgent]}>
            <AppText style={[S.roleTxt, agent.role === 'admin' ? S.roleTxtAdmin : S.roleTxtAgent]} fixedColor>
              {agent.role === 'admin' ? 'Admin' : 'Agent'}
            </AppText>
          </View>
        </View>
        <AppText style={[S.deviceMeta, { color: COLORS.sub }]}>{agent.phone}</AppText>
        <View style={S.deviceDetailRow}>
          <AppIcon name="time-outline" size={12} color={COLORS.sub} />
          <AppText style={[S.deviceDetail, { color: COLORS.sub }]}>
            Linked {agent.addedAt.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}
          </AppText>
        </View>
      </View>
      {isAdmin && agent.uid !== ownerUid && !readOnly && (
        <TouchableOpacity onPress={() => setMenuOpen(true)} style={S.logoutBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <AppIcon name="ellipsis-vertical" size={20} color={COLORS.sub} />
        </TouchableOpacity>
      )}
      {readOnly && isAdmin && agent.uid !== ownerUid && (
        <View style={S.logoutBtn}>
          <AppIcon name="lock-closed-outline" size={16} color={COLORS.sub} />
        </View>
      )}
      {menuOpen && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
          <TouchableOpacity style={S.menuBackdrop} activeOpacity={1} onPress={() => setMenuOpen(false)} />
          <View style={[S.agentMenuCard, bevel]}>
            <AppText style={S.agentMenuName} numberOfLines={1}>{agent.displayName}</AppText>
            <View style={S.agentMenuDivider} />
            <TouchableOpacity style={S.agentMenuItem} onPress={() => { setMenuOpen(false); onRoleChange(agent, agent.role === 'admin' ? 'agent' : 'admin'); }}>
              <View style={S.agentMenuIcon}><Ionicons name={agent.role === 'admin' ? 'person-outline' : 'shield-outline'} size={18} color={COLORS.blue} /></View>
              <AppText style={S.agentMenuLabel}>{agent.role === 'admin' ? 'Demote to Agent' : 'Promote to Admin'}</AppText>
            </TouchableOpacity>
            <TouchableOpacity style={S.agentMenuItem} onPress={() => { setMenuOpen(false); onRemove(agent); }}>
              <View style={[S.agentMenuIcon, S.agentMenuIconDanger]}><Ionicons name="person-remove-outline" size={18} color={COLORS.missed} /></View>
              <AppText style={[S.agentMenuLabel, { color: COLORS.missed }]}>Unlink account</AppText>
            </TouchableOpacity>
          </View>
        </Modal>
      )}
    </View>
  );
});

// ─── InboxRow ─────────────────────────────────────────────────────────────────
interface InboxRowProps {
  item: InboxConversation; ownerUid: string; onPress: () => void;
  bevel: object; textColor: string; fontFamily: string;
}
const InboxRow = memo(function InboxRow({ item, ownerUid, onPress, bevel, textColor, fontFamily }: InboxRowProps) {
  const [info, setInfo] = useState<{ displayName: string; photoURL: string | null } | null>(null);
  React.useEffect(() => {
    if (item.type === 'direct') {
      const other = item.members.find((m) => m !== ownerUid);
      if (other) fetchMemberInfo(other).then(setInfo);
    }
  }, [item.members, item.type, ownerUid]);
  const name = item.type === 'group' ? (item.groupName || 'Group') : (info?.displayName ?? '…');
  const photoURL = item.type === 'direct' ? info?.photoURL ?? null : null;
  const color = stringToColor(name);
  return (
    <TouchableOpacity style={[S.inboxRow, bevel]} activeOpacity={0.76} onPress={onPress}>
      <View style={[S.inboxAvatar, { backgroundColor: color }]}>
        {photoURL ? <Image source={{ uri: photoURL }} style={S.inboxAvatarImg} />
          : item.type === 'group' ? <Ionicons name="people" size={18} color="#fff" />
          : <AppText style={S.inboxAvatarTxt} fixedColor>{getInitials(name)}</AppText>}
      </View>
      <View style={{ flex: 1 }}>
        <View style={S.inboxTop}>
          <AppText style={[S.inboxName, { color: textColor, fontFamily }]} numberOfLines={1}>{name}</AppText>
          <AppText style={S.inboxTime}>{formatTime(item.timestamp)}</AppText>
        </View>
        <View style={S.inboxBottom}>
          <AppText style={S.inboxPreview} numberOfLines={1}>{item.lastMessage || 'No messages'}</AppText>
          {item.unreadCount > 0 && (
            <View style={S.inboxBadge}><AppText style={S.inboxBadgeTxt} fixedColor>{item.unreadCount > 99 ? '99+' : item.unreadCount}</AppText></View>
          )}
        </View>
        <View style={{ marginTop: 4 }}>
          <ConversationStatusBadge status={item.status} assignedToName={item.assignedToName} />
        </View>
      </View>
    </TouchableOpacity>
  );
});

const INBOX_TABS: { id: InboxTab; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'mine', label: 'Mine' },
  { id: 'unassigned', label: 'Unassigned' }, { id: 'resolved', label: 'Resolved' },
];

export default function LinkedDevicesScreen() {
  const navigation = useNavigation();
  const insets     = useSafeAreaInsets();
  const { FG }     = useForeground();
  const { fontFamily, textColor } = useTypography();
  const { bevel }  = useGlass();

  const { userId, ownerUid, isCompanion, displayName: myDisplayName } = useAuth();
  const { isAdmin, isOwner, agents, agentsLoading } = useTeamInbox();

  const [screenTab, setScreenTab] = useState<ScreenTab>('devices');

  // Companion sees the list but can't act on it. Pass ownerUid so the list
  // loads — but every interactive element will be disabled.
  const devicesOwnerUid = ownerUid;   // both primary and companion read the list
  const { devices, loading: devicesLoading, myDeviceId } = useLinkedDevices(devicesOwnerUid);
  const currentDevice = devices.find((d) => d.isCurrent);
  const otherDevices  = devices.filter((d) => !d.isCurrent);

  const [pendingDev, setPendingDev] = useState<LinkedDevice | 'all' | null>(null);
  const [removing,   setRemoving]   = useState(false);

  const doRemoveDev = useCallback(async () => {
    if (!ownerUid || !pendingDev) return;
    setRemoving(true);
    try {
      if (pendingDev === 'all') {
        if (myDeviceId) await removeAllOtherDevices(ownerUid, myDeviceId);
      } else {
        await removeDevice(ownerUid, (pendingDev as LinkedDevice).id);
      }
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Failed to remove device.');
    } finally {
      setRemoving(false);
      setPendingDev(null);
    }
  }, [ownerUid, pendingDev, myDeviceId]);

  // ── Companion guard ──────────────────────────────────────────────────────
  const noAuthority = useCallback((action = 'do that') => {
    Alert.alert(
      'Not available on this device',
      `You don't have authority to ${action} from a companion device. Please use the primary phone.`,
    );
  }, []);

  // ── Link device ──────────────────────────────────────────────────────────
  type LinkMode = 'choose' | 'scan' | 'enter-code' | null;
  const [linkMode,   setLinkMode]   = useState<LinkMode>(null);
  const [codeInput,  setCodeInput]  = useState('');
  const [linking,    setLinking]    = useState(false);
  const [linkError,  setLinkError]  = useState<string | null>(null);
  const [linkDone,   setLinkDone]   = useState(false);
  const [scanLocked, setScanLocked] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const closeLinkModal = useCallback(() => {
    setLinkMode(null); setCodeInput(''); setLinkError(null);
    setLinkDone(false); setScanLocked(false);
  }, []);

  const handleQrScanned = useCallback(async ({ data }: { data: string }) => {
    if (isCompanion) { noAuthority('link devices'); return; }
    if (scanLocked || linking || !userId) return;
    setScanLocked(true);
    setLinkMode(null);
    setLinking(true);
    setLinkError(null);
    try {
      const raw = (data || '').trim();
      const m = LINK_QR_PATTERN.exec(raw);
      if (!m) throw new Error('This QR code is not a ChitChat device link.');
      const r = await claimLinkRequest(m[1], userId, myDisplayName || null);
      if (!r.success) throw new Error(r.error ?? 'Failed to link this device.');
      setLinkDone(true);
    } catch (e: any) {
      setLinkError(e?.message ?? 'Failed to link this device.');
      setScanLocked(false);
    } finally {
      setLinking(false);
    }
  }, [scanLocked, linking, userId, myDisplayName, isCompanion, noAuthority]);

  const handleCodeSubmit = useCallback(async () => {
    if (isCompanion) { noAuthority('link devices'); return; }
    if (!codeInput.trim() || linking || !userId) return;
    setLinking(true);
    setLinkError(null);
    try {
      const found = await findRequestByDisplayCode(codeInput.trim().toUpperCase());
      if (!found) throw new Error('No pending link request matches that code. Check the code and try again.');
      const r = await claimLinkRequest(found.requestId, userId, myDisplayName || null);
      if (!r.success) throw new Error(r.error ?? 'Failed to link this device.');
      setLinkDone(true);
      setLinkMode(null);
      setCodeInput('');
    } catch (e: any) {
      setLinkError(e?.message ?? 'Invalid code. Please try again.');
    } finally {
      setLinking(false);
    }
  }, [codeInput, linking, userId, myDisplayName, isCompanion, noAuthority]);

  const openCamera = useCallback(async () => {
    if (isCompanion) { noAuthority('link devices'); return; }
    if (Platform.OS === 'web') {
      Alert.alert('Not supported', 'QR scanning is not available on web. Use the code instead.');
      return;
    }
    const perm = await requestCameraPermission();
    if (perm?.status !== 'granted') {
      Alert.alert('Camera permission required', 'Allow camera access to scan QR codes.');
      return;
    }
    setScanLocked(false);
    setLinkMode('scan');
  }, [requestCameraPermission, isCompanion, noAuthority]);

  // ── Team / Inbox state ───────────────────────────────────────────────────
  const [inboxTab,    setInboxTab]    = useState<InboxTab>('all');
  const [inboxSearch, setInboxSearch] = useState('');
  const [agentModalVisible, setAgentModalVisible] = useState(false);
  const [phoneInput,  setPhoneInput]  = useState('');
  const [selRole,     setSelRole]     = useState<AgentRole>('agent');
  const [agentLinking,setAgentLinking]= useState(false);
  const [agentLinkErr,setAgentLinkErr]= useState<string | null>(null);
  const [assignChatId,   setAssignChatId]   = useState<string | null>(null);
  const [assignVisible,  setAssignVisible]  = useState(false);
  const [assignStatus,   setAssignStatus]   = useState<any>('open');
  const [assignTo,       setAssignTo]       = useState<string | null>(null);
  const [assignToName,   setAssignToName]   = useState<string | null>(null);

  const { conversations, loading: inboxLoading } = useInboxConversations(ownerUid, ownerUid, isAdmin);

  const filteredConvs = useMemo(() => {
    let list = conversations;
    if (inboxTab === 'mine')       list = list.filter((c) => c.assignedTo === ownerUid && c.status !== 'resolved');
    if (inboxTab === 'unassigned') list = list.filter((c) => !c.assignedTo && c.status !== 'resolved');
    if (inboxTab === 'resolved')   list = list.filter((c) => c.status === 'resolved');
    if (inboxSearch.trim()) {
      const q = inboxSearch.toLowerCase();
      list = list.filter((c) =>
        c.groupName?.toLowerCase().includes(q) ||
        c.lastMessage.toLowerCase().includes(q) ||
        c.assignedToName?.toLowerCase().includes(q)
      );
    }
    return list;
  }, [conversations, inboxTab, ownerUid, inboxSearch]);

  const inboxCounts = useMemo(() => ({
    all:        conversations.filter((c) => c.status !== 'resolved').length,
    mine:       conversations.filter((c) => c.assignedTo === ownerUid && c.status !== 'resolved').length,
    unassigned: conversations.filter((c) => !c.assignedTo && c.status !== 'resolved').length,
    resolved:   conversations.filter((c) => c.status === 'resolved').length,
  }), [conversations, ownerUid]);

  const handleAgentLink = useCallback(async () => {
    if (isCompanion) { noAuthority('link team members'); return; }
    if (!ownerUid || !userId || !phoneInput.trim()) return;
    setAgentLinking(true); setAgentLinkErr(null);
    let phone = phoneInput.trim();
    if (!phone.startsWith('+')) phone = `+${phone}`;
    const r = await addAgent(ownerUid, userId, phone, selRole);
    setAgentLinking(false);
    if (r.success) { setPhoneInput(''); setSelRole('agent'); setAgentModalVisible(false); }
    else setAgentLinkErr(r.error ?? 'Failed to link account.');
  }, [ownerUid, userId, phoneInput, selRole, isCompanion, noAuthority]);

  const handleUnlink = useCallback((agent: TeamAgent) => {
    if (isCompanion) { noAuthority('unlink team members'); return; }
    Alert.alert('Unlink Account', `Remove ${agent.displayName} from the team?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unlink', style: 'destructive', onPress: async () => {
          if (!ownerUid) return;
          const r = await removeAgent(ownerUid, agent.uid);
          if (!r.success) Alert.alert('Error', r.error ?? 'Failed to unlink.');
        }},
    ]);
  }, [ownerUid, isCompanion, noAuthority]);

  const handleRoleChange = useCallback(async (agent: TeamAgent, role: AgentRole) => {
    if (isCompanion) { noAuthority('change roles'); return; }
    if (!ownerUid) return;
    const r = await updateAgentRole(ownerUid, agent.uid, role);
    if (!r.success) Alert.alert('Error', r.error ?? 'Failed to update role.');
  }, [ownerUid, isCompanion, noAuthority]);

  const openChat = useCallback((conv: InboxConversation) => {
    (navigation as any).navigate('Chat', {
      chatId: conv.chatId, displayName: conv.groupName ?? '…', isGroup: conv.type === 'group',
    });
  }, [navigation]);

  return (
    <View style={S.root}>
      <AppBg />

      {/* Header */}
      <View style={[S.header, { paddingTop: Platform.OS === 'web' ? 16 : insets.top + 12 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={S.backBtn}>
          <AppIcon name="chevron-back" size={26} color={COLORS.blue} fixedColor />
        </TouchableOpacity>
        <AppText style={[S.title, { color: textColor, fontFamily }]}>Linked Devices & Team</AppText>
        {screenTab === 'devices' ? (
          isCompanion ? (
            <View style={S.addBtnDisabled}>
              <Ionicons name="lock-closed" size={18} color={COLORS.sub} />
            </View>
          ) : (
            <TouchableOpacity style={S.addBtn} onPress={() => { setLinkError(null); setLinkMode('choose'); }}>
              <LinearGradient colors={GRADIENTS.primary} style={S.addBtnGrad}>
                <Ionicons name="add" size={20} color="#fff" />
              </LinearGradient>
            </TouchableOpacity>
          )
        ) : isAdmin && !isCompanion ? (
          <TouchableOpacity style={S.addBtn} onPress={() => { setAgentLinkErr(null); setPhoneInput(''); setAgentModalVisible(true); }}>
            <LinearGradient colors={GRADIENTS.primary} style={S.addBtnGrad}>
              <Ionicons name="add" size={20} color="#fff" />
            </LinearGradient>
          </TouchableOpacity>
        ) : (
          <View style={{ width: 36 }} />
        )}
      </View>

      {/* Screen tabs */}
      <View style={S.screenTabBar}>
        {(['devices', 'team'] as ScreenTab[]).map((tab) => {
          const active = screenTab === tab;
          return (
            <TouchableOpacity key={tab} style={[S.screenTab, active && S.screenTabActive]}
              activeOpacity={0.75} onPress={() => setScreenTab(tab)}>
              <AppIcon name={tab === 'devices' ? 'phone-portrait-outline' : 'people-outline'}
                size={16} color={active ? '#fff' : COLORS.blue} fixedColor />
              <AppText style={[S.screenTabLabel, active && S.screenTabLabelActive]} fixedColor={active}>
                {tab === 'devices' ? 'Devices' : 'Team'}
              </AppText>
              {tab === 'team' && agents.length > 0 && (
                <View style={[S.screenTabBadge, active && S.screenTabBadgeActive]}>
                  <AppText style={[S.screenTabBadgeTxt, active && { color: COLORS.blue }]} fixedColor={!active}>
                    {agents.length}
                  </AppText>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ══ DEVICES TAB ═══════════════════════════════════════════════════════ */}
      {screenTab === 'devices' && (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={S.scroll}>
          {linkDone && (
            <View style={S.successBanner}>
              <Ionicons name="checkmark-circle" size={18} color={COLORS.green} />
              <AppText style={S.successTxt} fixedColor>Device linked successfully!</AppText>
              <TouchableOpacity onPress={() => setLinkDone(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close" size={16} color={COLORS.green} />
              </TouchableOpacity>
            </View>
          )}

          {/* Companion: no-authority notice */}
          {isCompanion && (
            <View style={[S.noticeCard, bevel]}>
              <LinearGradient colors={['#6366f1', '#8b5cf6']} style={S.noticeIconWrap}>
                <Ionicons name="lock-closed-outline" size={20} color="#fff" />
              </LinearGradient>
              <View style={{ flex: 1 }}>
                <AppText style={[S.noticeTitle, { color: textColor, fontFamily }]}>
                  View only
                </AppText>
                <AppText style={[S.noticeBody, { color: FG.secondary }]}>
                  You're signed in on a companion device. You can see which
                  devices are linked, but only the primary phone can add or
                  remove devices.
                </AppText>
              </View>
            </View>
          )}

          {!isCompanion && (
            <View style={[S.infoBanner, { backgroundColor: 'rgba(255,255,255,0.6)' }]}>
              <AppIcon name="information-circle-outline" size={18} color={COLORS.blue} fixedColor />
              <AppText style={[S.infoBannerTxt, { color: FG.secondary }]}>
                These are devices signed into your ChitChat account. Tap + to link a new device or tap the sign-out icon to remove one.
              </AppText>
            </View>
          )}

          {devicesLoading ? (
            <ActivityIndicator size="large" color={COLORS.blue} style={{ marginTop: 40 }} />
          ) : (
            <>
              {currentDevice && (
                <>
                  <AppText style={[S.sectionLabel, { color: FG.secondary }]}>THIS DEVICE</AppText>
                  <DeviceCard
                    device={currentDevice}
                    FG={FG}
                    textColor={textColor}
                    fontFamily={fontFamily}
                    readOnly={isCompanion}
                  />
                </>
              )}

              {!currentDevice && devices.length === 0 && (
                <View style={S.emptyWrap}>
                  <AppIcon name="phone-portrait-outline" size={48} color={FG.secondary} />
                  <AppText style={[S.emptyTxt, { color: FG.secondary }]}>No devices linked yet</AppText>
                  {!isCompanion && (
                    <AppText style={[S.emptySubTxt, { color: FG.secondary }]}>
                      Tap + to link this device or another device to your account.
                    </AppText>
                  )}
                </View>
              )}

              {otherDevices.length > 0 && (
                <>
                  <View style={S.sectionRow}>
                    <AppText style={[S.sectionLabel, { color: FG.secondary }]}>
                      OTHER DEVICES ({otherDevices.length})
                    </AppText>
                    {!isCompanion && (
                      <TouchableOpacity onPress={() => setPendingDev('all')} activeOpacity={0.7}>
                        <AppText style={[S.logoutAllTxt, { color: COLORS.missed }]}>Remove all</AppText>
                      </TouchableOpacity>
                    )}
                  </View>
                  {otherDevices.map((d) => (
                    <DeviceCard
                      key={d.id}
                      device={d}
                      FG={FG}
                      textColor={textColor}
                      fontFamily={fontFamily}
                      readOnly={isCompanion}
                      onRemove={() => setPendingDev(d)}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </ScrollView>
      )}

      {/* ══ TEAM TAB ══════════════════════════════════════════════════════════ */}
      {screenTab === 'team' && (
        <View style={{ flex: 1 }}>
          <View style={[S.infoBanner, { backgroundColor: 'rgba(255,255,255,0.6)', marginHorizontal: 14, marginTop: 12, marginBottom: 6 }]}>
            <AppIcon name={isCompanion ? 'lock-closed-outline' : 'information-circle-outline'} size={18} color={COLORS.blue} fixedColor />
            <AppText style={[S.infoBannerTxt, { color: FG.secondary }]}>
              {isCompanion
                ? 'Team members can only be managed from the primary device.'
                : 'Linked accounts are other ChitChatBusiness users who can operate this inbox.' +
                  (isOwner ? ' Tap + to link an account.' : '')}
            </AppText>
          </View>

          <View style={S.teamAgentsSection}>
            <View style={S.sectionRow}>
              <AppText style={[S.sectionLabel, { color: FG.secondary }]}>LINKED ACCOUNTS ({agents.length})</AppText>
            </View>
            {agentsLoading ? (
              <ActivityIndicator size="small" color={COLORS.blue} style={{ marginVertical: 16 }} />
            ) : agents.length === 0 ? (
              <View style={[S.emptyWrap, { paddingTop: 20, paddingBottom: 12 }]}>
                <AppIcon name="people-outline" size={36} color={COLORS.sub} />
                <AppText style={[S.emptyTxt, { color: FG.secondary }]}>No linked accounts yet</AppText>
                {isOwner && !isCompanion && (
                  <AppText style={[S.emptySubTxt, { color: FG.secondary }]}>Tap + to link a team member's account</AppText>
                )}
              </View>
            ) : (
              <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 240 }}
                contentContainerStyle={{ paddingHorizontal: 14, gap: 8, paddingBottom: 4 }}>
                {agents.map((agent) => (
                  <AgentCard
                    key={agent.uid}
                    agent={agent}
                    isAdmin={isAdmin}
                    ownerUid={ownerUid ?? ''}
                    onRemove={handleUnlink}
                    onRoleChange={handleRoleChange}
                    textColor={textColor}
                    fontFamily={fontFamily}
                    readOnly={isCompanion}
                  />
                ))}
              </ScrollView>
            )}
          </View>

          <View style={S.inboxSection}>
            <View style={S.inboxSectionHeader}>
              <AppText style={[S.sectionLabel, { color: FG.secondary, marginBottom: 0 }]}>SHARED INBOX</AppText>
              <View style={[S.inboxSearchWrap, bevel]}>
                <AppIcon name="search" size={14} color={COLORS.sub} />
                <TextInput style={[S.inboxSearchInput, { color: textColor }]} placeholder="Search…"
                  placeholderTextColor={COLORS.sub} value={inboxSearch} onChangeText={setInboxSearch} />
              </View>
            </View>
            <View style={S.inboxTabBar}>
              {INBOX_TABS.map((tab) => {
                const active = inboxTab === tab.id;
                const count  = inboxCounts[tab.id];
                return (
                  <TouchableOpacity key={tab.id} style={S.inboxTabItem} onPress={() => setInboxTab(tab.id)} activeOpacity={0.75}>
                    <View style={S.inboxTabContent}>
                      <AppText style={[S.inboxTabLabel, active && S.inboxTabLabelActive]}>{tab.label}</AppText>
                      {count > 0 && (
                        <View style={[S.inboxTabBadge, active && S.inboxTabBadgeActive]}>
                          <AppText style={[S.inboxTabBadgeTxt, active && S.inboxTabBadgeTxtActive]} fixedColor={active}>{count}</AppText>
                        </View>
                      )}
                    </View>
                    {active && <View style={S.inboxTabLine} />}
                  </TouchableOpacity>
                );
              })}
            </View>
            {inboxLoading ? (
              <ActivityIndicator size="large" color={COLORS.blue} style={{ marginTop: 24 }} />
            ) : filteredConvs.length === 0 ? (
              <View style={S.inboxEmpty}>
                <Ionicons name={inboxTab === 'resolved' ? 'checkmark-done-circle-outline' : 'chatbubbles-outline'} size={36} color={COLORS.sub} />
                <AppText style={[S.inboxEmptyTxt, { color: textColor }]}>
                  {inboxTab === 'all' ? 'No conversations yet' : inboxTab === 'mine' ? 'Nothing assigned to you' : inboxTab === 'unassigned' ? 'All caught up!' : 'No resolved conversations'}
                </AppText>
              </View>
            ) : (
              <FlatList data={filteredConvs} keyExtractor={(c) => c.chatId}
                contentContainerStyle={S.inboxList} showsVerticalScrollIndicator={false}
                ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
                renderItem={({ item }) => (
                  <InboxRow item={item} ownerUid={ownerUid ?? ''} onPress={() => openChat(item)}
                    bevel={bevel} textColor={textColor} fontFamily={fontFamily} />
                )} />
            )}
          </View>
        </View>
      )}

      {/* ══ MODALS ════════════════════════════════════════════════════════════ */}

      {/* Remove device confirmation — only reachable on primary */}
      <Modal visible={!!pendingDev} transparent animationType="fade" onRequestClose={() => setPendingDev(null)}>
        <View style={S.modalOverlay}>
          <View style={[S.modalCard, { backgroundColor: FG.glassBg || 'rgba(255,255,255,0.97)', borderColor: FG.glassBorder }]}>
            <AppBg />
            <LinearGradient colors={['#e84343', '#c0392b']} style={S.modalIcon}>
              <AppIcon name="log-out-outline" size={26} color="#fff" fixedColor />
            </LinearGradient>
            <AppText style={[S.modalHeading, { color: textColor, fontFamily }]}>
              {pendingDev === 'all' ? 'Remove All Devices?' : 'Remove Device?'}
            </AppText>
            <AppText style={[S.modalBody, { color: FG.secondary }]}>
              {pendingDev === 'all'
                ? 'All other devices will be removed from your account immediately.'
                : `"${(pendingDev as LinkedDevice)?.name}" will be removed from your account.`}
            </AppText>
            <View style={S.modalActions}>
              <TouchableOpacity style={[S.modalBtn, S.modalBtnCancel, { borderColor: FG.glassBorder }]}
                onPress={() => setPendingDev(null)} activeOpacity={0.8} disabled={removing}>
                <AppText style={[S.modalBtnTxt, { color: textColor }]}>Cancel</AppText>
              </TouchableOpacity>
              <TouchableOpacity style={S.modalBtn} onPress={doRemoveDev} activeOpacity={0.8} disabled={removing}>
                <LinearGradient colors={['#e84343', '#c0392b']} style={S.modalBtnGrad}>
                  {removing
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <><AppIcon name="log-out-outline" size={16} color="#fff" fixedColor />
                       <AppText fixedColor style={[S.modalBtnTxt, { color: '#fff' }]}>
                         {pendingDev === 'all' ? 'Remove All' : 'Remove'}
                       </AppText></>}
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Link device — choose mode (unreachable on companion, but kept) */}
      <Modal visible={linkMode === 'choose'} transparent animationType="slide" onRequestClose={closeLinkModal}>
        <TouchableOpacity style={S.sheetBackdrop} activeOpacity={1} onPress={closeLinkModal} />
        <View style={[S.linkSheet, { backgroundColor: 'rgba(255,255,255,0.97)' }]}>
          <View style={S.sheetHandle} />
          <View style={S.sheetHeaderRow}>
            <View style={{ width: 36 }} />
            <AppText style={S.sheetTitle}>Link a Device</AppText>
            <TouchableOpacity onPress={closeLinkModal} style={{ width: 36, alignItems: 'flex-end' }}>
              <AppIcon name="close" size={20} color={COLORS.sub} />
            </TouchableOpacity>
          </View>
          <View style={S.chooseBody}>
            <AppText style={[S.chooseSubtitle, { color: FG.secondary }]}>
              Open ChitChatBusiness on the new device, tap Sign In, then tap "Show QR Code" in the companion section. Approve the new device below.
            </AppText>

            <TouchableOpacity style={[S.chooseOption, bevel]} activeOpacity={0.78} onPress={openCamera}>
              <View style={S.chooseIconWrap}>
                <LinearGradient colors={GRADIENTS.primary} style={S.chooseIconGrad}>
                  <Ionicons name="scan-outline" size={26} color="#fff" />
                </LinearGradient>
              </View>
              <View style={{ flex: 1 }}>
                <AppText style={[S.chooseOptionTitle, { color: textColor }]}>Scan QR Code</AppText>
                <AppText style={[S.chooseOptionDesc, { color: FG.secondary }]}>
                  Scan the QR code displayed on the new device's sign-in screen.
                </AppText>
              </View>
              <AppIcon name="chevron-forward" size={18} color={COLORS.sub} />
            </TouchableOpacity>

            <TouchableOpacity style={[S.chooseOption, bevel]} activeOpacity={0.78}
              onPress={() => { setLinkMode('enter-code'); }}>
              <View style={S.chooseIconWrap}>
                <LinearGradient colors={['#8b5cf6', '#6d28d9']} style={S.chooseIconGrad}>
                  <Ionicons name="keypad-outline" size={26} color="#fff" />
                </LinearGradient>
              </View>
              <View style={{ flex: 1 }}>
                <AppText style={[S.chooseOptionTitle, { color: textColor }]}>Enter Code</AppText>
                <AppText style={[S.chooseOptionDesc, { color: FG.secondary }]}>
                  Type the 10-character code shown on the new device's screen.
                </AppText>
              </View>
              <AppIcon name="chevron-forward" size={18} color={COLORS.sub} />
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* QR Scanner */}
      <Modal visible={linkMode === 'scan'} transparent={false} animationType="slide" onRequestClose={closeLinkModal}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          {CameraView && (
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={scanLocked ? undefined : handleQrScanned}
            />
          )}
          <View style={S.scanOverlay} pointerEvents="none">
            <View style={S.scanFrame} />
            <AppText style={S.scanHint}>Point the camera at the QR code shown on the other device</AppText>
          </View>
          {linking && (
            <View style={S.scanLoading}>
              <ActivityIndicator size="large" color="#fff" />
              <AppText style={{ color: '#fff', marginTop: 12, fontSize: 15 }}>Linking device…</AppText>
            </View>
          )}
          <TouchableOpacity style={S.scanClose} onPress={closeLinkModal}>
            <View style={S.scanCloseBtn}>
              <Ionicons name="close" size={24} color="#fff" />
            </View>
          </TouchableOpacity>
          {linkError && (
            <View style={S.scanError}>
              <AppText style={{ color: '#fff', textAlign: 'center' }}>{linkError}</AppText>
              <TouchableOpacity onPress={() => { setLinkError(null); setScanLocked(false); }} style={{ marginTop: 8 }}>
                <AppText style={{ color: COLORS.blue, fontWeight: '700' }}>Try again</AppText>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </Modal>

      {/* Enter code */}
      <Modal visible={linkMode === 'enter-code'} transparent animationType="slide" onRequestClose={closeLinkModal}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <TouchableOpacity style={S.sheetBackdrop} activeOpacity={1} onPress={closeLinkModal} />
          <View style={[S.linkSheet, { backgroundColor: 'rgba(255,255,255,0.97)' }]}>
            <View style={S.sheetHandle} />
            <View style={S.sheetHeaderRow}>
              <TouchableOpacity onPress={() => setLinkMode('choose')} style={{ width: 36 }}>
                <AppIcon name="chevron-back" size={22} color={COLORS.blue} fixedColor />
              </TouchableOpacity>
              <AppText style={S.sheetTitle}>Enter Link Code</AppText>
              <TouchableOpacity onPress={closeLinkModal} style={{ width: 36, alignItems: 'flex-end' }}>
                <AppIcon name="close" size={20} color={COLORS.sub} />
              </TouchableOpacity>
            </View>
            <View style={{ paddingHorizontal: 20, paddingBottom: 40, paddingTop: 8 }}>
              <AppText style={[S.fieldLabel, { marginBottom: 12 }]}>10-CHARACTER CODE</AppText>
              <View style={[S.codeInputWrap, bevel]}>
                <Ionicons name="keypad-outline" size={20} color={COLORS.sub} />
                <TextInput
                  style={[S.codeInputField, { color: textColor }]}
                  placeholder="ABCDE-FGHIJ"
                  placeholderTextColor={COLORS.sub}
                  value={codeInput}
                  onChangeText={(t) => {
                    const clean = t.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 10);
                    setCodeInput(clean);
                    setLinkError(null);
                  }}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={handleCodeSubmit}
                  maxLength={11}
                />
              </View>
              <AppText style={[S.fieldHint, { marginBottom: 16 }]}>
                Enter the 10-character code shown on the new device's screen.
              </AppText>
              {linkError && (
                <View style={S.linkErrorBanner}>
                  <Ionicons name="alert-circle" size={16} color={COLORS.missed} />
                  <AppText style={S.linkErrorTxt} fixedColor>{linkError}</AppText>
                </View>
              )}
              <TouchableOpacity
                style={[S.linkSubmitBtn, (codeInput.length < 10 || linking) && { opacity: 0.5 }]}
                activeOpacity={0.85} disabled={codeInput.length < 10 || linking}
                onPress={handleCodeSubmit}>
                <LinearGradient colors={GRADIENTS.primary} style={S.linkSubmitGrad}>
                  {linking
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <><Ionicons name="link-outline" size={18} color="#fff" />
                       <AppText style={S.linkSubmitTxt} fixedColor>Link Device</AppText></>}
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Link account by phone (team) */}
      <Modal visible={agentModalVisible} transparent animationType="slide" onRequestClose={() => setAgentModalVisible(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <TouchableOpacity style={S.sheetBackdrop} activeOpacity={1} onPress={() => setAgentModalVisible(false)} />
          <View style={[S.linkSheet, { backgroundColor: 'rgba(255,255,255,0.97)' }]}>
            <View style={S.sheetHandle} />
            <View style={S.sheetHeaderRow}>
              <View style={{ width: 36 }} />
              <AppText style={S.sheetTitle}>Link Account</AppText>
              <TouchableOpacity onPress={() => setAgentModalVisible(false)} style={{ width: 36, alignItems: 'flex-end' }}>
                <AppIcon name="close" size={20} color={COLORS.sub} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 44, paddingTop: 4 }} keyboardShouldPersistTaps="handled">
              <AppText style={S.fieldLabel}>Phone Number</AppText>
              <View style={[S.codeInputWrap, bevel]}>
                <AppIcon name="call-outline" size={18} color={COLORS.sub} />
                <TextInput style={[S.codeInputField, { color: textColor }]} placeholder="+27 82 123 4567"
                  placeholderTextColor={COLORS.sub} value={phoneInput} onChangeText={setPhoneInput}
                  keyboardType="phone-pad" autoFocus returnKeyType="done" onSubmitEditing={handleAgentLink} />
              </View>
              <AppText style={[S.fieldHint, { marginBottom: 16 }]}>
                Enter the team member's phone number as registered in ChitChatBusiness.
              </AppText>
              <AppText style={[S.fieldLabel, { marginTop: 4 }]}>Role</AppText>
              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
                {(['agent', 'admin'] as AgentRole[]).map((r) => (
                  <TouchableOpacity key={r} style={[S.roleOption, bevel, selRole === r && S.roleOptionActive]}
                    activeOpacity={0.75} onPress={() => setSelRole(r)}>
                    <Ionicons name={r === 'admin' ? 'shield-outline' : 'person-outline'} size={20}
                      color={selRole === r ? '#fff' : COLORS.blue} />
                    <AppText style={[S.roleOptionTxt, selRole === r && S.roleOptionTxtActive]} fixedColor={selRole === r}>
                      {r === 'admin' ? 'Admin' : 'Agent'}
                    </AppText>
                  </TouchableOpacity>
                ))}
              </View>
              {agentLinkErr && (
                <View style={S.linkErrorBanner}>
                  <Ionicons name="alert-circle" size={16} color={COLORS.missed} />
                  <AppText style={S.linkErrorTxt} fixedColor>{agentLinkErr}</AppText>
                </View>
              )}
              <TouchableOpacity style={[S.linkSubmitBtn, (!phoneInput.trim() || agentLinking) && { opacity: 0.5 }]}
                activeOpacity={0.85} disabled={!phoneInput.trim() || agentLinking} onPress={handleAgentLink}>
                <LinearGradient colors={GRADIENTS.primary} style={S.linkSubmitGrad}>
                  {agentLinking
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <><Ionicons name="link-outline" size={18} color="#fff" />
                       <AppText style={S.linkSubmitTxt} fixedColor>Link Account</AppText></>}
                </LinearGradient>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Assignment sheet */}
      {assignChatId && (
        <AssignmentSheet
          visible={assignVisible}
          onClose={() => { setAssignVisible(false); setAssignChatId(null); }}
          chatId={assignChatId}
          currentStatus={assignStatus}
          assignedTo={assignTo}
          assignedToName={assignToName}
          agents={agents}
          actorUid={ownerUid ?? ''}
          actorName={myDisplayName || 'Agent'}
          isAdmin={isAdmin}
        />
      )}
    </View>
  );
}

const S = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingBottom: 10, paddingHorizontal: 14 },
  backBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.65)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.8)' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },
  addBtn: {},
  addBtnGrad: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', ...SHADOW.button },
  addBtnDisabled: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.06)' },

  screenTabBar: { flexDirection: 'row', marginHorizontal: 14, marginBottom: 4, backgroundColor: 'rgba(255,255,255,0.55)', borderRadius: RADIUS.full, padding: 4, gap: 4 },
  screenTab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 8, borderRadius: RADIUS.full },
  screenTabActive: { backgroundColor: COLORS.blue, ...SHADOW.button },
  screenTabLabel: { fontSize: 13, fontWeight: '600', color: COLORS.blue },
  screenTabLabelActive: { color: '#fff' },
  screenTabBadge: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: RADIUS.full, backgroundColor: 'rgba(30,156,240,0.15)', minWidth: 18, alignItems: 'center' },
  screenTabBadgeActive: { backgroundColor: 'rgba(255,255,255,0.25)' },
  screenTabBadgeTxt: { fontSize: 10, fontWeight: '700', color: COLORS.blue },

  scroll: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 48, gap: 8 },
  infoBanner: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', borderRadius: RADIUS.lg, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 4 },
  infoBannerTxt: { flex: 1, fontSize: 13, lineHeight: 19 },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingBottom: 4, paddingTop: 4 },
  sectionLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2, paddingHorizontal: 14, paddingBottom: 4, paddingTop: 8 },
  logoutAllTxt: { fontSize: 12, fontWeight: '700', color: COLORS.missed },
  emptyWrap: { alignItems: 'center', paddingTop: 36, gap: 10 },
  emptyTxt: { fontSize: 14 },
  emptySubTxt: { fontSize: 12, opacity: 0.7, textAlign: 'center' },

  successBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(34,197,94,0.12)', borderRadius: RADIUS.md, padding: 12, marginBottom: 8 },
  successTxt: { flex: 1, fontSize: 13, fontWeight: '600', color: COLORS.green },

  // Companion notice
  noticeCard: {
    flexDirection: 'row', gap: 12,
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14, paddingVertical: 14,
    marginBottom: 8,
  },
  noticeIconWrap: {
    width: 40, height: 40, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
    ...SHADOW.button,
  },
  noticeTitle: { fontSize: 13, fontWeight: '800', marginBottom: 3 },
  noticeBody:  { fontSize: 12, lineHeight: 17 },

  card: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, borderRadius: RADIUS.lg, paddingHorizontal: 14, paddingVertical: 14, marginHorizontal: 14, marginBottom: 0 },
  cardReadOnly: { opacity: 0.65 },
  deviceIconWrap: { width: 48, height: 48, borderRadius: 14, backgroundColor: 'rgba(30,156,240,0.10)', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  iconWrapReadOnly: { backgroundColor: 'rgba(90,127,160,0.10)' },
  deviceInfo: { flex: 1, gap: 3 },
  deviceNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  deviceName: { fontSize: 14, fontWeight: '700', flexShrink: 1 },
  deviceMeta: { fontSize: 12 },
  deviceDetailRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  deviceDetail: { fontSize: 11 },
  currentBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: RADIUS.full, ...SHADOW.button },
  currentBadgeTxt: { fontSize: 10, fontWeight: '700', color: '#fff' },
  logoutBtn: { padding: 4, alignSelf: 'center' },

  agentAvatar: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  agentAvatarImg: { width: 48, height: 48, borderRadius: 24 },
  agentAvatarTxt: { fontSize: 16, fontWeight: '700', color: '#fff' },
  rolePill: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: RADIUS.full },
  roleAdmin: { backgroundColor: 'rgba(30,156,240,0.15)' },
  roleAgent: { backgroundColor: 'rgba(90,127,160,0.12)' },
  roleTxt: { fontSize: 10, fontWeight: '700' },
  roleTxtAdmin: { color: COLORS.blue },
  roleTxtAgent: { color: COLORS.sub },
  agentMenuCard: { position: 'absolute', right: 20, top: '28%', width: 210, borderRadius: RADIUS.lg, paddingVertical: 6, backgroundColor: 'rgba(255,255,255,0.97)', ...SHADOW.card },
  menuBackdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.30)' },
  agentMenuName: { fontSize: 13, fontWeight: '700', color: COLORS.sub, paddingHorizontal: 14, paddingVertical: 6 },
  agentMenuDivider: { height: 1, backgroundColor: COLORS.border, marginHorizontal: 10, marginBottom: 4 },
  agentMenuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 11 },
  agentMenuIcon: { width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(30,156,240,0.10)', alignItems: 'center', justifyContent: 'center' },
  agentMenuIconDanger: { backgroundColor: 'rgba(232,67,67,0.10)' },
  agentMenuLabel: { fontSize: 14, fontWeight: '500', color: COLORS.text },

  teamAgentsSection: { borderBottomWidth: 1, borderBottomColor: COLORS.border, paddingBottom: 8 },
  inboxSection: { flex: 1 },
  inboxSectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingTop: 6, paddingBottom: 4 },
  inboxSearchWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: RADIUS.full, minWidth: 100 },
  inboxSearchInput: { fontSize: 13, minWidth: 80 },
  inboxTabBar: { flexDirection: 'row', paddingHorizontal: 10, marginBottom: 4 },
  inboxTabItem: { flex: 1, alignItems: 'center', paddingVertical: 6 },
  inboxTabContent: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  inboxTabLabel: { fontSize: 12, fontWeight: '500', color: COLORS.sub },
  inboxTabLabelActive: { fontWeight: '700', color: COLORS.blue },
  inboxTabBadge: { paddingHorizontal: 4, paddingVertical: 1, borderRadius: RADIUS.full, backgroundColor: 'rgba(90,127,160,0.15)', minWidth: 16, alignItems: 'center' },
  inboxTabBadgeActive: { backgroundColor: COLORS.blue },
  inboxTabBadgeTxt: { fontSize: 10, fontWeight: '700', color: COLORS.sub },
  inboxTabBadgeTxtActive: { color: '#fff' },
  inboxTabLine: { position: 'absolute', bottom: -1, left: '10%', right: '10%', height: 2, borderRadius: 1, backgroundColor: COLORS.blue },
  inboxList: { paddingHorizontal: 12, paddingBottom: 20, paddingTop: 2 },
  inboxRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderRadius: RADIUS.lg, paddingHorizontal: 12, paddingVertical: 10 },
  inboxAvatar: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', marginTop: 2, flexShrink: 0 },
  inboxAvatarImg: { width: 42, height: 42, borderRadius: 21 },
  inboxAvatarTxt: { fontSize: 14, fontWeight: '700', color: '#fff' },
  inboxTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  inboxName: { flex: 1, fontSize: 14, fontWeight: '700', color: COLORS.text },
  inboxTime: { fontSize: 11, color: COLORS.sub },
  inboxBottom: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  inboxPreview: { flex: 1, fontSize: 12, color: COLORS.sub },
  inboxBadge: { backgroundColor: COLORS.blue, borderRadius: 9, minWidth: 18, height: 18, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  inboxBadgeTxt: { color: '#fff', fontSize: 10, fontWeight: '700' },
  inboxEmpty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 32, gap: 10 },
  inboxEmptyTxt: { fontSize: 15, fontWeight: '600', color: COLORS.text },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.50)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  modalCard: { width: '100%', borderRadius: 20, borderWidth: 1, alignItems: 'center', padding: 28, gap: 12, overflow: 'hidden', ...SHADOW.glow },
  modalIcon: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', marginBottom: 4, ...SHADOW.button },
  modalHeading: { fontSize: 20, fontWeight: '800', textAlign: 'center' },
  modalBody: { fontSize: 14, lineHeight: 22, textAlign: 'center' },
  modalActions: { flexDirection: 'row', gap: 12, marginTop: 8, width: '100%' },
  modalBtn: { flex: 1, borderRadius: RADIUS.full, overflow: 'hidden' },
  modalBtnCancel: { borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 13 },
  modalBtnGrad: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 13 },
  modalBtnTxt: { fontSize: 15, fontWeight: '700' },

  sheetBackdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.4)' },
  linkSheet: { position: 'absolute', bottom: 0, left: 0, right: 0, borderTopLeftRadius: 24, borderTopRightRadius: 24, ...SHADOW.card },
  sheetHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: COLORS.border, alignSelf: 'center', marginTop: 10, marginBottom: 4 },
  sheetHeaderRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  sheetTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: COLORS.text },

  chooseBody: { paddingHorizontal: 16, paddingBottom: 36, paddingTop: 4, gap: 10 },
  chooseSubtitle: { fontSize: 13, lineHeight: 18, marginBottom: 4 },
  chooseOption: { flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: RADIUS.lg, paddingHorizontal: 14, paddingVertical: 14 },
  chooseIconWrap: {},
  chooseIconGrad: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', ...SHADOW.button },
  chooseOptionTitle: { fontSize: 15, fontWeight: '700', marginBottom: 2 },
  chooseOptionDesc: { fontSize: 12, lineHeight: 17 },

  scanOverlay: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  scanFrame: { width: 240, height: 240, borderRadius: 16, borderWidth: 2, borderColor: 'rgba(255,255,255,0.8)', backgroundColor: 'transparent' },
  scanHint: { color: '#fff', fontSize: 14, textAlign: 'center', marginTop: 24, paddingHorizontal: 40, fontWeight: '500' },
  scanLoading: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  scanClose: { position: 'absolute', top: 54, left: 16 },
  scanCloseBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  scanError: { position: 'absolute', bottom: 60, left: 20, right: 20, backgroundColor: 'rgba(232,67,67,0.85)', borderRadius: 12, padding: 16, alignItems: 'center' },

  codeInputWrap: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: RADIUS.md, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 0 },
  codeInputField: { flex: 1, fontSize: 18, fontWeight: '700', letterSpacing: 4 },
  fieldLabel: { fontSize: 11, fontWeight: '700', color: COLORS.sub, letterSpacing: 0.8, marginBottom: 8 },
  fieldHint: { fontSize: 12, color: COLORS.sub, marginTop: 6 },
  linkErrorBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(232,67,67,0.10)', borderRadius: RADIUS.sm, padding: 12, marginTop: 12 },
  linkErrorTxt: { flex: 1, fontSize: 13, color: COLORS.missed },
  linkSubmitBtn: { marginTop: 20 },
  linkSubmitGrad: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: RADIUS.full, ...SHADOW.button },
  linkSubmitTxt: { fontSize: 16, fontWeight: '700', color: '#fff' },
  roleOption: { flex: 1, alignItems: 'center', gap: 4, borderRadius: RADIUS.md, paddingVertical: 14 },
  roleOptionActive: { backgroundColor: COLORS.blue },
  roleOptionTxt: { fontSize: 14, fontWeight: '700', color: COLORS.blue },
  roleOptionTxtActive: { color: '#fff' },
});