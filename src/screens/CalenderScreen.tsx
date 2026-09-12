// ─── Screen: Calendar (Advanced Meetings Dashboard) ──────────────────────────
import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  TextInput, Modal, Pressable, ScrollView, Animated,
  Platform, ActivityIndicator, KeyboardAvoidingView, Alert
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import DatePicker from 'react-native-date-picker';
import firestore from '@react-native-firebase/firestore';
// ─── Native Hardware & AI Imports ────────────────────────────────────────────
import { useAudioRecorder, AudioModule, RecordingPresets, setAudioModeAsync } from 'expo-audio';
import { documentDirectory, copyAsync, readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import * as Notifications from 'expo-notifications';
import * as Contacts from 'expo-contacts';   // ✅ NEW: device contacts
import { BottomNav } from '../components';
import { useAuth } from '../context/AuthContext';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';

// ─── API KEY ─────────────────────────────────────────────────────────────────
const GEMINI_API_KEY = "YOUR_GEMINI_API_KEY";

type TabType = 'Upcoming' | 'Past' | 'Meetings';

// Default reminder milestones in minutes: 1 hour, 30 min, 15 min, 10 min
const AUTOMATIC_REMINDER_MILESTONES = [60, 30, 15, 10];

interface Member {
  id: string;
  name: string;
  phone?: string;
  email?: string;
}

interface Meeting {
  id: string;
  title: string;
  date: Date;
  duration: string;
  participants: string[];
  members: Member[];
  organizerId: string;
  organizerName: string;
  type: 'online' | 'in-person';
  reminders: number[];
}

// ─── Notifications Handler ───────────────────────────────────────────────────
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

function stringToColor(str: string): string {
  const colors = ['#f97316','#8b5cf6','#ec4899','#06b6d4','#10b981','#f59e0b','#6366f1','#e11d48'];
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}
function formatTime(date: Date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatDate(date: Date) {
  return date.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
}
function initialsOf(name: string) {
  return name.split(' ').filter(Boolean).slice(0, 2).map(p => p[0]?.toUpperCase()).join('') || '?';
}

// ─── Meeting Row (For Upcoming/Past Tabs) ────────────────────────────────────
const MeetingRow = React.memo(function MeetingRow({
  item, bevel, textColor, fontFamily, FGsecondary, onPress, currentUserId
}: any) {
  const color = stringToColor(item.title);
  const isOnline = item.type === 'online';
  const timeString = formatTime(item.date);
  const isOrganizer = item.organizerId === currentUserId;
  const attendeeCount = (item.members?.length || 0) + 1; // + organizer

  return (
    <TouchableOpacity style={[styles.meetingCard, bevel]} activeOpacity={0.75} onPress={onPress}>
      <View style={styles.timeBlock}>
        <AppText style={[styles.timeText, { color: textColor }]}>{timeString.split(' ')[0]}</AppText>
        <AppText style={styles.amPmText}>{timeString.split(' ')[1]}</AppText>
      </View>

      <View style={[styles.cardDivider, { backgroundColor: color }]} />

      <View style={styles.meetingDetails}>
        <View style={styles.titleRow}>
          <AppText style={[styles.meetingTitle, { color: textColor, fontFamily }]} numberOfLines={1}>
            {item.title}
          </AppText>
          {isOrganizer && (
            <View style={styles.organizerBadge}>
              <AppText style={styles.organizerBadgeText}>Organizer</AppText>
            </View>
          )}
        </View>

        <View style={styles.meetingMetaRow}>
          <AppIcon name="calendar-outline" size={12} color={COLORS.sub} />
          <AppText style={[styles.meetingMetaText, { color: FGsecondary }]}>{formatDate(item.date)}</AppText>
          <AppText style={[styles.meetingMetaText, { color: FGsecondary }]}> • {item.duration}</AppText>
        </View>

        <View style={styles.meetingMetaRow}>
          <AppIcon name={isOnline ? 'videocam-outline' : 'location-outline'} size={12} color={COLORS.sub} />
          <AppText style={[styles.meetingMetaText, { color: FGsecondary }]}>
            {isOnline ? 'Video Call' : 'In Person'}
          </AppText>
          <AppText style={[styles.meetingMetaText, { color: FGsecondary }]}> • {attendeeCount} attending</AppText>
        </View>
      </View>

      <View style={styles.actionArrow}>
        <AppIcon name="chevron-forward" size={18} color={COLORS.sub} />
      </View>
    </TouchableOpacity>
  );
});

// ─── Contacts Picker (select members from device contacts) ──────────────────
function ContactsPickerSheet({
  visible, onClose, onConfirm, alreadySelectedIds,
}: {
  visible: boolean;
  onClose: () => void;
  onConfirm: (members: Member[]) => void;
  alreadySelectedIds: string[];
}) {
  const insets = useSafeAreaInsets();
  const { bevel } = useGlass();
  const { textColor } = useTypography();
  const { FG } = useForeground();

  const [contacts, setContacts] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Record<string, Member>>({});

  // Load contacts whenever the sheet becomes visible
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        const { status } = await Contacts.requestPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert(
            'Permission required',
            'Please allow contacts access so you can invite members to your meeting.'
          );
          onClose();
          return;
        }

        const { data } = await Contacts.getContactsAsync({
          fields: [
            Contacts.Fields.Name,
            Contacts.Fields.PhoneNumbers,
            Contacts.Fields.Emails,
          ],
        });

        const cleaned: Member[] = (data || [])
          .filter((c: any) => c && (c.name || c.firstName))
          .map((c: any) => ({
            id: c.id || `${c.name}-${Math.random()}`,
            name: c.name || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
            phone: c.phoneNumbers?.[0]?.number?.replace(/\s+/g, '') || '',
            email: c.emails?.[0]?.email || '',
          }))
          .sort((a: Member, b: Member) => a.name.localeCompare(b.name));

        if (!cancelled) {
          setContacts(cleaned);
          // Pre-tick anyone already added
          const pre: Record<string, Member> = {};
          cleaned.forEach((c: Member) => {
            if (alreadySelectedIds.includes(c.id)) pre[c.id] = c;
          });
          setSelected(pre);
        }
      } catch (e) {
        console.error('loadContacts error:', e);
        Alert.alert('Error', 'Could not load your contacts.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [visible]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.phone || '').includes(q) ||
      (c.email || '').toLowerCase().includes(q)
    );
  }, [search, contacts]);

  const toggle = (c: Member) => {
    setSelected(prev => {
      const next = { ...prev };
      if (next[c.id]) delete next[c.id];
      else next[c.id] = c;
      return next;
    });
  };

  const selectedCount = Object.keys(selected).length;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.overlay} onPress={onClose} />
      <View style={[styles.sheet, { height: '88%' }]}>
        <AppBg />
        <View style={styles.handle} />

        <View style={styles.sheetSubHeader}>
          <TouchableOpacity onPress={onClose} style={styles.iconPad}>
            <AppIcon name="close" size={22} color={COLORS.sub} />
          </TouchableOpacity>
          <AppText style={[styles.sheetTitle, { color: textColor }]}>Add Members</AppText>
          <TouchableOpacity
            onPress={() => {
              onConfirm(Object.values(selected));
              onClose();
            }}
            activeOpacity={0.85}
          >
            <LinearGradient colors={GRADIENTS.primary} style={styles.nextBtnGrad}>
              <AppText style={styles.nextBtnText}>
                Add{selectedCount > 0 ? ` (${selectedCount})` : ''}
              </AppText>
            </LinearGradient>
          </TouchableOpacity>
        </View>

        <View style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
          <View style={[styles.glassInput, bevel]}>
            <AppIcon name="search-outline" size={16} color={COLORS.sub} />
            <TextInput
              style={[styles.inputField, { color: textColor }]}
              placeholder="Search contacts"
              placeholderTextColor={COLORS.sub}
              value={search}
              onChangeText={setSearch}
            />
          </View>
        </View>

        {loading ? (
          <View style={styles.emptyWrap}>
            <ActivityIndicator size="large" color={COLORS.blue} />
            <AppText style={styles.emptyText}>Loading contacts…</AppText>
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(c) => c.id}
            contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: insets.bottom + 30 }}
            ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                <AppIcon name="people-outline" size={48} color={COLORS.sub} />
                <AppText style={styles.emptyText}>No contacts found</AppText>
              </View>
            }
            renderItem={({ item }) => {
              const isOn = !!selected[item.id];
              return (
                <TouchableOpacity
                  style={[styles.contactRow, bevel, isOn && styles.contactRowActive]}
                  activeOpacity={0.75}
                  onPress={() => toggle(item)}
                >
                  <View style={[styles.contactAvatar, { backgroundColor: stringToColor(item.name) }]}>
                    <AppText style={styles.avatarTxt}>{initialsOf(item.name)}</AppText>
                  </View>
                  <View style={{ flex: 1 }}>
                    <AppText style={[styles.contactName, { color: textColor }]} numberOfLines={1}>
                      {item.name}
                    </AppText>
                    <AppText style={styles.contactSub} numberOfLines={1}>
                      {item.phone || item.email || 'No contact info'}
                    </AppText>
                  </View>
                  <View style={[styles.checkbox, isOn && styles.checkboxOn]}>
                    {isOn && <AppIcon name="checkmark" size={14} color="#fff" fixedColor />}
                  </View>
                </TouchableOpacity>
              );
            }}
          />
        )}
      </View>
    </Modal>
  );
}

