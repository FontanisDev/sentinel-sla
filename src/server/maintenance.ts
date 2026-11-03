// Sentinel-SLA — v2.1 maintenance windows data access.
//
// All MaintenanceWindow access goes through parameterized raw SQL deliberately
// (same pattern as tenants.ts): `prisma db push` regenerates the Prisma client
// while the dev server can still hold a pre-v2.1 client instance in globalThis
// (HMR keeps the process alive), and raw SQL behaves identically on both client
// generations.
//
// OWASP ASVS L1: every value is a bound parameter — never string-interpolated.
// Date columns MUST be written and compared through JS `Date` bound params —
// the ORM normalizes them to its native storage (epoch-ms integers on SQLite,
// timestamps on Postgres). Passing ISO strings instead produces TEXT rows that
// silently NEVER match integer-normalized comparisons (the planned-window /
// expiry bug found by the end-to-end journey suite — maintenance windows vanished
// from the contract sheet). Raw reads stay tolerant of both representations.
//
// Semantics (contract src/lib/types.ts): while a window is ACTIVE, alert
// delivery is suppressed for the covered service (serviceId null = fleet-wide);
// incidents are still detected/recorded/resolved — SLA truth is never altered.

import { db } from '@/lib/db';
import { HttpError } from '@/server/http';
import type { CreateMaintenanceWindowPayload, MaintenanceStatus, MaintenanceWindowDTO } from '@/lib/types';

/** Raw MaintenanceWindow row, optionally joined with service name/tenant. */
export interface MaintenanceWindowRow {
  id: string;
  serviceId: string | null;
  reason: string;
  status: string;
  startAt: Date | string;
  endAt: Date | string;
  createdAt: Date | string;
  createdBy: string;
  suppressedAlerts: number | unknown;
  /** LEFT JOIN Service — resolved service name (null for fleet-wide/deleted). */
  serviceName?: string | null;
  /** LEFT JOIN Service — the service's live tenant id (null for fleet-wide). */
  tenantId?: string | null;
}

// NOTE: every query below uses the pure TAGGED-TEMPLATE form of $queryRaw
// (bound parameters only, no string interpolation of SQL fragments — the same
// HMR-safe convention as tenants.ts). The SELECT column list is therefore
// repeated literally in each statement.

/** cuid-shaped id (matches the rest of the fleet's row ids). */
function newId(): string {
  const t = Date.now().toString(36).padStart(8, '0');
  const rand = Math.random().toString(36).slice(2, 12);
  return `c${t}${rand}`;
}

function toIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

export function toMaintenanceWindowDTO(row: MaintenanceWindowRow): MaintenanceWindowDTO {
  return {
    id: row.id,
    serviceId: row.serviceId ?? null,
    serviceName: row.serviceName ?? null,
    tenantId: row.tenantId ?? null,
    reason: row.reason,
    status: row.status as MaintenanceStatus,
    startAt: toIso(row.startAt),
    endAt: toIso(row.endAt),
    createdAt: toIso(row.createdAt),
    createdBy: row.createdBy,
    suppressedAlerts: Number(row.suppressedAlerts ?? 0),
  };
}

// ── queries ─────────────────────────────────────────────────────────────────

/**
 * List maintenance windows: active windows first (endAt DESC), then
 * expired/cancelled (endAt DESC). `tenantId` scopes the list (fleet-wide
 * windows are always in scope); null = fleet-wide listing.
 */
export async function listMaintenanceWindows(
  limit = 15,
  tenantId: string | null = null,
): Promise<MaintenanceWindowDTO[]> {
  // Lazily expire due windows so the list is correct even between engine ticks.
  await expireDueWindows();
  const rows = (await db.$queryRaw`
    SELECT m.id, m.serviceId, m.reason, m.status, m.startAt, m.endAt, m.createdAt,
           m.createdBy, m.suppressedAlerts, s.name AS serviceName, s.tenantId AS tenantId
    FROM MaintenanceWindow m
    LEFT JOIN Service s ON s.id = m.serviceId
    WHERE (${tenantId} IS NULL OR m.serviceId IS NULL OR s.tenantId = ${tenantId})
    ORDER BY CASE WHEN m.status = 'active' THEN 1 ELSE 0 END DESC, m.endAt DESC
    LIMIT ${limit}
  `) as MaintenanceWindowRow[];
  return rows.map(toMaintenanceWindowDTO);
}

