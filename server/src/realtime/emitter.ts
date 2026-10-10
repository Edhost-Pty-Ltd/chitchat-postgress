import type { Server as IOServer } from 'socket.io';

/**
 * Holds the Socket.IO server instance so REST route handlers can emit realtime
 * events (e.g. message:new after a REST send) without a direct import cycle.
 * Set once at startup by the gateway.
 */
let io: IOServer | null = null;

export function setIO(server: IOServer): void {
  io = server;
}

export function getIO(): IOServer | null {
  return io;
}

export const rooms = {
  user: (userId: string) => `user:${userId}`,
  chat: (chatId: string) => `chat:${chatId}`,
  call: (callId: string) => `call:${callId}`,
  meeting: (meetingId: string) => `meeting:${meetingId}`,
};

/** Emit an event to a user's personal room (all their sockets). */
export function emitToUser(userId: string, event: string, payload: unknown): void {
  io?.to(rooms.user(userId)).emit(event, payload);
}

/** Emit an event to everyone in a chat room. */
export function emitToChat(chatId: string, event: string, payload: unknown): void {
  io?.to(rooms.chat(chatId)).emit(event, payload);
}

/** Emit an event to everyone in a meeting room. */
export function emitToMeeting(meetingId: string, event: string, payload: unknown): void {
  io?.to(rooms.meeting(meetingId)).emit(event, payload);
}

/**
 * Deliver a new message to each other member via their user room, except
 * recipients who blocked the sender (Req 5.4). Block filtering is done by the
 * caller passing an already-filtered recipient list.
 */
export function emitMessageToRecipients(recipients: string[], event: string, payload: unknown): void {
  for (const uid of recipients) emitToUser(uid, event, payload);
}

/**
 * Whether a user has at least one socket currently joined to a chat room.
 * Used by the Push_Dispatcher to skip push for actively-connected recipients
 * (Req 6.7). Returns false when the gateway is not available.
 */
export async function userInChatRoom(userId: string, chatId: string): Promise<boolean> {
  if (!io) return false;
  const socketsInChat = await io.in(rooms.chat(chatId)).fetchSockets();
  return socketsInChat.some((s) => (s.data as { userId?: string }).userId === userId);
}
