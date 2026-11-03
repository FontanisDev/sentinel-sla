// Sentinel-SLA — server-side sessions + login lockout.
//
// Cookie: httpOnly, SameSite=Lax, Secure when the deployment declares TLS
// (SENTINEL_TLS=1). The cookie holds a random 256-bit value; the DB stores only
// its sha256. Idle timeout 8 h (sliding lastSeenAt), absolute 7 d (never
// extended). Lockout: 5 consecutive failures → 15 minutes.

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { cookies } from 'next/headers';
import { db } from '@/lib/db';
import { verifyPassword } from '@/server/auth/passwords';

export const SESSION_COOKIE = 'sentinel_session';
const IDLE_TIMEOUT_MS = 8 * 3_600_000; // 8 h
const ABSOLUTE_TTL_MS = 7 * 24 * 3_600_000; // 7 d
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MS = 15 * 60_000; // 15 min

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  locale: string;
  sessionId: string;
  via: 'session' | 'token';
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Cookie attributes for the current deployment. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.SENTINEL_TLS === '1',
    path: '/',
  };
}

/** Create a session row + return the raw cookie value (set by the caller). */
export async function createSession(
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await db.session.create({
    data: {
      tokenHash: sha256(raw),
      userId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      absoluteExpiry: new Date(Date.now() + ABSOLUTE_TTL_MS),
    },
  });
  return raw;
}

/**
 * Throttle for the per-request `lastUsedAt`/`lastSeenAt` touch.
 * Revocation/expiry is still checked against the DB on EVERY request — only
 * the informational write is rate-limited to once per minute per session, so
 * a high-rate machine client no longer issues one SQLite write per request
 * (write contention was the dominant load-gate cost).
 */
const TOUCH_THROTTLE_MS = 60_000;
const touchMap = new Map<string, number>();
function shouldTouch(id: string, now: number): boolean {
  const last = touchMap.get(id) ?? 0;
  if (now - last < TOUCH_THROTTLE_MS) return false;
  touchMap.set(id, now);
  if (touchMap.size > 10_000) {
    // keep the map bounded on very busy instances
    for (const [k, v] of touchMap) {
      if (now - v > TOUCH_THROTTLE_MS) touchMap.delete(k);
    }
  }
  return true;
}

/**
 * Resolve the caller from the session cookie (or an `Authorization: Bearer`
 * API token). Returns null when absent/invalid/expired — never throws for a
 * missing session; 401 decisions belong to the authz layer.
 */
export async function resolveSessionUser(req: Request): Promise<SessionUser | null> {
  // 1. Bearer API token (machine access; hashed, prefix-visible, expiring).
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const raw = authHeader.slice('Bearer '.length).trim();
    if (raw.length >= 20) {
      const token = await db.apiToken.findUnique({ where: { tokenHash: sha256(raw) } });
      if (
        token &&
        !token.revokedAt &&
        (!token.expiresAt || token.expiresAt.getTime() > Date.now())
      ) {
        const user = await db.user.findUnique({ where: { id: token.userId } });
        if (user && !user.disabled) {
          if (shouldTouch(token.id, Date.now())) {
            void db.apiToken
              .update({ where: { id: token.id }, data: { lastUsedAt: new Date() } })
              .catch(() => undefined);
          }
          return {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            locale: user.locale,
            sessionId: token.id,
            via: 'token',
          };
        }
      }
    }
    return null;
  }

  // 2. Session cookie.
  return resolveSessionUserFromCookies();
}

/**
 * Resolve the caller from the session cookie alone — for React server
 * components (no Request object there; cookies() works directly).
 */
export async function resolveSessionUserFromCookies(): Promise<SessionUser | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;

  const session = await db.session.findUnique({ where: { tokenHash: sha256(raw) } });
  if (!session) return null;

  const now = Date.now();
  const idleDeadline = session.lastSeenAt.getTime() + IDLE_TIMEOUT_MS;
  if (session.absoluteExpiry.getTime() <= now || idleDeadline <= now) {
    // Expired: remove quietly so the table stays clean.
    void db.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }

  const user = await db.user.findUnique({ where: { id: session.userId } });
  if (!user || user.disabled) {
    // Missing owner or suspended account → the session is dead on the spot.
    if (user?.disabled) {
      void db.session.delete({ where: { id: session.id } }).catch(() => undefined);
    }
    return null;
  }

  // Sliding idle window — throttled (see shouldTouch): the 8h idle budget
  // makes a once-per-minute touch more than precise enough; correctness does
  // not depend on it.
  if (shouldTouch(session.id, now)) {
    void db.session
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    locale: user.locale,
    sessionId: session.id,
    via: 'session',
  };
}

/** Destroy the caller's session cookie row (logout / logout-everywhere helper). */
export async function destroyCurrentSession(): Promise<void> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (raw) {
    await db.session.deleteMany({ where: { tokenHash: sha256(raw) } });
  }
}

export function sessionCookieClear(): string {
  return SESSION_COOKIE;
}

// ── login lockout ───────────────────────────────────────────────────────────

export type LoginOutcome =
  | { ok: true; userId: string }
  | { ok: false; reason: 'invalid' | 'locked' | 'disabled'; retryAfterSec?: number };

/**
 * Validate credentials with lockout accounting. `identify` is the email the
 * user typed; every outcome is audit-logged by the caller.
 */
export async function checkLogin(email: string, password: string): Promise<LoginOutcome> {
  const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) return { ok: false, reason: 'invalid' };

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    return {
      ok: false,
      reason: 'locked',
      retryAfterSec: Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000),
    };
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    const failures = user.failedLogins + 1;
    await db.user.update({
      where: { id: user.id },
      data: {
        failedLogins: failures,
        lockedUntil:
          failures >= LOCKOUT_THRESHOLD ? new Date(Date.now() + LOCKOUT_MS) : null,
      },
    });
    return { ok: false, reason: 'invalid' };
  }

  // Suspended account: correct credentials, but an admin disabled the user.
  // Disclosed only to someone holding valid credentials (no enumeration).
  if (user.disabled) return { ok: false, reason: 'disabled' };

  await db.user.update({
    where: { id: user.id },
    data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  return { ok: true, userId: user.id };
}

/** How many users exist? (The /setup wizard is reachable only at zero.) */
export async function userCount(): Promise<number> {
  return db.user.count();
}

/** Constant-time string compare for secrets (webhook secrets, etc.). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