async function getWindowRow(id: string): Promise<MaintenanceWindowRow | null> {
  const rows = (await db.$queryRaw`
    SELECT m.id, m.serviceId, m.reason, m.status, m.startAt, m.endAt, m.createdAt,
           m.createdBy, m.suppressedAlerts, s.name AS serviceName, s.tenantId AS tenantId
    FROM MaintenanceWindow m
    LEFT JOIN Service s ON s.id = m.serviceId
    WHERE m.id = ${id} LIMIT 1
  `) as MaintenanceWindowRow[];
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Active windows covering a service: fleet-wide (serviceId null) or scoped to
 * exactly that service. `endAt > now` is enforced in SQL as well so a window
 * whose engine-tick expiry has not run yet never suppresses late alerts.
 */
export async function activeWindowsForService(serviceId: string): Promise<MaintenanceWindowDTO[]> {
  const now = new Date(); // Date param → ORM-normalized comparison, never a string
  const rows = (await db.$queryRaw`
    SELECT m.id, m.serviceId, m.reason, m.status, m.startAt, m.endAt, m.createdAt,
           m.createdBy, m.suppressedAlerts, s.name AS serviceName, s.tenantId AS tenantId
    FROM MaintenanceWindow m
    LEFT JOIN Service s ON s.id = m.serviceId
    WHERE m.status = 'active' AND m.endAt > ${now}
      AND (m.serviceId IS NULL OR m.serviceId = ${serviceId})
    ORDER BY m.startAt ASC
  `) as MaintenanceWindowRow[];
  return rows.map(toMaintenanceWindowDTO);
}

/**
 * Expire active windows whose endAt has passed. Idempotent; called once per
 * engine tick and lazily from listMaintenanceWindows(). Returns the number of
 * windows transitioned to 'expired'.
 */
export async function expireDueWindows(): Promise<number> {
  const now = new Date(); // Date param — see the storage note at the top
  return db.$executeRaw`
    UPDATE MaintenanceWindow
    SET status = 'expired'
    WHERE status = 'active' AND endAt <= ${now}
  `;
}

/**
 * Increment the suppressed-delivery counter on the given windows.
 * COALESCE keeps the arithmetic NULL-safe; each UPDATE is atomic per row.
 */
export async function incrementSuppressedAlerts(ids: string[], count: number): Promise<void> {
  for (const id of ids) {
    await db.$executeRaw`
      UPDATE MaintenanceWindow
      SET suppressedAlerts = COALESCE(suppressedAlerts, 0) + ${count}
      WHERE id = ${id}
    `;
  }
}

// ── mutations ───────────────────────────────────────────────────────────────

/**
 * Open a maintenance window: starts immediately (`startAt = now`), lasts
 * `durationMin` minutes, status 'active'. The service must exist (404);
 * omitted/null serviceId opens a fleet-wide window.
 */
export async function createMaintenanceWindow(
  payload: CreateMaintenanceWindowPayload,
): Promise<MaintenanceWindowDTO> {
  const id = newId();
  const now = new Date();
  const endAt = new Date(now.getTime() + payload.durationMin * 60_000);

  let tenantId: string | null = null;
  if (payload.serviceId !== null && payload.serviceId !== undefined) {
    const svc = (await db.$queryRaw`
      SELECT id, tenantId FROM Service WHERE id = ${payload.serviceId} LIMIT 1
    `) as { id: string; tenantId: string | null }[];
    if (svc.length === 0) {
      throw new HttpError(404, `Service '${payload.serviceId}' not found`);
    }
    tenantId = svc[0].tenantId ?? null;
  }

  await db.$executeRaw`
    INSERT INTO MaintenanceWindow
      (id, serviceId, tenantId, reason, status, startAt, endAt, createdAt, createdBy, suppressedAlerts)
    VALUES
      (${id}, ${payload.serviceId ?? null}, ${tenantId}, ${payload.reason}, 'active',
       ${now}, ${endAt}, ${now}, 'on-call', 0)
  `;

  const row = await getWindowRow(id);
  if (!row) throw new HttpError(500, 'Maintenance window creation failed');
  return toMaintenanceWindowDTO(row);
}

/**
 * Cancel a maintenance window (on-call aborts planned work). Only ACTIVE
 * windows can be cancelled: 404 unknown id, 409 already ended. Race-safe via
 * the `status = 'active'` guard in the UPDATE.
 */
export async function cancelMaintenanceWindow(id: string): Promise<MaintenanceWindowDTO> {
  const cancelled = await db.$executeRaw`
    UPDATE MaintenanceWindow SET status = 'cancelled'
    WHERE id = ${id} AND status = 'active'
  `;
  if (cancelled === 0) {
    const row = await getWindowRow(id);
    if (!row) throw new HttpError(404, 'Maintenance window not found');
    throw new HttpError(409, `Maintenance window is already ${row.status}`);
  }
  const row = await getWindowRow(id);
  if (!row) throw new HttpError(500, 'Maintenance window cancellation failed');
  return toMaintenanceWindowDTO(row);
}
