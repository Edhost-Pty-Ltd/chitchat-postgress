// ─── Socket_Client ───────────────────────────────────────────────────────────
// Manages a single Socket.IO connection to the backend gateway: authenticated
// handshake with a fresh Firebase ID token (Req 2.7), exponential-backoff
// reconnect (Req 3.6), re-joining active rooms on reconnect (Req 3.7), token
// refresh on expiry (Req 2.9), a subscribe() that returns an unsubscribe
// (Req 3.8), and teardown that clears state on sign-out (Req 2.10).

import { io, type Socket } from 'socket.io-client';
import { SOCKET_URL } from '../config/env';
import {
  createFirebaseTokenSource,
  getFreshIdToken,
  type IdTokenSource,
} from '../api/token';

type Handler = (payload: unknown) => void;

export interface SocketClientConfig {
  url?: string;
  tokenSource?: IdTokenSource;
}

export class SocketClient {
  private socket: Socket | null = null;
  private readonly url: string;
  private readonly tokenSource: IdTokenSource;
  // Rooms to re-join on reconnect (Req 3.7).
  private readonly activeChats = new Set<string>();
  private activeCallId: string | null = null;
  private activeMeetingId: string | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  // Handlers kept so re-created sockets re-bind them. Includes the synthetic
  // local event 'client:reconnect' that hooks can subscribe to (Req 5.18).
  private readonly handlers = new Map<string, Set<Handler>>();

  constructor(config: SocketClientConfig = {}) {
    this.url = config.url ?? SOCKET_URL;
    this.tokenSource = config.tokenSource ?? createFirebaseTokenSource();
  }

  /** Open the connection with a fresh token in the handshake (Req 2.7). */
  async connect(): Promise<void> {
    if (this.socket) return;
    const token = await getFreshIdToken(this.tokenSource);

    const socket = io(this.url, {
      transports: ['websocket'],
      auth: { token },
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 10000, // exponential backoff ceiling (Req 3.6)
      randomizationFactor: 0.5,
      autoConnect: true,
    });

    // Refresh the token before each (re)connection attempt (Req 2.9).
    socket.io.on('reconnect_attempt', () => {
      void this.refreshAuth(socket);
    });

    socket.on('connect', () => {
      this.rejoinRooms();
      this.startPresenceHeartbeat();
      // Notify local subscribers so per-chat hooks can refetch missed messages.
      this.emitLocal('client:reconnect', undefined);
    });

    // On an auth error, refresh the token and let reconnection retry (Req 2.9).
    socket.on('connect_error', (err: Error & { data?: { code?: string } }) => {
      if (err?.data?.code?.startsWith('AUTH_')) {
        void this.refreshAuth(socket);
      }
    });

    // Re-bind existing (non-synthetic) subscriptions to the live socket.
    for (const [event, set] of this.handlers) {
      if (event.startsWith('client:')) continue;
      for (const handler of set) socket.on(event, handler as (p: unknown) => void);
    }

    this.socket = socket;
  }

  private async refreshAuth(socket: Socket): Promise<void> {
    try {
      const token = await getFreshIdToken(this.tokenSource);
      socket.auth = { token };
    } catch {
      /* leave the previous auth; reconnection will retry */
    }
  }

  private rejoinRooms(): void {
    if (!this.socket) return;
    for (const chatId of this.activeChats) this.socket.emit('chat:join', { chatId });
    if (this.activeCallId) this.socket.emit('call:join', { callId: this.activeCallId });
    if (this.activeMeetingId) {
      this.socket.emit('meeting:join', { meetingId: this.activeMeetingId });
    }
  }

  /** Subscribe to a server (or synthetic local) event; returns unsubscribe (Req 3.8). */
  subscribe(event: string, handler: Handler): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    // Synthetic local events (prefixed 'client:') are dispatched by emitLocal,
    // not bound to the underlying socket.
    if (!event.startsWith('client:')) {
      this.socket?.on(event, handler as (p: unknown) => void);
    }

    return () => {
      set!.delete(handler);
      if (!event.startsWith('client:')) {
        this.socket?.off(event, handler as (p: unknown) => void);
      }
      if (set!.size === 0) this.handlers.delete(event);
    };
  }

  /** Dispatch a synthetic local event to subscribers (e.g. reconnect). */
  private emitLocal(event: string, payload: unknown): void {
    const set = this.handlers.get(event);
    if (set) for (const h of set) h(payload);
  }

  /** Ping presence every 30s so the server refreshes the 60s TTL (Req 7.2). */
  private startPresenceHeartbeat(): void {
    if (this.presenceTimer) return;
    this.emit('presence:ping');
    this.presenceTimer = setInterval(() => this.emit('presence:ping'), 30000);
  }

  private stopPresenceHeartbeat(): void {
    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
  }

  /** Emit an event to the server. */
  emit(event: string, payload?: unknown): void {
    this.socket?.emit(event, payload);
  }

  // ── Room tracking so reconnects restore membership (Req 3.7) ──────────────
  joinChat(chatId: string): void {
    this.activeChats.add(chatId);
    this.socket?.emit('chat:join', { chatId });
  }
  leaveChat(chatId: string): void {
    this.activeChats.delete(chatId);
    this.socket?.emit('chat:leave', { chatId });
  }
  setActiveCall(callId: string | null): void {
    this.activeCallId = callId;
    if (callId) this.socket?.emit('call:join', { callId });
  }
  setActiveMeeting(meetingId: string | null): void {
    this.activeMeetingId = meetingId;
    if (meetingId) this.socket?.emit('meeting:join', { meetingId });
  }

  /** Disconnect and clear cached state on sign-out (Req 2.10). */
  disconnect(): void {
    this.stopPresenceHeartbeat();
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.activeChats.clear();
    this.activeCallId = null;
    this.activeMeetingId = null;
    this.handlers.clear();
  }

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }
}

/** Shared singleton used by hooks and screens. */
export const socketClient = new SocketClient();
