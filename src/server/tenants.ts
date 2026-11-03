// Sentinel-SLA — v2 multi-tenancy data access.
//
// All Tenant-model and Service.tenantId access goes through parameterized raw
// SQL deliberately: `prisma db push` can regenerate the Prisma client while the
// dev server still holds a pre-v2 client instance in globalThis (HMR keeps the
// process alive), and raw SQL behaves identically on both client generations.
// Every other query in the backend keeps using the ORM for the v1 models.
//
// OWASP ASVS L1: all inputs reaching this module are validated upstream (zod)
// and every interpolated value is a bound parameter (never string-concatenated).

import { db } from '@/lib/db';
import { HttpError } from '@/server/http';
import type { TenantDTO } from '@/lib/types';

/** Raw tenant row (servicesCount joined in). */
export interface TenantRow {
  id: string;
  key: string;
  name: string;
  nameFa: string | null;
  createdAt: Date | string;
  servicesCount?: number | unknown;
}

// NOTE: every query below uses the pure TAGGED-TEMPLATE form of $queryRaw.
// A call with explicit type arguments (`$queryRaw<T>`...`) is parsed by TS as a
// plain string argument, and the `Prisma.sql`-object call form is not available
// on a client instance generated before that overload existed (prisma db push
// can regenerate the client while the dev server keeps the old one in memory).
// Result rows are therefore cast after awaiting.

function normalizeRow(row: TenantRow): TenantRow {
  return { ...row, servicesCount: Number(row.servicesCount ?? 0) };
}

/** All tenants with their live service count, oldest first. */
export async function listTenantRows(): Promise<TenantRow[]> {
  const rows = (await db.$queryRaw`SELECT t.id, t.key, t.name, t.nameFa, t.createdAt,
    (SELECT COUNT(*) FROM Service s WHERE s.tenantId = t.id) AS servicesCount
    FROM Tenant t ORDER BY t.createdAt ASC, t.id ASC`) as TenantRow[];
  return rows.map(normalizeRow);
}

export function toTenantDTO(row: TenantRow): TenantDTO {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    nameFa: row.nameFa ?? null,
    servicesCount: Number(row.servicesCount ?? 0),
  };
}

/** All tenants as TenantDTO (for the dashboard payload and GET /api/tenants). */
export async function listTenantDTOs(): Promise<TenantDTO[]> {
  return (await listTenantRows()).map(toTenantDTO);
}

export async function getTenantById(id: string): Promise<TenantRow | null> {
  const rows = (await db.$queryRaw`SELECT t.id, t.key, t.name, t.nameFa, t.createdAt,
    (SELECT COUNT(*) FROM Service s WHERE s.tenantId = t.id) AS servicesCount
    FROM Tenant t WHERE t.id = ${id} LIMIT 1`) as TenantRow[];
  return rows.length > 0 ? normalizeRow(rows[0]) : null;
}

export async function getTenantByKey(key: string): Promise<TenantRow | null> {
  const rows = (await db.$queryRaw`SELECT t.id, t.key, t.name, t.nameFa, t.createdAt,
    (SELECT COUNT(*) FROM Service s WHERE s.tenantId = t.id) AS servicesCount
    FROM Tenant t WHERE t.key = ${key} LIMIT 1`) as TenantRow[];
  return rows.length > 0 ? normalizeRow(rows[0]) : null;
}

/** cuid-shaped id (matches the rest of the fleet's row ids). */
function newId(): string {
  const t = Date.now().toString(36).padStart(8, '0');
  const rand = Math.random().toString(36).slice(2, 12);
  return `c${t}${rand}`;
}

/** Insert a tenant; 409 on duplicate key (unique constraint), race-safe. */
export async function createTenantRow(input: {
  key: string;
  name: string;
  nameFa: string | null;
}): Promise<TenantRow> {
  const id = newId();
  try {
    await db.$executeRaw`
      INSERT INTO Tenant (id, key, name, nameFa, createdAt)
      VALUES (${id}, ${input.key}, ${input.name}, ${input.nameFa}, ${new Date()})
    `;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE|P2002/i.test(msg)) {
      throw new HttpError(409, `Tenant key '${input.key}' already exists`);
    }
    throw err;
  }
  const row = await getTenantById(id);
  if (!row) throw new HttpError(500, 'Tenant creation failed');
  return row;
}

/** Service ids currently assigned to a tenant (empty for a tenant with no services). */
export async function serviceIdsForTenant(tenantId: string): Promise<string[]> {
  const rows = (await db.$queryRaw`SELECT id FROM Service WHERE tenantId = ${tenantId}`) as {
    id: string;
  }[];
  return rows.map((r) => r.id);
}

/** Whole-fleet service→tenant assignment map (raw: version-proof against the ORM cache). */
export async function serviceTenantAssignments(): Promise<Map<string, string | null>> {
  const rows = (await db.$queryRaw`SELECT id, tenantId FROM Service`) as {
    id: string;
    tenantId: string | null;
  }[];
  return new Map(rows.map((r) => [r.id, r.tenantId]));
}

/** Assign (or clear, with null) a service's tenant. */
export async function assignServiceTenant(serviceId: string, tenantId: string | null): Promise<void> {
  await db.$executeRaw`UPDATE Service SET tenantId = ${tenantId} WHERE id = ${serviceId}`;
}

/**
 * Backfill tenant assignments for services that are still unassigned.
 * mapping: service key → tenant key. Race-safe: the `tenantId IS NULL` guard
 * makes repeated/concurrent calls no-op after the first winner.
 */
export async function backfillTenantAssignments(mapping: Record<string, string>): Promise<number> {
  let updated = 0;
  for (const [serviceKey, tenantKey] of Object.entries(mapping)) {
    const res = await db.$executeRaw`
      UPDATE Service
      SET tenantId = (SELECT id FROM Tenant WHERE key = ${tenantKey})
      WHERE key = ${serviceKey} AND tenantId IS NULL
    `;
    updated += res;
  }
  return updated;
}

// ── request-side helpers ─────────────────────────────────────────────────────

/**
 * Normalize a `?tenant=` query param: absent, empty or `all` (case-insensitive)
 * → null (fleet-wide scope); anything else is treated as a tenant id.
 */
export function parseTenantParam(param: string | null | undefined): string | null {
  if (param === null || param === undefined) return null;
  const t = param.trim();
  if (t === '' || t.toLowerCase() === 'all') return null;
  return t;
}

/**
 * Resolve a `?tenant=` query param to the tenant row; null when fleet-wide was
 * requested; 404 (HttpError) when the id is unknown.
 */
export async function resolveTenant(param: string | null | undefined): Promise<TenantRow | null> {
  const candidate = parseTenantParam(param);
  if (candidate === null) return null;
  const tenant = await getTenantById(candidate);
  if (!tenant) throw new HttpError(404, `Tenant '${candidate}' not found`);
  return tenant;
}
