// GET /api/export/incidents — data export of the incident register (v2.1).
//
// Query params (all zod-validated; invalid → 400 {error}):
//   ?format=csv|json      — default csv (RFC 4180, UTF-8 BOM, Excel-friendly)
//   ?tenant=<tenantId|all>— scope to one tenant's services (unknown id → 404)
//   ?status=ongoing|resolved
//   ?limit=<1-2000>       — default 500, clamped
//
// Rows map to IncidentExportRow EXACTLY (src/lib/types.ts): financial figures
// are whole Tomans; detected/resolved are ISO strings or '' when unset.
// Content-Disposition: attachment; filename="sentinel-incidents-<ts>.csv|json".

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import type { IncidentExportRow } from '@/lib/types';
import { getEngine } from '@/server/engine';
import { csvAttachment, exportTimestamp, jsonAttachment } from '@/server/export';
import { toErrorResponse } from '@/server/http';
import { resolveTenant, serviceIdsForTenant } from '@/server/tenants';
import { clampInt, incidentsExportQuerySchema } from '@/server/validation';
import { requireUser, resolveTenantScope } from '@/server/authz';
import { enforceRateLimit, RATE_RULES } from '@/server/ratelimit';

export const dynamic = 'force-dynamic';

/** Exact field names of IncidentExportRow, in contract order. */
const INCIDENT_EXPORT_HEADERS = [
  'id',
  'service',
  'severity',
  'status',
  'source',
  'detected',
  'resolved',
  'mttdSec',
  'mttrSec',
  'durationSec',
  'transactionsLost',
  'revenueLossTomans',
  'penaltyTomans',
] as const;

export async function GET(req: Request) {
  try {
    const limited = enforceRateLimit(req, 'export', RATE_RULES.export);
    if (limited) return limited;

    const user = await requireUser(req); // phase-2 authz
    const url = new URL(req.url);
    const parsed = incidentsExportQuerySchema.parse({
      format: url.searchParams.get('format') ?? undefined,
      tenant: url.searchParams.get('tenant') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    });
    const format = parsed.format ?? 'csv';
    const limit = clampInt(parsed.limit ?? 500, 1, 2000);

    await getEngine().ensureInit();
    const tenant = await resolveTenant(parsed.tenant ?? null);
    const { tenantId } = await resolveTenantScope(user, tenant ? tenant.id : null); // 403 out-of-scope
    const scopeIds = tenantId ? await serviceIdsForTenant(tenantId) : null;

    const incidents = await db.incident.findMany({
      where: {
        ...(parsed.status ? { status: parsed.status } : {}),
        ...(scopeIds ? { serviceId: { in: scopeIds } } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: { service: true },
    });

    const rows: IncidentExportRow[] = incidents.map((inc) => ({
      id: inc.id,
      service: inc.service.name,
      severity: inc.severity,
      status: inc.status,
      source: inc.source,
      detected: inc.detectedAt ? inc.detectedAt.toISOString() : '',
      resolved: inc.resolvedAt ? inc.resolvedAt.toISOString() : '',
      mttdSec: inc.mttdSec,
      mttrSec: inc.mttrSec,
      durationSec: inc.durationSec,
      transactionsLost: inc.lostTransactions,
      // whole Tomans (warning penalties accrue as 0.3 × full → FP noise otherwise)
      revenueLossTomans: Math.round(inc.revenueLossTomans),
      penaltyTomans: Math.round(inc.penaltyTomans),
    }));

    const ts = exportTimestamp();
    if (format === 'json') {
      return jsonAttachment(rows, `sentinel-incidents-${ts}.json`);
    }
    return csvAttachment([...INCIDENT_EXPORT_HEADERS], rows, `sentinel-incidents-${ts}.csv`);
  } catch (err) {
    return toErrorResponse(err);
  }
}
