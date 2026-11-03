// Sentinel-SLA — authorization.
//
// ONE server-side module every route handler calls:
//   requireUser(req)          → any authenticated user (session or API token)
//   requireRole(req, ...)     → user with one of the given fleet roles
//   requireTenantAccess(...)  → user may act on the tenant (admin bypass)
// plus audit() for the append-only trail.
//
// Roles: owner > admin > engineer > executive > viewer.
// The permission matrix lives in docs/SECURITY.md; this module is its runtime.

import { db } from '@/lib/db';
import { HttpError } from '@/server/http';
import { resolveSessionUser, type SessionUser } from '@/server/auth/session';

export type Role = 'owner' | 'admin' | 'engineer' | 'executive' | 'viewer';

const ROLE_ORDER: Record<Role, number> = {
  owner: 50,
  admin: 40,
  engineer: 30,
  executive: 20,
  viewer: 10,
};

/** True when `user.role` is at least `min` (owner passes every check). */
export function roleAtLeast(user: Pick<SessionUser, 'role'>, min: Role): boolean {
  const actual = ROLE_ORDER[user.role as Role];
  const required = ROLE_ORDER[min];
  if (actual === undefined || required === undefined) return false;
  return actual >= required;
}

/** Any authenticated principal. Throws HttpError(401) when anonymous. */
export async function requireUser(req: Request): Promise<SessionUser> {
  const user = await resolveSessionUser(req);
  if (!user) {
    throw new HttpError(401, 'Authentication required. Log in at /login or use an API token.');
  }
  return user;
}

/** Authenticated user whose fleet role is at least `min`. Throws 401/403. */
export async function requireRole(req: Request, min: Role): Promise<SessionUser> {
  const user = await requireUser(req);
  if (!roleAtLeast(user, min)) {
    throw new HttpError(403, `This action requires the ${min} role.`);
  }
  return user;
}

/**
 * Tenant scope check: a non-admin user may only act
 * on tenants they hold a Membership for; owner/admin cross tenants. Pass the
 * raw `?tenant=` value (null = fleet-wide request).
 * Returns the effective tenant ids the user may see (null = unrestricted).
 */
export async function requireTenantAccess(
  user: SessionUser,
  tenantId: string | null,
): Promise<string[] | null> {
  if (roleAtLeast(user, 'admin')) return null; // fleet-wide permitted

  const memberships = await db.membership.findMany({
    where: { userId: user.id },
    select: { tenantId: true },
  });
  const allowed = memberships.map((m) => m.tenantId);

  if (tenantId === null) {
    // Fleet-wide request from a scoped user → narrow it to their memberships.
    return allowed;
  }
  if (!allowed.includes(tenantId)) {
    throw new HttpError(403, 'You do not have access to this client.');
  }
  return allowed;
}

/**
 * Tenant scope resolution for a request (policy item 4 — the loose
 * `?tenant=` filter is replaced by server-enforced scoping):
 *
 *   admin/owner + any param   → unrestricted (allowedIds null)
 *   scoped user + ?tenant=B   → 403 unless B is one of their memberships
 *   scoped user + no param    → narrowed: 0 memberships → 403; exactly one →
 *                               auto-selected; several → 403 demanding an
 *                               explicit `?tenant=` choice (the engine snapshot
 *                               cannot express "these N tenants" yet)
 *
 * Returns the EFFECTIVE tenant id for the query (null = truly fleet-wide,
 * only reachable by admins) plus the raw allowed-id list for data-layer
 * narrowing where the caller can apply it.
 */
export async function resolveTenantScope(
  user: SessionUser,
  tenantId: string | null,
): Promise<{ tenantId: string | null; allowedIds: string[] | null }> {
  const allowed = await requireTenantAccess(user, tenantId);
  if (allowed === null) return { tenantId, allowedIds: null }; // admin/owner

  if (tenantId === null) {
    if (allowed.length === 0) {
      throw new HttpError(403, 'Your account has no client access assigned.');
    }
    if (allowed.length === 1) return { tenantId: allowed[0], allowedIds: allowed };
    throw new HttpError(403, 'Select one of your assigned clients (?tenant=<id>).');
  }
  return { tenantId, allowedIds: allowed }; // explicit, already validated
}

/**
 * Append an audit entry. Fire-and-forget by design:
 * an audit failure must never break the user's action — it is logged loudly.
 */
export async function audit(
  entry: {
    actorType?: 'user' | 'system' | 'token';
    actorId?: string | null;
    actorName?: string | null;
    action: string;
    detail?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorType: entry.actorType ?? 'user',
        actorId: entry.actorId ?? null,
        actorName: entry.actorName ?? null,
        action: entry.action,
        detail: entry.detail ?? null,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
      },
    });
  } catch (err) {
    console.error('[sentinel:audit] failed to record entry:', err);
  }
}

/** Convenience: request metadata for audit rows. */
export function requestMeta(req: Request): { ip: string | null; userAgent: string | null } {
  return {
    ip:
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      req.headers.get('x-real-ip') ??
      null,
    userAgent: req.headers.get('user-agent'),
  };
}
