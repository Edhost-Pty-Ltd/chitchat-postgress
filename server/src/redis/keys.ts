/**
 * Centralized Redis key builders so key formats live in one place
 * (see design "Redis key design").
 */
export const redisKeys = {
  presence: (userId: string) => `presence:${userId}`,
  presenceSockets: (userId: string) => `presence:${userId}:sockets`,
  typing: (chatId: string, userId: string) => `typing:${chatId}:${userId}`,
  callBuffer: (callId: string) => `callbuf:${callId}`,
  rateLimit: (userId: string, action: string) => `ratelimit:${userId}:${action}`,
};