// ─── Organize Meeting Sheet (Automatic Reminders + Members) ─────────────────
function NewMeetingSheet({
  onBack, onDone, userId, userName,
}: {
  onBack: () => void;
  onDone: () => void;
  userId: string;
  userName?: string;
}) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(new Date());
  const [openPicker, setOpenPicker] = useState(false);
  const [creating, setCreating] = useState(false);

  // ✅ Members selected from the device contacts
  const [members, setMembers] = useState<Member[]>([]);
  const [contactsOpen, setContactsOpen] = useState(false);

  const { bevel } = useGlass();
  const { textColor } = useTypography();

  // ✅ Guard: nobody can create a meeting without an authenticated uid
  const canCreate = title.trim().length > 0 && !!userId && !creating;

  const handleCreate = async () => {
    if (!canCreate) return;
    setCreating(true);

    try {
      // 1. The creator IS the organizer — store that explicitly
      await firestore().collection('meetings').add({
        title: title.trim(),
        date: firestore.Timestamp.fromDate(date),
        duration: '1h',
        // organizer uid first so `array-contains` still matches for them
        participants: [userId, ...members.map(m => m.id)],
        members: members,                       // full member records for display
        organizerId: userId,                    // ✅ who created it
        organizerName: userName || 'Organizer',
        is_organizer: true,
        type: 'online',
        reminders: AUTOMATIC_REMINDER_MILESTONES,
        createdAt: firestore.FieldValue.serverTimestamp(),
      });

      // 2. Schedule local notifications for all 4 milestones
      const now = new Date();
      for (const mins of AUTOMATIC_REMINDER_MILESTONES) {
        const triggerTime = new Date(date.getTime() - mins * 60000);
        if (triggerTime > now) {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: 'Meeting Reminder',
              body: `"${title}" starts in ${mins === 60 ? '1 hour' : `${mins} minutes`}.`,
              sound: true,
            },
            trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: triggerTime },
          });
        }
      }

      onDone();
    } catch (error) {
      console.error('Error creating meeting: ', error);
      Alert.alert('Error', 'Could not save the meeting. Please try again.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <View style={styles.sheetSubHeader}>
        <TouchableOpacity onPress={onBack} style={styles.iconPad} disabled={creating}>
          <AppIcon name="close" size={22} color={COLORS.sub} />
        </TouchableOpacity>
        <AppText style={[styles.sheetTitle, { color: textColor }]}>Organize Meeting</AppText>
        {title.trim().length > 0 && (
          <TouchableOpacity onPress={handleCreate} activeOpacity={0.85} disabled={!canCreate}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.nextBtnGrad}>
              {creating ? <ActivityIndicator size="small" color="#fff" /> : <AppText style={styles.nextBtnText}>Save</AppText>}
            </LinearGradient>
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.sheetContent}
        keyboardShouldPersistTaps="handled"
      >
        <AppText style={styles.inputLabel}>Meeting Title</AppText>
        <View style={[styles.glassInput, bevel]}>
          <AppIcon name="text-outline" size={18} color={COLORS.sub} />
          <TextInput
            style={[styles.inputField, { color: textColor }]}
            placeholder="E.g. Technical Architecture Review"
            placeholderTextColor={COLORS.sub}
            value={title}
            onChangeText={setTitle}
          />
        </View>

        <AppText style={styles.inputLabel}>Schedule</AppText>
        <TouchableOpacity style={[styles.glassInput, bevel]} onPress={() => setOpenPicker(true)}>
          <AppIcon name="calendar-outline" size={18} color={COLORS.blue} />
          <AppText style={[styles.inputField, { color: textColor }]}>
            {formatDate(date)} at {formatTime(date)}
          </AppText>
        </TouchableOpacity>

        <DatePicker
          modal
          open={openPicker}
          date={date}
          mode="datetime"
          onConfirm={(d) => { setOpenPicker(false); setDate(d); }}
          onCancel={() => setOpenPicker(false)}
        />

        {/* ✅ Members from contacts */}
        <AppText style={styles.inputLabel}>Members</AppText>
        <TouchableOpacity
          style={[styles.glassInput, bevel]}
          onPress={() => setContactsOpen(true)}
          activeOpacity={0.8}
        >
          <AppIcon name="people-outline" size={18} color={COLORS.blue} />
          <AppText style={[styles.inputField, { color: members.length ? textColor : COLORS.sub }]}>
            {members.length ? `${members.length} member${members.length > 1 ? 's' : ''} selected` : 'Add members from contacts'}
          </AppText>
          <AppIcon name="chevron-forward" size={16} color={COLORS.sub} />
        </TouchableOpacity>

        {members.length > 0 && (
          <View style={styles.chipWrap}>
            {members.map(m => (
              <View key={m.id} style={styles.chip}>
                <AppText style={styles.chipText} numberOfLines={1}>{m.name}</AppText>
                <TouchableOpacity
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  onPress={() => setMembers(prev => prev.filter(x => x.id !== m.id))}
                >
                  <AppIcon name="close-circle" size={15} color={COLORS.sub} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {/* Automatic Reminders Notice */}
        <View style={[styles.autoReminderInfo, bevel]}>
          <AppIcon name="notifications-outline" size={18} color={COLORS.blue} />
          <View style={{ flex: 1 }}>
            <AppText style={[styles.autoReminderTitle, { color: textColor }]}>Automated Reminders Set</AppText>
            <AppText style={styles.autoReminderSub}>
              Notifications scheduled automatically for 1 hr, 30 min, 15 min, and 10 min prior.
            </AppText>
          </View>
        </View>
      </ScrollView>

      {/* Contacts picker (own modal so it stacks above the sheet) */}
      <ContactsPickerSheet
        visible={contactsOpen}
        onClose={() => setContactsOpen(false)}
        alreadySelectedIds={members.map(m => m.id)}
        onConfirm={(picked) => setMembers(picked)}
      />
    </>
  );
}

// ─── Active Meeting Workspace ───────────────────────────────────────────────
function ActiveMeetingWorkspace() {
  const { bevel } = useGlass();
  const { textColor } = useTypography();
  const { FG } = useForeground();
  const [activeSubTab, setActiveSubTab] = useState<'Minutes' | 'Chat' | 'AI'>('Minutes');

  // Audio & AI States
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [isRecording, setIsRecording] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [generatedMinutes, setGeneratedMinutes] = useState<string>(
    'Press "Record Meeting" below. When stopped, Gemini 1.5 Flash processes the audio file directly and drafts comprehensive minutes here.'
  );

  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<{ sender: string, text: string }[]>([
    { sender: 'System', text: 'Meeting workspace active.' }
  ]);

  // ── RECORDING & LOCAL STORAGE ──
  const handleToggleRecord = async () => {
    if (isRecording) {
      setIsRecording(false);
      await audioRecorder.stop();
      const uri = audioRecorder.uri;

      if (uri) {
        // ✅ FIX: template literal needs backticks
        const newPath = `${documentDirectory}Meeting_${Date.now()}.m4a`;
        await copyAsync({ from: uri, to: newPath });

        // ✅ FIX: template literal needs backticks
        Alert.alert('Saved Locally', `Recording saved to: ${newPath.split('/').pop()}`);

        generateMinutesWithGemini(newPath);
      }
    } else {
      try {
        const { granted } = await AudioModule.requestRecordingPermissionsAsync();
        if (!granted) {
          Alert.alert('Permission denied', 'Microphone access is required to record meetings.');
          return;
        }
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await audioRecorder.prepareToRecordAsync();
        audioRecorder.record();
        setIsRecording(true);
      } catch (err) {
        console.error('Failed to start recording', err);
      }
    }
  };

  // ── GEMINI MULTIMODAL AUDIO SUMMARY ──
  const generateMinutesWithGemini = async (fileUri: string) => {
    setIsSummarizing(true);
    setActiveSubTab('Minutes');

    try {
      const base64Audio = await readAsStringAsync(fileUri, { encoding: EncodingType.Base64 });

      // ✅ FIX: template literal needs backticks
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: "Act as an executive meeting recorder. Transcribe and extract: 1. Executive Summary 2. Key Decisions 3. Attendees & Action Items. Return structured clear text as a summary so that even someone who never attended can get a clue." },
                { inlineData: { mimeType: "audio/mp4", data: base64Audio } }
              ]
            }]
          })
        }
      );

      const data = await response.json();
      const minutesText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      setGeneratedMinutes(minutesText || 'No content returned from AI.');
    } catch (e) {
      console.error('Gemini Error:', e);
      setGeneratedMinutes('Failed to process audio recording. Please verify your API key.');
    } finally {
      setIsSummarizing(false);
    }
  };

  // ── IN-MEETING CHAT & AI BOT RESEARCH ──
  const handleSendMessage = async () => {
    if (!chatInput.trim()) return;
    const userMsg = chatInput;
    setChatInput('');
    setChatMessages(prev => [...prev, { sender: 'You', text: userMsg }]);

    if (activeSubTab === 'AI') {
      setChatMessages(prev => [...prev, { sender: 'AI Assistant', text: 'Researching...' }]);
      try {
        // ✅ FIX: template literal needs backticks
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [{ text: `You are an in-meeting research chatbot. Provide a factual answer: ${userMsg}` }]
              }]
            })
          }
        );
        const data = await response.json();
        const botReply = data.candidates?.[0]?.content?.parts?.[0]?.text;

        setChatMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { sender: 'AI Assistant', text: botReply || 'No response.' };
          return updated;
        });
      } catch (error) {
        setChatMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { sender: 'AI Assistant', text: 'Connection failed.' };
          return updated;
        });
      }
    }
  };

  return (
    <View style={styles.workspaceContainer}>
      <View style={styles.workspaceHeader}>
        <TouchableOpacity
          style={[styles.recordBtn, isRecording ? styles.recordBtnActive : bevel]}
          onPress={handleToggleRecord}
        >
          <View style={[styles.recordDot, isRecording && styles.recordDotActive]} />
          <AppText style={[styles.recordText, { color: isRecording ? '#fff' : textColor }]}>
            {isRecording ? 'Recording Locally...' : 'Record Meeting'}
          </AppText>
        </TouchableOpacity>

        <View style={styles.attendeesRow}>
          <View style={[styles.miniAvatar, { backgroundColor: '#3b82f6', zIndex: 3 }]}><AppText style={styles.avatarTxt}>KM</AppText></View>
          <View style={[styles.miniAvatar, { backgroundColor: '#10b981', zIndex: 2, marginLeft: -10 }]}><AppText style={styles.avatarTxt}>JD</AppText></View>
          <View style={[styles.miniAvatar, { backgroundColor: '#f59e0b', zIndex: 1, marginLeft: -10 }]}><AppText style={styles.avatarTxt}>+2</AppText></View>
        </View>
      </View>

      <View style={styles.workspaceNav}>
        {(['Minutes', 'Chat', 'AI'] as const).map(t => (
          <TouchableOpacity
            key={t}
            onPress={() => setActiveSubTab(t)}
            style={[styles.workspaceTab, activeSubTab === t && styles.workspaceTabActive]}
          >
            <AppText style={[styles.workspaceTabText, activeSubTab === t && { color: COLORS.blue }]}>{t}</AppText>
          </TouchableOpacity>
        ))}
      </View>

      <View style={[styles.workspaceBody, bevel]}>
        {activeSubTab === 'Minutes' && (
          <ScrollView style={styles.scrollArea}>
            <AppText style={styles.sectionHeader}>Meeting Minutes & Action Items</AppText>
            {isSummarizing ? (
              <View style={{ padding: 20, alignItems: 'center' }}>
                <ActivityIndicator size="small" color={COLORS.blue} />
                <AppText style={{ color: COLORS.sub, marginTop: 10 }}>Gemini is analyzing the audio file...</AppText>
              </View>
            ) : (
              <AppText style={[styles.minutesText, { color: textColor }]}>{generatedMinutes}</AppText>
            )}
          </ScrollView>
        )}

        {(activeSubTab === 'Chat' || activeSubTab === 'AI') && (
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
            <ScrollView style={styles.scrollArea}>
              {chatMessages.map((msg, i) => (
                <View key={i} style={msg.sender === 'You' ? styles.chatBubbleRight : styles.chatBubbleLeft}>
                  <AppText style={styles.chatSender}>{msg.sender}</AppText>
                  <AppText style={styles.chatText}>{msg.text}</AppText>
                </View>
              ))}
            </ScrollView>

            <View style={styles.chatInputRow}>
              <TextInput
                style={[styles.chatInput, { color: textColor, backgroundColor: FG.glassBg }]}
                placeholder={activeSubTab === 'AI' ? 'Ask the research bot...' : 'Type a message...'}
                placeholderTextColor={COLORS.sub}
                value={chatInput}
                onChangeText={setChatInput}
                onSubmitEditing={handleSendMessage}
              />
              <TouchableOpacity onPress={handleSendMessage} style={styles.sendBtn}>
                <AppIcon name="send" size={16} color="#fff" />
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        )}
      </View>
    </View>
  );
}

