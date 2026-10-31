// ─── Typed REST endpoint surface ─────────────────────────────────────────────
// Thin typed wrappers over ApiClient. Methods are added slice by slice as the
// corresponding backend routes land. Slice 0 ships the health check and the
// current-user fetch so the client layer can be exercised end to end.

import { apiClient, type ApiClient } from './client';
import type { ApiResult } from './errors';

export interface HealthResponse {
  status: string;
  dependencies: { postgres: boolean; redis: boolean };
}

export interface BusinessAddressDTO {
  street: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
}

export type WorkScheduleDTO = Record<string, { open: string; close: string }>;

/** Catalog item as stored on the backend; `imageUri` holds a media OBJECT KEY. */
export interface CatalogItemDTO {
  id: string;
  name: string;
  price: string;
  description?: string | null;
  imageUri?: string | null;
  collectionId?: string | null;
  [extra: string]: unknown;
}

export interface CatalogCollectionDTO {
  id: string;
  name: string;
  emoji?: string | null;
  createdAt?: number;
  [extra: string]: unknown;
}

/** Business-profile fields (old Firestore user doc fields). */
export interface BusinessProfileDTO {
  industry: string | null;
  address: BusinessAddressDTO | null;
  workSchedule: WorkScheduleDTO | null;
  timezone: string | null;
  catalogItems: CatalogItemDTO[];
  catalogCollections: CatalogCollectionDTO[];
}

export interface MeResponse extends BusinessProfileDTO {
  id: string;
  phoneNumber: string | null;
  displayName: string | null;
  about: string | null;
  avatarObjectKey: string | null;
  email: string | null;
  website: string | null;
  catalog: string | null;
  operationalHours: string | null;
  accountType: string;
  autoResponderEnabled: boolean;
  autoResponderMessage: string | null;
  /** True when this user has been reported and must verify before using the app. */
  requiresVerification: boolean;
  /** Canonical identity state, changed only by the backend. */
  identityVerified: boolean;
  identityVerifiedAt: string | null;
  /** Owner-only generation used to bind a face proof to the current report. */
  verificationGeneration: string | null;
}

export interface PublicUserProfile extends BusinessProfileDTO {
  id: string;
  phoneNumber: string | null;
  displayName: string | null;
  about: string | null;
  /** Null when the user hides their photo or has blocked the viewer. */
  avatarObjectKey: string | null;
  accountType: string;
  email: string | null;
  website: string | null;
  operationalHours: string | null;
  /** Safe public status only; report details remain private. */
  identityVerified: boolean;
  /** The target's privacy choices the app needs (group adds, photo, last seen). */
  privacy: { groups: Visibility; profilePhoto: Visibility; lastSeen: Visibility };
  /** The viewer has blocked this user. */
  iBlocked: boolean;
  /** This user has blocked the viewer. */
  blockedMe: boolean;
}

export interface ProfilePatch {
  displayName?: string | null;
  about?: string | null;
  avatarObjectKey?: string | null;
  email?: string | null;
  website?: string | null;
  catalog?: string | null;
  operationalHours?: string | null;
  industry?: string | null;
  address?: BusinessAddressDTO | null;
  workSchedule?: WorkScheduleDTO | null;
  /** IANA zone used to evaluate working hours for the auto-responder. */
  timezone?: string | null;
  autoResponderEnabled?: boolean;
  autoResponderMessage?: string | null;
  catalogItems?: CatalogItemDTO[];
  catalogCollections?: CatalogCollectionDTO[];
}

export type Visibility = 'Everyone' | 'Contacts' | 'Nobody';

export interface PrivacySettings {
  lastSeen: Visibility;
  profilePhoto: Visibility;
  statusVisibility: Visibility;
  groups: Visibility;
  calls: Visibility;
  readReceipts: boolean;
  disappearingMessages: boolean;
}

