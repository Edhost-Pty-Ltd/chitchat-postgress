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
  // In-flight connect() promise so concurrent callers share one connection
  // attempt instead of each opening a separate socket.
  private connecting: Promise<void> | null = null;
  // Manual retry after an auth-rejected handshake (socket.io does not
  // auto-reconnect those). Capped exponential backoff.
  private authRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private authRetryDelay = 500;
  // Handlers kept so re-created sockets re-bind them. Includes the synthetic
  // local event 'client:reconnect' that hooks can subscribe to (Req 5.18).
  private readonly handlers = new Map<string, Set<Handler>>();

  constructor(config: SocketClientConfig = {}) {
    this.url = config.url ?? SOCKET_URL;
    this.tokenSource = config.tokenSource ?? createFirebaseTokenSource();
  }

  /** Open the connection with a fresh token in the handshake (Req 2.7). */
  async connect(): Promise<void> {
    if (this.socket) {
      if (!this.socket.connected) {
        await this.refreshAuth(this.socket);
        this.socket.connect();
      }
      return;
    }
    // Several hooks (useChats, useNotificationSync, usePresence) call connect()
    // on mount at once. Without deduping, each would open its own socket — the
    // user would then join the room multiple times and receive every event
    // (messages, notifications) duplicated. Share a single in-flight attempt.
    if (this.connecting) return this.connecting;
    this.connecting = this.openSocket().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async openSocket(): Promise<void> {
  const socket = io(this.url, {
    // Try WS first, fall back to polling. Do NOT force WS-only.
    transports: ['websocket', 'polling'],
    // Called before EVERY handshake (initial + reconnect) — async-safe.
    auth: (cb) => {
      getFreshIdToken(this.tokenSource)
        .then((token) => cb({ token }))
        .catch((err) => {
          console.warn('[socket] token fetch failed:', err);
          cb({ token: '' });
        });
    },
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 10000,
    randomizationFactor: 0.5,
    autoConnect: true,
    timeout: 10000,
  });

  // Assign FIRST so connect/rejoin/presence handlers see the live socket.
  this.socket = socket;

  socket.on('connect', () => {
    console.log('[socket] connected', socket.id);
    this.authRetryDelay = 500;
    this.rejoinRooms();
    this.startPresenceHeartbeat();
    this.emitLocal('client:reconnect', undefined);
  });

  socket.on('connect_error', (err: any) => {
    console.warn('[socket] connect_error:', err?.message, err?.data ?? '');
    void this.refreshAuth(socket);
    if (err?.data?.code?.startsWith('AUTH_')) this.scheduleAuthReconnect(socket);
  });

  socket.on('disconnect', (reason) => {
    console.log('[socket] disconnected:', reason);
    this.stopPresenceHeartbeat();
    if (reason !== 'io server disconnect') return;
    setTimeout(() => {
      if (this.socket !== socket || socket.connected) return;
      void this.refreshAuth(socket).finally(() => socket.connect());
    }, 250);
  });

  for (const [event, set] of this.handlers) {
    if (event.startsWith('client:')) continue;
    for (const handler of set) socket.on(event, handler as (p: unknown) => void);
  }
}

  /**
   * Refresh the token and manually re-open a socket the server rejected for an
   * auth reason. Backs off (capped) so a persistently-bad token can't hot-loop.
   */
  private scheduleAuthReconnect(socket: Socket): void {
    if (this.authRetryTimer) return; // a retry is already pending
    this.authRetryTimer = setTimeout(async () => {
      this.authRetryTimer = null;
      // Skip if this socket was replaced/disconnected, or already recovered.
      if (this.socket !== socket || socket.connected) return;
      await this.refreshAuth(socket);
      this.authRetryDelay = Math.min(this.authRetryDelay * 2, 10000);
      socket.connect();
    }, this.authRetryDelay);
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

  /** Dispatch a synthetic local event to subscribers (e.g. reconnect, read). */
  emitLocal(event: string, payload: unknown): void {
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
    if (this.authRetryTimer) {
      clearTimeout(this.authRetryTimer);
      this.authRetryTimer = null;
    }
    this.authRetryDelay = 500;
    this.connecting = null;
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