// ─── Main Screen (Root Layout) ───────────────────────────────────────────────
export default function CalendarScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { FG } = useForeground();
  const { fontFamily, textColor } = useTypography();
  const { bevel, iconButton } = useGlass();

  const [tab, setTab] = useState<TabType>('Upcoming');
  const [query, setQuery] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);

  const searchAnim = useRef(new Animated.Value(0)).current;
  const searchRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!user?.uid) return;

    const unsubscribe = firestore()
      .collection('meetings')
      .where('participants', 'array-contains', user.uid)
      .orderBy('date', 'asc')
      .onSnapshot((snapshot) => {
        if (!snapshot) return;
        const fetched: Meeting[] = snapshot.docs.map(doc => {
          const data: any = doc.data();
          return {
            id: doc.id,
            title: data.title || 'Untitled',
            date: data.date ? data.date.toDate() : new Date(),
            duration: data.duration || '1h',
            participants: data.participants || [],
            members: data.members || [],
            organizerId: data.organizerId || '',
            organizerName: data.organizerName || '',
            type: data.type || 'online',
            reminders: data.reminders || [],
          };
        });
        setMeetings(fetched);
        setLoading(false);
      }, (error) => {
        console.error('Firestore Error:', error);
        setLoading(false);
      });

    return () => unsubscribe();
  }, [user?.uid]);

  const data = useMemo(() => {
    if (!query.trim()) return meetings;
    const q = query.toLowerCase();
    return meetings.filter((m) => m.title.toLowerCase().includes(q));
  }, [query, meetings]);

  const openSearch = () => {
    setSearchOpen(true);
    Animated.spring(searchAnim, { toValue: 1, useNativeDriver: false, friction: 7, tension: 60 })
      .start(() => searchRef.current?.focus());
  };
  const closeSearch = () => {
    setQuery('');
    Animated.spring(searchAnim, { toValue: 0, useNativeDriver: false, friction: 7, tension: 60 })
      .start(() => setSearchOpen(false));
  };

  const renderMeeting = useCallback(({ item }: { item: Meeting }) => (
    <MeetingRow
      item={item}
      bevel={bevel}
      textColor={textColor}
      fontFamily={fontFamily}
      FGsecondary={FG.secondary}
      currentUserId={user?.uid}
      onPress={() => console.log('Open Details', item.id)}
    />
  ), [bevel, textColor, fontFamily, FG.secondary, user?.uid]);

  return (
    <View style={styles.root}>
      <AppBg />

      <Modal visible={sheetOpen} transparent animationType="slide" onRequestClose={() => setSheetOpen(false)} statusBarTranslucent>
        <Pressable style={styles.overlay} onPress={() => setSheetOpen(false)} />
        <View style={styles.sheet}>
          <AppBg />
          <View style={styles.handle} />
          <NewMeetingSheet
            userId={user?.uid || ''}
            userName={user?.displayName || user?.email || 'Organizer'}
            onBack={() => setSheetOpen(false)}
            onDone={() => setSheetOpen(false)}
          />
        </View>
      </Modal>

      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.headerRow}>
          <AppText style={[styles.appName, { color: textColor, fontFamily }]}>Calendar</AppText>
          {!searchOpen && (
            <TouchableOpacity style={iconButton} onPress={openSearch} activeOpacity={0.8}>
              <AppIcon name="search-outline" size={20} color={COLORS.blue} />
            </TouchableOpacity>
          )}
        </View>

        {searchOpen && (
          <Animated.View style={[styles.searchBubble, { opacity: searchAnim, transform: [{ translateY: searchAnim.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }] }]}>
            <AppIcon name="search-outline" size={15} color={COLORS.sub} />
            <TextInput
              ref={searchRef}
              style={[styles.searchInput, { color: textColor }]}
              placeholder="Search meetings"
              placeholderTextColor={COLORS.sub}
              value={query}
              onChangeText={setQuery}
            />
            <TouchableOpacity onPress={closeSearch} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <AppIcon name="close-circle" size={18} color={COLORS.sub} />
            </TouchableOpacity>
          </Animated.View>
        )}
      </View>

      <View style={styles.tabBar}>
        {(['Upcoming', 'Past', 'Meetings'] as TabType[]).map((t) => {
          const active = tab === t;
          return active ? (
            <TouchableOpacity key={t} onPress={() => setTab(t)} activeOpacity={0.85}>
              <LinearGradient colors={GRADIENTS.primary} style={styles.tabPillActive}>
                <AppText style={styles.tabLabelActive}>{t}</AppText>
              </LinearGradient>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity key={t} style={[styles.tabPillInactive, bevel]} onPress={() => setTab(t)} activeOpacity={0.7}>
              <AppText style={[styles.tabLabel, { color: FG.secondary }]}>{t}</AppText>
            </TouchableOpacity>
          );
        })}
      </View>
   <View style={{ flex: 1 }}>
      {tab === 'Meetings' ? (
        <ActiveMeetingWorkspace />
      ) : loading ? (
        <View style={styles.emptyWrap}>
          <ActivityIndicator size="large" color={COLORS.blue} />
          <AppText style={styles.emptyText}>Syncing Calendar...</AppText>
        </View>
      ) : (
        <FlatList
          data={data}
          keyExtractor={(item) => item.id}
          renderItem={renderMeeting}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <AppIcon name="calendar-outline" size={52} color={COLORS.sub} />
              <AppText style={styles.emptyText}>No {tab.toLowerCase()} meetings found</AppText>
            </View>
          }
        />
      )}
