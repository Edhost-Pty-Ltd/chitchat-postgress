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

export interface MeResponse {
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
}

export interface PublicUserProfile {
  id: string;
  phoneNumber: string | null;
  displayName: string | null;
  avatarObjectKey: string | null;
  accountType: string;
}

export interface ProfilePatch {
  displayName?: string | null;
  about?: string | null;
  avatarObjectKey?: string | null;
  email?: string | null;
  website?: string | null;
  catalog?: string | null;
  operationalHours?: string | null;
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

    // ── Profile (Req 4.2, 4.3, 4.6) ──
    getMe: (): Promise<ApiResult<MeResponse>> => client.get('/me'),
    updateMe: (patch: ProfilePatch): Promise<ApiResult<MeResponse>> => client.patch('/me', patch),
    updatePhone: (phoneNumber: string): Promise<ApiResult<{ phoneNumber: string }>> =>
      client.put('/me/phone', { phoneNumber }),
    getUser: (userId: string): Promise<ApiResult<PublicUserProfile>> =>
      client.get(`/users/${encodeURIComponent(userId)}`),

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
    registerPushToken: (token: string, platform?: string | null): Promise<ApiResult<{ ok: true }>> =>
      client.post('/push-tokens', { token, platform }),
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
    createMeeting: (
      title?: string,
      participants?: string[],
    ): Promise<ApiResult<{ meetingId: string; state: unknown }>> =>
      client.post('/meetings', { title, participants }),
    getMeeting: (meetingId: string): Promise<ApiResult<{ state: unknown }>> =>
      client.get(`/meetings/${meetingId}`),
    listMeetings: (): Promise<ApiResult<{ meetings: MeetingListItem[] }>> =>
      client.get('/meetings'),
    getMeetingMessages: (meetingId: string): Promise<ApiResult<{ messages: MeetingMessage[] }>> =>
      client.get(`/meetings/${encodeURIComponent(meetingId)}/messages`),
    sendMeetingMessage: (
      meetingId: string,
      body: { text?: string; mediaObjectKey?: string | null },
    ): Promise<ApiResult<{ message: { id: string; createdAt: string } }>> =>
      client.post(`/meetings/${encodeURIComponent(meetingId)}/messages`, body),
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
  };
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
}

export type BackendMessageType =
  | 'text'
  | 'image'
  | 'voice'
  | 'video'
  | 'file'
  | 'location'
  | 'system'
  | 'catalog';

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
}

export interface MeetingListItem {
  id: string;
  title: string;
  organizerId: string;
  isActive: boolean;
  endedAt: string | null;
  createdAt: string;
  participantCount: number;
}

export interface MeetingMessage {
  id: string;
  meetingId: string;
  senderId: string;
  text: string | null;
  mediaObjectKey: string | null;
  createdAt: string;
}

export const endpoints = createEndpoints();
