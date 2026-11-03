// POST /api/services/import — bulk CSV import of services WITH their SLA
// contract terms (customer onboarding: "data import (CSV of
// contracts and services)"). A contract in Sentinel lives on the service
// (slaTarget / penaltyBase / penaltyPerMinute / tier), so one flat sheet
// carries both.
//
// Journey: the operator pastes or uploads a customer sheet, runs it as a
// dry-run (default — validates everything, writes nothing, reports each
// failing row by physical CSV line), then commits. Commit is all-or-nothing:
// any failing row aborts the whole import (money terms are never partially
// onboarded); the dry-run shows every error in one pass so the fixed sheet
// commits on the next attempt.
//
// Authz mirrors POST /api/services exactly, per row: engineer+ may import;
// a `tenant` column value is resolved by key then id; scoped (non-admin)
// users may only import into tenants they belong to; only admins may import
// rows without a tenant (fleet-unassigned services).

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getEngine } from '@/server/engine';
import { HttpError, readJsonBody, toErrorResponse } from '@/server/http';
import { requireRole, requireTenantAccess, roleAtLeast } from '@/server/authz';
import { getTenantById, getTenantByKey } from '@/server/tenants';
import {
  IMPORT_MAX_BYTES,
  mapServiceRow,
  parseServiceSheet,
} from '@/server/csv-import';

export const dynamic = 'force-dynamic';

export interface ImportRowResult {
  /** Physical 1-based CSV line number (header = 1; first data row = 2). */
  line: number;
  key?: string;
  name?: string;
  ok: boolean;
  error?: string;
  serviceId?: string;
}

export async function POST(req: Request) {
  try {
    const user = await requireRole(req, 'engineer');
    const body = (await readJsonBody(req)) as { csv?: unknown; mode?: unknown };

    if (typeof body.csv !== 'string' || body.csv.trim() === '') {
      throw new HttpError(400, "Body must be JSON with a non-empty 'csv' string");
    }
    if (body.csv.length > IMPORT_MAX_BYTES) {
      throw new HttpError(413, `CSV exceeds ${IMPORT_MAX_BYTES} bytes`);
    }
    const mode = body.mode === 'commit' ? 'commit' : 'dryRun';

    const sheet = parseServiceSheet(body.csv);
    if (!sheet.ok) throw new HttpError(400, sheet.error);

    const results: ImportRowResult[] = [];
    const seenKeys = new Set<string>();
    let failures = 0;

    // Row-level cache of tenant lookups — a 50-row sheet for one client
    // should hit the DB once, not 50 times.
    const tenantCache = new Map<string, { id: string; key: string } | null>();

    for (const sheetRow of sheet.rows) {
      const result: ImportRowResult = { line: sheetRow.line, ok: false };
      const mapped = mapServiceRow(sheetRow.fields, sheet.headerIndex);
      if (mapped.ok) {
        result.key = mapped.row.key;
        result.name = mapped.row.name;
      }

      try {
        if (!mapped.ok) throw new HttpError(400, mapped.error);

        // Duplicate key within the sheet.
        if (seenKeys.has(mapped.row.key)) {
          throw new HttpError(409, `Duplicate key '${mapped.row.key}' earlier in this CSV`);
        }
        seenKeys.add(mapped.row.key);

        // Tenant column: resolve by key first, then by id.
        let tenantId: string | null = null;
        if (mapped.row.tenant) {
          const cacheKey = mapped.row.tenant;
          if (!tenantCache.has(cacheKey)) {
            const byKey = await getTenantByKey(cacheKey);
            const found = byKey ? { id: byKey.id, key: byKey.key } : null;
            if (!found) {
              const byId = await getTenantById(cacheKey);
              tenantCache.set(cacheKey, byId ? { id: byId.id, key: byId.key } : null);
            } else {
              tenantCache.set(cacheKey, found);
            }
          }
          const tenant = tenantCache.get(cacheKey);
          if (!tenant) {
            throw new HttpError(
              404,
              `Tenant '${cacheKey}' not found (no tenant with this key or id)`,
            );
          }
          try {
            await requireTenantAccess(user, tenant.id);
          } catch (err) {
            if (err instanceof HttpError) {
              throw new HttpError(403, `Client '${tenant.key}' is outside your assigned clients`);
            }
            throw err;
          }
          tenantId = tenant.id;
        } else if (!roleAtLeast(user, 'admin')) {
          throw new HttpError(
            403,
            'Rows without a tenant require the admin role — set the tenant column',
          );
        }

        // Duplicate key already registered.
        const existing = await db.service.findUnique({ where: { key: mapped.row.key } });
        if (existing) {
          throw new HttpError(409, `Service key '${mapped.row.key}' already exists`);
        }

        result.ok = true;
      } catch (err) {
        if (err instanceof HttpError) {
          result.error = err.message;
        } else {
          result.error = 'Unexpected row error';
        }
      }
      if (!result.ok) failures += 1;
      results.push(result);
    }

    const total = results.length;
    const report = { mode, total, ok: total - failures, failed: failures, rows: results };

    // Dry-run stops here — same pipeline, zero writes.
    if (mode !== 'commit') {
      return NextResponse.json({ ...report, committed: false });
    }

    // All-or-nothing commit: any failing row aborts the whole import.
    if (failures > 0) {
      return NextResponse.json(
        {
          ...report,
          committed: false,
          error: `Import aborted: ${failures} of ${total} rows failed. Fix the sheet and re-run (a dry-run shows every failing row at once).`,
        },
        { status: 422 },
      );
    }

    // Recompute the validated rows from the CSV (mapServiceRow is pure and
    // already type-checked every row — no failures above means every row
    // maps cleanly).
    const validated = sheet.rows
      .map((sr) => mapServiceRow(sr.fields, sheet.headerIndex))
      .filter((m): m is Extract<typeof m, { ok: true }> => m.ok);

    const created = await db.$transaction(
      validated.map((m) => {
        const row = m.row;
        const tenantId = row.tenant ? (tenantCache.get(row.tenant)?.id ?? null) : null;
        return db.service.create({
          data: {
            key: row.key,
            name: row.name,
            nameFa: row.nameFa ?? null,
            tier: row.tier ?? 'tier-2',
            endpoint: row.endpoint ?? `https://${row.key}.example.ir/health`,
            baseLatencyMs: row.baseLatencyMs ?? 120,
            tps: row.tps ?? 50,
            avgTransactionValue: row.avgTransactionValue ?? 250000,
            slaTarget: row.slaTarget ?? 0.999,
            penaltyBase: row.penaltyBase ?? 50000000,
            penaltyPerMinute: row.penaltyPerMinute ?? 7500000,
            criticality: row.criticality ?? 'medium',
            probeSource: null,
            enabled: true,
            ...(tenantId ? { tenantId } : {}),
          },
        });
      }),
    );

    await getEngine().reloadServices(); // engine picks them all up next tick

    return NextResponse.json(
      { ...report, committed: true, serviceIds: created.map((s) => s.id) },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
