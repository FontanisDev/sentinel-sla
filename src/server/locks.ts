// Sentinel-SLA — cross-replica scheduler locks.
//
// "Make schedulers idempotent and safe with two replicas (use a Postgres
// advisory lock)." On PostgreSQL we take a session-scoped advisory lock; on
// SQLite (single-node dev/demo) there is no cross-process lock primitive, so
// the guard degrades to an in-process mutex, which is correct for the one
// process that owns the loops (SENTINEL_ROLE=worker|all).
//
// The lock is best-effort by design: losing an election only means a replica
// skips this scheduler pass; it never blocks HTTP work.

import { db } from '@/lib/db';

const LOCK_NAMESPACE = 0x53454e54; // 'SENT'

const held = new Set<number>();

/** True when the configured datasource is PostgreSQL (advisory locks available).
 *  Derived from DATABASE_URL — a probe query would spam prisma:error on SQLite. */
function isPostgres(): boolean {
  const url = process.env.DATABASE_URL ?? '';
  return url.startsWith('postgres://') || url.startsWith('postgresql://');
}

/**
 * Try to acquire a named scheduler lock for this tick. Returns true when this
 * process owns the pass. The promise NEVER rejects (a failed probe on SQLite
 * just means "not postgres" → in-process mode).
 */
export async function tryAcquireSchedulerLock(name: string): Promise<boolean> {
  const key = LOCK_NAMESPACE + hash(name);
  if (isPostgres()) {
    const rows = (await db.$queryRaw`
      SELECT pg_try_advisory_lock(${key}) AS ok
    `) as Array<{ ok: boolean }>;
    const ok = Boolean(rows[0]?.ok);
    if (ok) held.add(key);
    return ok;
  }
  // SQLite / unknown: in-process mutual exclusion only.
  if (held.has(key)) return false;
  held.add(key);
  return true;
}

/** Release a previously acquired lock (safe to call even when not held). */
export async function releaseSchedulerLock(name: string): Promise<void> {
  const key = LOCK_NAMESPACE + hash(name);
  if (!held.delete(key)) return;
  try {
    if (isPostgres()) {
      await db.$queryRaw`SELECT pg_advisory_unlock(${key})`;
    }
  } catch {
    // Session-scoped locks auto-release when the connection closes; nothing
    // else to do on failure here.
  }
}

/** Run `fn` under the named lock; returns null when another replica owns it. */
export async function withSchedulerLock<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  if (!(await tryAcquireSchedulerLock(name))) return null;
  try {
    return await fn();
  } finally {
    await releaseSchedulerLock(name);
  }
}

/** FNV-1a — stable 32-bit key per scheduler name. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