export interface BlockedContact {
  userId: string;
  displayName: string | null;
  photoObjectKey: string | null;
  phone: string | null;
  blockedAt: string;
  lastSeenAtBlock: string | null;
}

export interface MatchedContact {
  userId: string;
  phoneNumber: string | null;
  displayName: string | null;
  avatarObjectKey: string | null;
}

export function createEndpoints(client: ApiClient = apiClient) {
  return {
    health: (): Promise<ApiResult<HealthResponse>> => client.get('/health'),

    // ── Account registration ──
    /**
     * The only endpoint that creates a self-registered user row. `receipt` is
     * Django's signed proof that FaceAISDK enrollment + live verification
     * passed; the phone comes from the verified Firebase token, not this body.
     */
    registerSelf: (
      receipt: string,
      profile: Pick<ProfilePatch, 'displayName' | 'email' | 'website' | 'about'>,
    ): Promise<ApiResult<MeResponse & { alreadyRegistered: boolean }>> =>
      client.post('/me/register', { receipt, profile }),

    // ── Profile (Req 4.2, 4.3, 4.6) ──
    getMe: (): Promise<ApiResult<MeResponse>> => client.get('/me'),
    updateMe: (patch: ProfilePatch): Promise<ApiResult<MeResponse>> => client.patch('/me', patch),
    updatePhone: (phoneNumber: string): Promise<ApiResult<{ phoneNumber: string }>> =>
      client.put('/me/phone', { phoneNumber }),
    getUser: (userId: string): Promise<ApiResult<PublicUserProfile>> =>
      client.get(`/users/${encodeURIComponent(userId)}`),

    // ── Moderation: report a user / verify self ──
    /** Report a user — they must verify before using the app again. */
    reportUser: (userId: string): Promise<ApiResult<{
      ok: true;
      identityVerified: false;
      alreadyReported: boolean;
    }>> => client.post('/reports', { userId }),
    /** Finalize only with Django's signed liveness + stored-face-match receipt. */
    verifySelf: (receipt: string): Promise<ApiResult<{
      ok: true;
      verified: true;
      identityVerified: true;
      identityStatus: 'verified';
      verifiedAt: string | null;
      userId: string;
    }>> => client.post('/me/verify', { receipt }),

    // ── Privacy (Req 4.9, 4.10) ──
    getPrivacy: (): Promise<ApiResult<PrivacySettings>> => client.get('/me/privacy'),
    updatePrivacy: (settings: PrivacySettings): Promise<ApiResult<PrivacySettings>> =>
      client.put('/me/privacy', settings),

    // ── Blocks (Req 4.11, 4.12) ──
    listBlocks: (): Promise<ApiResult<{ blocked: BlockedContact[] }>> => client.get('/blocks'),
    blockUser: (
      userId: string,
      meta?: { displayName?: string | null; photoObjectKey?: string | null; phone?: string | null },
    ): Promise<ApiResult<{ ok: true }>> => client.post('/blocks', { userId, ...meta }),
    unblockUser: (userId: string): Promise<ApiResult<{ ok: true }>> =>
      client.delete(`/blocks/${encodeURIComponent(userId)}`),

    // ── Contacts (Req 4.4, 4.5) ──
    matchContacts: (phones: string[]): Promise<ApiResult<{ matches: MatchedContact[] }>> =>
      client.post('/contacts/match', { phones }),

    // ── Push tokens (Req 4.7, 4.8) ──
    registerPushToken: (
      token: string,
      platform?: string | null,
      deviceId?: string | null,
    ): Promise<ApiResult<{ ok: true }>> =>
      client.post('/push-tokens', { token, platform, deviceId: deviceId ?? null }),
    removePushToken: (token: string): Promise<ApiResult<{ ok: true }>> =>
      client.delete(`/push-tokens/${encodeURIComponent(token)}`),

    // ── Chats & messages (Req 5) ──
    listChats: (): Promise<ApiResult<{ chats: ChatSummary[]; totalUnread: number }>> =>
      client.get('/chats'),
    createChat: (
      input: { type: 'direct'; members: [string] } | { type: 'group'; members: string[]; groupName: string; groupPhotoObjectKey?: string },
    ): Promise<ApiResult<{ chatId: string; type: 'direct' | 'group' }>> => client.post('/chats', input),
    updateChat: (
      chatId: string,
      patch: { groupName?: string; groupPhotoObjectKey?: string | null; addMembers?: string[]; removeMembers?: string[] },
    ): Promise<ApiResult<{ ok: true }>> => client.patch(`/chats/${chatId}`, patch),
    listMessages: (
      chatId: string,
      opts: { cursor?: string; limit?: number; after?: string } = {},
    ): Promise<ApiResult<{ messages: BackendMessage[]; nextCursor: string | null }>> =>
      client.get(`/chats/${chatId}/messages`, { query: opts }),
    sendMessage: (chatId: string, input: SendMessageInput): Promise<ApiResult<{ message: BackendMessage }>> =>
      client.post(`/chats/${chatId}/messages`, input),
    deleteMessage: (
      chatId: string,
      messageId: string,
      scope: 'everyone' | 'me',
    ): Promise<ApiResult<{ ok: true }>> =>
      client.post(`/chats/${chatId}/messages/${messageId}/delete`, { scope }),
    editMessage: (
      chatId: string,
      messageId: string,
      text: string,
    ): Promise<ApiResult<{ message: BackendMessage }>> =>
      client.patch(`/chats/${chatId}/messages/${messageId}`, { text }),
    forwardMessage: (
      messageId: string,
      targetChatIds: string[],
    ): Promise<ApiResult<{ forwarded: number; messageIds: string[] }>> =>
      client.post('/messages/forward', { messageId, targetChatIds }),
    /** Clear a chat for the caller only (others keep their messages). */
    clearChat: (chatId: string): Promise<ApiResult<{ chatId: string; clearedAt: string }>> =>
      client.post(`/chats/${chatId}/clear`),
    /** Leave a group (any member). */
    leaveChat: (chatId: string): Promise<ApiResult<{ ok: true }>> => client.post(`/chats/${chatId}/leave`),
    listPastMembers: (chatId: string): Promise<ApiResult<{ pastMembers: PastMemberDTO[] }>> =>
      client.get(`/chats/${chatId}/past-members`),

    // ── Presence / last seen (Req 7.4, 7.5) ──
    getPresence: (userId: string): Promise<ApiResult<PresenceResponse>> =>
      client.get(`/presence/${encodeURIComponent(userId)}`),

    // ── Calls & meetings (Req 8) ──
    createCall: (
      callId: string,
      calleeId: string,
      callerInfo: CallParticipantDTO,
      calleeInfo: CallParticipantDTO,
      type: 'audio' | 'video',
    ): Promise<ApiResult<{ callId: string }>> =>
      client.post('/calls', { callId, calleeId, callerInfo, calleeInfo, type }),
    endCall: (callId: string): Promise<ApiResult<{ ok: true }>> =>
      client.post(`/calls/${encodeURIComponent(callId)}/end`),
    callHistory: (
      opts: { cursor?: string; limit?: number } = {},
    ): Promise<ApiResult<{ items: CallHistoryDTO[]; nextCursor: string | null }>> =>
      client.get('/calls/history', { query: opts }),
    clearCallHistory: (): Promise<ApiResult<{ ok: true }>> => client.delete('/calls/history'),
    /** Mark call history as seen so the Calls tab badge clears. */
    markCallsSeen: (): Promise<ApiResult<{ ok: true }>> => client.post('/calls/history/seen'),
    /** Schedule a meeting; invitees get a chat invitation + push. */
    createMeeting: (input: CreateMeetingInput): Promise<ApiResult<{ meetingId: string; state: MeetingStateDTO }>> =>
      client.post('/meetings', input),
    getMeeting: (meetingId: string): Promise<ApiResult<{ state: MeetingStateDTO }>> =>
      client.get(`/meetings/${meetingId}`),
    listMeetings: (): Promise<ApiResult<{ meetings: MeetingListItem[] }>> =>
      client.get('/meetings'),
    // ── Venue search (in-person meetings) ──
    placesAutocomplete: (
      q: string,
      sessionToken?: string,
    ): Promise<ApiResult<{ results: PlaceResult[] }>> =>
      client.get('/places/autocomplete', { query: { q, sessionToken } }),
    placeDetails: (
      placeId: string,
      sessionToken?: string,
    ): Promise<ApiResult<{ place: PlaceResult | null }>> =>
      client.get('/places/details', { query: { placeId, sessionToken } }),
    addMeetingParticipants: (
      meetingId: string,
      userIds: string[],
      organizerName?: string | null,
    ): Promise<ApiResult<{ added: string[] }>> =>
      client.post(`/meetings/${encodeURIComponent(meetingId)}/participants`, { userIds, organizerName }),
    getMeetingMessages: (meetingId: string): Promise<ApiResult<{ messages: MeetingMessage[] }>> =>
      client.get(`/meetings/${encodeURIComponent(meetingId)}/messages`),
    sendMeetingMessage: (
      meetingId: string,
      body: { text?: string; mediaObjectKey?: string | null; isSystem?: boolean; senderName?: string | null },
    ): Promise<ApiResult<{ message: { id: string; createdAt: string } }>> =>
      client.post(`/meetings/${encodeURIComponent(meetingId)}/messages`, body),
    saveMeetingMinutes: (meetingId: string, minutes: string): Promise<ApiResult<{ ok: true }>> =>
      client.put(`/meetings/${encodeURIComponent(meetingId)}/minutes`, { minutes }),
    setMeetingRecordingState: (
      meetingId: string,
      isRecording: boolean,
    ): Promise<ApiResult<{ isRecording: boolean }>> =>
      client.put(`/meetings/${encodeURIComponent(meetingId)}/recording-state`, { isRecording }),
    /** Register an uploaded recording (object key); minutes are generated in the background. */
    addMeetingRecording: (
      meetingId: string,
      body: { objectKey: string; durationMs: number; autoSummarize?: boolean },
    ): Promise<ApiResult<{ recording: MeetingRecordingDTO; summarizing: boolean }>> =>
      client.post(`/meetings/${encodeURIComponent(meetingId)}/recordings`, body),
    listMeetingRecordings: (meetingId: string): Promise<ApiResult<{ recordings: MeetingRecordingDTO[] }>> =>
      client.get(`/meetings/${encodeURIComponent(meetingId)}/recordings`),
    /** (Re)generate AI minutes for a recording. Can take a few minutes. */
    summarizeMeetingRecording: (
      meetingId: string,
      recordingId: string,
    ): Promise<ApiResult<{ minutes: string }>> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6 * 60 * 1000);
      return client
        .post<{ minutes: string }>(
          `/meetings/${encodeURIComponent(meetingId)}/recordings/${encodeURIComponent(recordingId)}/summarize`,
          undefined,
          { signal: controller.signal },
        )
        .finally(() => clearTimeout(timer));
    },
    endMeeting: (meetingId: string): Promise<ApiResult<{ ok: true }>> =>
      client.post(`/meetings/${encodeURIComponent(meetingId)}/end`),

    // ── Status & broadcasts (Req 9) ──
    listStatuses: (): Promise<ApiResult<{ myStatuses: BackendStatus[]; contactStatuses: StatusGroupDTO[] }>> =>
      client.get('/statuses'),
    createStatus: (input: CreateStatusInput): Promise<ApiResult<{ statusId: string }>> =>
      client.post('/statuses', input),
    viewStatus: (statusId: string): Promise<ApiResult<{ ok: true }>> =>
      client.post(`/statuses/${statusId}/view`),
    deleteStatus: (statusId: string): Promise<ApiResult<{ ok: true; mediaObjectKey: string | null }>> =>
      client.delete(`/statuses/${statusId}`),
    listBroadcasts: (): Promise<ApiResult<{ lists: BroadcastListDTO[] }>> => client.get('/broadcasts'),
    createBroadcast: (name: string, recipients: string[]): Promise<ApiResult<{ id: string }>> =>
      client.post('/broadcasts', { name, recipients }),
    updateBroadcast: (
      id: string,
      patch: { name?: string; recipients?: string[] },
    ): Promise<ApiResult<{ ok: true }>> => client.patch(`/broadcasts/${id}`, patch),
    deleteBroadcast: (id: string): Promise<ApiResult<{ ok: true }>> =>
      client.delete(`/broadcasts/${id}`),
    sendBroadcast: (
      id: string,
      body: { type?: string; text?: string | null; mediaObjectKey?: string | null },
    ): Promise<ApiResult<{ sent: number; skipped: string[] }>> =>
      client.post(`/broadcasts/${id}/send`, body),

    // ── Polls ──
    votePoll: (
      chatId: string,
      messageId: string,
      optionId: string,
    ): Promise<ApiResult<{ message: BackendMessage }>> =>
      client.post(`/chats/${chatId}/messages/${messageId}/vote`, { optionId }),

    // ── Chat mute ──
    listMutedChats: (): Promise<ApiResult<{ chatIds: string[] }>> => client.get('/me/muted-chats'),
    setChatMuted: (
      chatId: string,
      muted: boolean,
      mutedUntil?: string | null,
    ): Promise<ApiResult<{ chatId: string; muted: boolean; mutedUntil: string | null }>> =>
      client.put(`/chats/${chatId}/mute`, { muted, mutedUntil: mutedUntil ?? null }),

    // ── Profile views ──
    recordProfileView: (viewedUid: string): Promise<ApiResult<{ ok: true }>> =>
      client.post('/profile-views', { viewedUid }),
    getProfileViews: (): Promise<ApiResult<ProfileViewCountersDTO>> => client.get('/me/profile-views'),

    // ── Message analytics ──
    getMessageStats: (): Promise<ApiResult<MessageStatsDTO>> => client.get('/me/message-stats'),

    // ── Linked / companion devices ──
    createDeviceLink: (input: {
      requestId: string;
      displayCode: string;
      requesterUid?: string | null;
      deviceId: string;
      deviceName?: string | null;
      deviceType?: 'phone' | 'tablet' | 'desktop' | 'web';
      os?: string | null;
      platform?: 'ios' | 'android' | 'web';
    }): Promise<ApiResult<{ requestId: string; displayCode: string }>> =>
      client.post('/device-links', input),
    getDeviceLink: (
      requestId: string,
    ): Promise<ApiResult<{ consumed: boolean; expired: boolean; ownerUid: string | null; customToken: string | null }>> =>
      client.get(`/device-links/${encodeURIComponent(requestId)}`),
    findDeviceLinkByCode: (code: string): Promise<ApiResult<{ requestId: string | null }>> =>
      client.get('/device-links', { query: { code } }),
    claimDeviceLink: (requestId: string, ownerName?: string | null): Promise<ApiResult<{ success: boolean }>> =>
      client.post('/device-links/claim', { requestId, ownerName }),
    listDevices: (): Promise<ApiResult<{ devices: LinkedDeviceDTO[] }>> => client.get('/me/devices'),
    registerDevice: (device: {
      deviceId: string; name: string;
      type?: 'phone' | 'tablet' | 'desktop' | 'web';
      os?: string; platform?: 'ios' | 'android' | 'web';
    }): Promise<ApiResult<{ ok: true }>> => client.post('/me/devices', device),
    touchDevice: (deviceId: string): Promise<ApiResult<{ ok: true }>> =>
      client.post(`/me/devices/${encodeURIComponent(deviceId)}/touch`),
    removeDevice: (deviceId: string): Promise<ApiResult<{ ok: true }>> =>
      client.delete(`/me/devices/${encodeURIComponent(deviceId)}`),
    removeOtherDevices: (keep: string): Promise<ApiResult<{ ok: true }>> =>
      client.delete('/me/devices', { query: { keep } }),

  // ─── Multi-agent / business ──
  listBusinesses: (): Promise<ApiResult<{ businesses: BusinessDTO[] }>> => client.get('/businesses'),
  createBusiness: (input: {
    name: string;
    plan?: 'free' | 'pro' | 'enterprise';
    autoAssign?: boolean;
    routingStrategy?: 'round-robin' | 'least-active' | 'manual';
  }): Promise<ApiResult<{ business: BusinessDTO }>> => client.post('/businesses', input),
    getBusiness: (id: string): Promise<ApiResult<{ business: BusinessDTO }>> =>
      client.get(`/businesses/${encodeURIComponent(id)}`),
    updateBusiness: (
      id: string,
      patch: Partial<{ name: string; plan: 'free' | 'pro' | 'enterprise'; autoAssign: boolean; routingStrategy: 'round-robin' | 'least-active' | 'manual' }>,
    ): Promise<ApiResult<{ business: BusinessDTO | null }>> =>
      client.patch(`/businesses/${encodeURIComponent(id)}`, patch),
    getAgentInfo: (): Promise<ApiResult<{ role: 'customer' | 'agent' | 'admin'; agentStatus: 'available' | 'busy' | 'away' | null }>> =>
      client.get('/me/agent'),
    setRole: (role: 'customer' | 'agent' | 'admin'): Promise<ApiResult<{ role: string }>> =>
      client.put('/me/role', { role }),
    setAgentStatus: (status: 'available' | 'busy' | 'away' | null): Promise<ApiResult<{ status: string | null }>> =>
      client.put('/me/agent-status', { status }),
    listInternalNotes: (chatId: string): Promise<ApiResult<{ notes: InternalNoteDTO[] }>> =>
      client.get(`/chats/${encodeURIComponent(chatId)}/notes`),
    addInternalNote: (chatId: string, text: string): Promise<ApiResult<{ note: InternalNoteDTO }>> =>
      client.post(`/chats/${encodeURIComponent(chatId)}/notes`, { text }),

    // ── Synced contacts (companion devices show the owner's phone book) ──
    listSyncedContacts: (): Promise<ApiResult<{ contacts: SyncedContactDTO[] }>> =>
      client.get('/me/synced-contacts'),
    replaceSyncedContacts: (contacts: SyncedContactDTO[]): Promise<ApiResult<{ saved: number }>> =>
      client.put('/me/synced-contacts', { contacts }),

    // ── Chat labels ──
    listChatLabels: (): Promise<ApiResult<{ labels: ChatLabelDTO[] }>> => client.get('/me/chat-labels'),
    createChatLabel: (input: {
      title: string;
      memberIds: string[];
      groupIds: string[];
    }): Promise<ApiResult<{ label: ChatLabelDTO }>> => client.post('/me/chat-labels', input),
    updateChatLabel: (
      labelId: string,
      patch: { title?: string; memberIds?: string[]; groupIds?: string[] },
    ): Promise<ApiResult<{ label: ChatLabelDTO }>> =>
      client.patch(`/me/chat-labels/${encodeURIComponent(labelId)}`, patch),
    deleteChatLabel: (labelId: string): Promise<ApiResult<{ ok: true }>> =>
      client.delete(`/me/chat-labels/${encodeURIComponent(labelId)}`),
  };
}