</View>
      {tab !== 'Meetings' && (
        <TouchableOpacity
          style={[styles.fab, bevel, { bottom: insets.bottom + 150 }, Platform.OS === 'web' && styles.fabWeb]}
          activeOpacity={0.85}
          onPress={() => setSheetOpen(true)}
        >
          <AppIcon name="add" size={28} color={COLORS.blue} fixedColor />
        </TouchableOpacity>
      )}
 
      <BottomNav active="calender" />
    </View>
    
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.sky1 },
  header: { flexDirection: 'column', paddingHorizontal: 14, paddingBottom: 10, gap: 8 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  appName: { fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  searchBubble: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(30,156,240,0.06)', borderWidth: 1, borderColor: 'rgba(30,156,240,0.18)', borderRadius: RADIUS.full, paddingHorizontal: 14, height: 42 },
  searchInput: { flex: 1, fontSize: 14, padding: 0 },
  tabBar: { flexDirection: 'row', paddingHorizontal: 14, marginBottom: 10, gap: 6 },
  tabPillActive: { paddingHorizontal: 22, paddingVertical: 9, borderRadius: RADIUS.full, ...SHADOW.button },
  tabPillInactive: { paddingHorizontal: 22, paddingVertical: 9, borderRadius: RADIUS.full },
  tabLabel: { fontSize: 14, fontWeight: '600' },
  tabLabelActive: { fontSize: 14, fontWeight: '700', color: '#fff' },
  listContent: { paddingHorizontal: 14, paddingBottom: 110 },

  meetingCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: RADIUS.lg, paddingHorizontal: 14, paddingVertical: 14 },
  timeBlock: { alignItems: 'center', minWidth: 50 },
  timeText: { fontSize: 16, fontWeight: '700' },
  amPmText: { fontSize: 11, fontWeight: '600', color: COLORS.sub },
  cardDivider: { width: 3, height: '100%', borderRadius: 2, opacity: 0.8 },
  meetingDetails: { flex: 1, gap: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  meetingTitle: { fontSize: 15, fontWeight: '700', flexShrink: 1 },
  organizerBadge: { backgroundColor: 'rgba(30,156,240,0.15)', paddingHorizontal: 7, paddingVertical: 2, borderRadius: RADIUS.full },
  organizerBadgeText: { fontSize: 9, fontWeight: '800', color: COLORS.blue, textTransform: 'uppercase' },
  meetingMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  meetingMetaText: { fontSize: 12 },
  actionArrow: { paddingLeft: 8 },

  fab: { position: 'absolute', right: 20, width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  fabWeb: { right: 16 },

  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '85%', borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: 'hidden', ...SHADOW.glow },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(30,156,240,0.30)', marginTop: 10, marginBottom: 4 },
  sheetSubHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
  iconPad: { padding: 4 },
  sheetTitle: { flex: 1, fontSize: 17, fontWeight: '700' },
  nextBtnGrad: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: RADIUS.full, ...SHADOW.button },
  nextBtnText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  sheetContent: { paddingHorizontal: 14, paddingBottom: 40, paddingTop: 10 },
  inputLabel: { fontSize: 12, fontWeight: '600', color: COLORS.sub, marginLeft: 4, marginBottom: 6, marginTop: 14 },
  glassInput: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: RADIUS.md, paddingHorizontal: 14, paddingVertical: 12 },
  inputField: { flex: 1, fontSize: 14, padding: 0 },

  // ✅ Member chips
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(30,156,240,0.10)', borderWidth: 1, borderColor: 'rgba(30,156,240,0.22)', borderRadius: RADIUS.full, paddingHorizontal: 10, paddingVertical: 6, maxWidth: '100%' },
  chipText: { fontSize: 12, fontWeight: '600', color: COLORS.blue, maxWidth: 140 },

  // ✅ Contact picker rows
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: RADIUS.md, paddingHorizontal: 12, paddingVertical: 10 },
  contactRowActive: { borderWidth: 1, borderColor: 'rgba(30,156,240,0.45)' },
  contactAvatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  contactName: { fontSize: 14, fontWeight: '700' },
  contactSub: { fontSize: 12, color: COLORS.sub, marginTop: 2 },
  checkbox: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: COLORS.sub, alignItems: 'center', justifyContent: 'center' },
  checkboxOn: { backgroundColor: COLORS.blue, borderColor: COLORS.blue },

  autoReminderInfo: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16, padding: 14, borderRadius: RADIUS.md },
  autoReminderTitle: { fontSize: 13, fontWeight: '700' },
  autoReminderSub: { fontSize: 11, color: COLORS.sub, marginTop: 2 },
  emptyWrap: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyText: { fontSize: 15, color: COLORS.sub },

  // ── Advanced Workspace Styles ──
  workspaceContainer: { flex: 1, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 90 },
  workspaceHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 },
  recordBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20 },
  recordBtnActive: { backgroundColor: '#ef4444' },
  recordDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: COLORS.sub },
  recordDotActive: { backgroundColor: '#fff' },
  recordText: { fontSize: 14, fontWeight: '700' },
  attendeesRow: { flexDirection: 'row' },
  miniAvatar: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: COLORS.sky1 },
  avatarTxt: { color: '#fff', fontSize: 10, fontWeight: '700' },
  workspaceNav: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 10 },
  workspaceTab: { paddingBottom: 8, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  workspaceTabActive: { borderBottomColor: COLORS.blue },
  workspaceTabText: { fontSize: 14, fontWeight: '600', color: COLORS.sub },
  workspaceBody: { flex: 1, borderRadius: RADIUS.lg, padding: 14 },
  scrollArea: { flex: 1 },
  sectionHeader: { fontSize: 12, fontWeight: '700', color: COLORS.sub, textTransform: 'uppercase', marginBottom: 10 },
  minutesText: { fontSize: 14, lineHeight: 24, marginBottom: 6 },
  chatInputRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  chatInput: { flex: 1, borderRadius: 20, paddingHorizontal: 15, paddingVertical: 10, fontSize: 14 },
  sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: COLORS.blue, alignItems: 'center', justifyContent: 'center' },
  chatBubbleRight: { alignSelf: 'flex-end', backgroundColor: 'rgba(30,156,240,0.15)', padding: 10, borderRadius: 15, borderBottomRightRadius: 2, marginBottom: 8, maxWidth: '80%' },
  chatBubbleLeft: { alignSelf: 'flex-start', backgroundColor: 'rgba(150,150,150,0.1)', padding: 10, borderRadius: 15, borderBottomLeftRadius: 2, marginBottom: 8, maxWidth: '80%' },
  chatSender: { fontSize: 10, fontWeight: '700', color: COLORS.sub, marginBottom: 2 },
  chatText: { fontSize: 14, color: COLORS.text },
});