// User session service using cache

import { Cache } from "./cache.js";
import { secondsToMs } from "./time-utils.js";

export interface Session {
  userId: string;
  token: string;
  loginAt: number;
}

// Sessions expire after 30 minutes (1800 seconds)
const SESSION_TTL_SECONDS = 1800;

const sessionCache = new Cache<Session>(secondsToMs(SESSION_TTL_SECONDS));

export function createSession(userId: string, token: string): Session {
  const session: Session = {
    userId,
    token,
    loginAt: Date.now(),
  };
  sessionCache.set(token, session);
  return session;
}

export function getSession(token: string): Session | undefined {
  return sessionCache.get(token);
}

export function invalidateSession(token: string): boolean {
  return sessionCache.delete(token);
}

export function isSessionValid(token: string): boolean {
  return sessionCache.has(token);
}