export interface PastMemberDTO {
  userId: string;
  displayName: string | null;
  leftAt: string;
}

export interface SyncedContactDTO {
  phone: string;
  displayName: string;
  userId: string | null;
  isSaved: boolean;
  avatarObjectKey: string | null;
}

export interface ChatLabelDTO {
  id: string;
  title: string;
  memberIds: string[];
  groupIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateMeetingInput {
  title: string;
  participants: string[];
  /** ISO-8601 start/end. */
  startsAt: string;
  endsAt: string;
  type?: 'online' | 'in-person';
  reminders?: number[];
  /** Shown in the invitation ("You're invited … by {organizerName}"). */
  organizerName?: string | null;
  /** In-person venue (a real searched place). Ignored when type is 'online'. */
  location?: MeetingLocationDTO | null;
}

export interface MeetingStateDTO {
  id: string;
  title: string;
  organizerId: string;
  isActive: boolean;
  isRecording: boolean;
  endedAt: string | null;
  createdAt: string;
  startsAt: string;
  endsAt: string;
  type: 'online' | 'in-person';
  location: MeetingLocationDTO | null;
  reminders: number[];
  minutes: string | null;
  minutesGeneratedAt: string | null;
  participants: string[];
  joinedMembers: string[];
  attendees: string[];
  mutedUsers: string[];
  kickedUsers: string[];
  recordingCount: number;
}

export interface MeetingRecordingDTO {
  id: string;
  meetingId: string;
  objectKey: string;
  /** Short-lived playback URL. */
  url: string;
  durationMs: number;
  createdBy: string | null;
  status: 'uploaded' | 'processing' | 'done' | 'failed';
  minutes: string | null;
  error: string | null;
  createdAt: string;
}

export interface BackendStatus {
  statusId: string;
  userId: string;
  displayName: string | null;
  userPhone: string | null;
  mediaObjectKey: string | null;
  thumbnailObjectKey: string | null;
  mediaType: 'image' | 'video' | 'text';
  caption: string | null;
  backgroundColor: string | null;
  textColor: string | null;
  durationMs: number | null;
  visibility: 'everyone' | 'contacts' | 'except' | 'only';
  createdAt: string;
  expiresAt: string;
  viewedBy: string[];
}

export interface StatusGroupDTO {
  userId: string;
  displayName: string | null;
  hasUnviewed: boolean;
  statuses: BackendStatus[];
}

export interface CreateStatusInput {
  displayName?: string | null;
  userPhone?: string | null;
  mediaObjectKey?: string | null;
  thumbnailObjectKey?: string | null;
  mediaType: 'image' | 'video' | 'text';
  caption?: string | null;
  backgroundColor?: string | null;
  textColor?: string | null;
  durationMs?: number | null;
  visibility?: 'everyone' | 'contacts' | 'except' | 'only';
  excludedUsers?: string[];
  selectedUsers?: string[];
}

export interface BroadcastListDTO {
  id: string;
  name: string;
  recipients: string[];
  createdBy: string;
  createdAt: string;
  lastSentAt: string | null;
  lastMessage: string | null;
}

export interface CallParticipantDTO {
  userId: string;
  displayName: string;
  photoUrl: string | null;
}

export interface CallHistoryDTO {
  callId: string;
  otherParty: CallParticipantDTO;
  type: 'audio' | 'video';
  direction: 'incoming' | 'outgoing';
  status: string;
  durationSec: number | null;
  timestamp: string;
  seen: boolean;
}

export interface PresenceResponse {
  userId: string;
  online: boolean;
  lastSeen: string | null;
  lastSeenVisible: boolean;
}

export interface ChatSummary {
  chatId: string;
  type: 'direct' | 'group';
  groupName: string | null;
  groupPhotoObjectKey: string | null;
  members: string[];
  lastMessage: string | null;
  lastSenderId: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  role: 'admin' | 'member';
  /** The caller's "clear chat" cutoff; older messages are hidden for them. */
  clearedAt: string | null;
}

export type BackendMessageType =
  | 'text'
  | 'image'
  | 'voice'
  | 'video'
  | 'file'
  | 'location'
  | 'system'
  | 'catalog'
  | 'poll'
  | 'order'
  | 'contact'
  | 'meeting';

export interface MeetingLocationDTO {
  name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  placeId?: string | null;
}

/** Rich meeting-invite card payload embedded in a 'meeting' message. */
export interface MeetingCardPayload {
  meetingId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  venue: 'online' | 'in-person';
  joinUrl: string;
  organizerName?: string | null;
  location?: MeetingLocationDTO | null;
}

/** A real place returned by the venue search proxy (Google or OSM). */
export interface PlaceResult {
  placeId: string;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
}

export interface PollPayload {
  question: string;
  options: { id: string; text: string }[];
  multiple: boolean;
  votes?: Record<string, string[]>;
}

export interface OrderPayload {
  items: { id: string; name: string; price: string; imageObjectKey: string | null; quantity: number }[];
  total: string | null;
  currency: string;
}

export interface ContactPayload {
  name: string;
  phone: string;
  userId: string | null;
  registered?: boolean;
  photoObjectKey?: string | null;
  contacts?: {
    name: string; phone: string; userId: string | null;
    registered?: boolean; photoObjectKey?: string | null;
  }[];
}

export interface BackendMessage {
  id: string;
  chatId: string;
  senderId: string;
  clientId: string | null;
  type: BackendMessageType;
  text: string | null;
  mediaObjectKey: string | null;
  thumbnailObjectKey: string | null;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  durationMs: number | null;
  location: unknown;
  catalogItem: unknown;
  replyTo: unknown;
  subtype: string | null;
  poll: PollPayload | null;
  order: OrderPayload | null;
  contact: ContactPayload | null;
  meeting: MeetingCardPayload | null;
  createdAt: string;
  expiresAt: string;
  deletedForEveryone: boolean;
  deliveredTo: string[];
  readBy: string[];
  edited: boolean;
  editedAt: string | null;
}

export interface SendMessageInput {
  clientId?: string;
  type: BackendMessageType;
  text?: string | null;
  mediaObjectKey?: string | null;
  thumbnailObjectKey?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  mimeType?: string | null;
  durationMs?: number | null;
  location?: unknown;
  catalogItem?: unknown;
  replyTo?: unknown;
  subtype?: string | null;
  poll?: PollPayload;
  order?: OrderPayload;
  contact?: ContactPayload;
  meeting?: MeetingCardPayload;
}

export interface LinkedDeviceDTO {
  id: string;
  name: string;
  type: 'phone' | 'tablet' | 'desktop' | 'web';
  os: string;
  platform: 'ios' | 'android' | 'web';
  linkedAt: string;
  lastActiveAt: string;
}

export interface BusinessDTO {
  businessId: string;
  name: string;
  ownerId: string;
  agents: string[];
  plan: 'free' | 'pro' | 'enterprise';
  createdAt: string;
  settings: { autoAssign: boolean; routingStrategy: 'round-robin' | 'least-active' | 'manual' };
}

export interface InternalNoteDTO {
  noteId: string;
  chatId: string;
  authorId: string;
  authorName: string | null;
  text: string;
  createdAt: string;
}

export interface MessageStatsDTO {
  sent: number;
  delivered: number;
  read: number;
}

export interface ProfileViewCountersDTO {
  profileViews: number;
  profileViewsToday: number;
  updatedAt: string | null;
}

export interface MeetingListItem extends MeetingStateDTO {
  participantCount: number;
  hasRecordings: boolean;
}

export interface MeetingMessage {
  id: string;
  meetingId: string;
  senderId: string;
  senderName: string | null;
  isSystem: boolean;
  text: string | null;
  mediaObjectKey: string | null;
  createdAt: string;
}

export const endpoints = createEndpoints();
