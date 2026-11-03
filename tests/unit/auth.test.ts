// Auth unit tests: password policy + argon2id roundtrip, RBAC order,
// login lockout accounting (mocked db), session-cookie behaviour contract.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => {
  interface Row {
    [k: string]: unknown;
  }
  const users = new Map<string, Row>();
  const sessions = new Map<string, Row>();
  const db = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { email?: string; id?: string } }) => {
        for (const u of users.values()) {
          if ((where.email && u.email === where.email) || (where.id && u.id === where.id)) {
            return u;
          }
        }
        return null;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { ...data };
        users.set(String(data.email), row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        for (const [k, u] of users) {
          if (u.id === where.id) {
            const next = { ...u, ...data };
            users.set(k, next);
            return next;
          }
        }
        return null;
      }),
      count: vi.fn(async () => users.size),
    },
    session: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        sessions.set(String(data.tokenHash), { ...data });
        return data;
      }),
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => sessions.get(where.tokenHash) ?? null),
      delete: vi.fn(async () => null),
      deleteMany: vi.fn(async () => null),
      update: vi.fn(async () => null),
    },
    membership: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async () => null) },
    apiToken: { findUnique: vi.fn(async () => null), update: vi.fn(async () => null) },
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 0),
  };
  return { db };
});

import { hashPassword, passwordPolicyError, verifyPassword } from '@/server/auth/passwords';
import { checkLogin } from '@/server/auth/session';
import { roleAtLeast } from '@/server/authz';

describe('password policy', () => {
  it('rejects short, trivial and single-char passwords; accepts strong ones', () => {
    expect(passwordPolicyError('short')).toMatch(/at least 12/);
    expect(passwordPolicyError('sentinel-rock-solid')).toMatch(/dictionary/);
    expect(passwordPolicyError('aaaaaaaaaaaa')).toMatch(/repeated/);
    expect(passwordPolicyError('Xq7#mVt9$Lp2Rw4z')).toBeNull();
  });
});

describe('argon2id roundtrip (hash-wasm)', () => {
  it('hashes to PHC format and verifies true/false correctly', async () => {
    const hash = await hashPassword('correct horse battery staple 42');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple 42', hash)).toBe(true);
    expect(await verifyPassword('wrong password entirely', hash)).toBe(false);
  });
});

describe('RBAC order (roleAtLeast)', () => {
  it('owner passes every floor; viewer passes none above viewer', () => {
    expect(roleAtLeast({ role: 'owner' }, 'admin')).toBe(true);
    expect(roleAtLeast({ role: 'owner' }, 'owner')).toBe(true);
    expect(roleAtLeast({ role: 'admin' }, 'engineer')).toBe(true);
    expect(roleAtLeast({ role: 'engineer' }, 'admin')).toBe(false);
    expect(roleAtLeast({ role: 'executive' }, 'engineer')).toBe(false);
    expect(roleAtLeast({ role: 'viewer' }, 'viewer')).toBe(true);
    expect(roleAtLeast({ role: 'viewer' }, 'executive')).toBe(false);
    expect(roleAtLeast({ role: 'mystery' }, 'viewer')).toBe(false);
  });
});

describe('login lockout (mocked db)', () => {
  beforeEach(async () => {
    const { db } = await import('@/lib/db');
    (db.user.findUnique as ReturnType<typeof vi.fn>).mockReset();
  });

  it('locks after 5 consecutive failures and reports the retry window', async () => {
    const { db } = await import('@/lib/db');
    let stored: Record<string, unknown> = {
      id: 'u1',
      email: 'op@sentinel.local',
      passwordHash: await hashPassword('right-password-123'),
      failedLogins: 0,
      lockedUntil: null,
    };
    (db.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ where }: { where: { email?: string } }) =>
        where.email === 'op@sentinel.local' ? stored : null,
    );
    (db.user.update as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        stored = { ...stored, ...data };
        return stored;
      },
    );

    for (let i = 0; i < 5; i++) {
      const out = await checkLogin('op@sentinel.local', 'wrong-password-999');
      expect(out).toEqual({ ok: false, reason: 'invalid' });
    }
    const locked = await checkLogin('op@sentinel.local', 'wrong-password-999');
    expect(locked).toMatchObject({ ok: false, reason: 'locked' });
    expect((locked as { retryAfterSec?: number }).retryAfterSec).toBeGreaterThan(0);

    // Correct password while locked is still rejected (lock wins).
    const stillLocked = await checkLogin('op@sentinel.local', 'right-password-123');
    expect(stillLocked).toMatchObject({ ok: false, reason: 'locked' });
  });

  it('succeeds with the right password before lockout and resets failures', async () => {
    const { db } = await import('@/lib/db');
    let stored: Record<string, unknown> = {
      id: 'u2',
      email: 'eng@sentinel.local',
      passwordHash: await hashPassword('another-good-pass-9'),
      failedLogins: 2,
      lockedUntil: null,
    };
    (db.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ where }: { where: { email?: string } }) =>
        where.email === 'eng@sentinel.local' ? stored : null,
    );
    (db.user.update as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        stored = { ...stored, ...data };
        return stored;
      },
    );

    const out = await checkLogin('eng@sentinel.local', 'another-good-pass-9');
    expect(out).toEqual({ ok: true, userId: 'u2' });
    expect(stored.failedLogins).toBe(0);
  });
});
