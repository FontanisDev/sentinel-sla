// GET /api/export/services — data export of the live service fleet (v2.1).
//
// Query params (zod-validated; invalid → 400 {error}):
//   ?format=csv|json       — default csv (RFC 4180, UTF-8 BOM)
//   ?tenant=<tenantId|all> — scope to one tenant's services (unknown id → 404)
//
// Live values (status, uptime, avgLatencyMs, errorRate, tps) are read from the
// engine's service snapshot; `tps` is the CURRENT transactions/sec (the
// engine's live throughput), matching the export's "point-in-time" semantics.
// Content-Disposition: attachment; filename="sentinel-services-<ts>.csv|json".

import { getEngine } from '@/server/engine';
import { csvAttachment, exportTimestamp, jsonAttachment } from '@/server/export';
import { toErrorResponse } from '@/server/http';
import { resolveTenant } from '@/server/tenants';
import { exportQuerySchema } from '@/server/validation';
import { requireUser, resolveTenantScope } from '@/server/authz';
import { enforceRateLimit, RATE_RULES } from '@/server/ratelimit';

export const dynamic = 'force-dynamic';

const SERVICE_EXPORT_HEADERS = [
  'key',
  'name',
  'nameFa',
  'tenantName',
  'tier',
  'criticality',
  'endpoint',
  'status',
  'slaTarget',
  'uptime',
  'avgLatencyMs',
  'errorRate',
  'tps',
] as const;

export async function GET(req: Request) {
  try {
    const limited = enforceRateLimit(req, 'export', RATE_RULES.export);
    if (limited) return limited;

    const user = await requireUser(req); // phase-2 authz
    const url = new URL(req.url);
    const parsed = exportQuerySchema.parse({
      format: url.searchParams.get('format') ?? undefined,
      tenant: url.searchParams.get('tenant') ?? undefined,
    });
    const format = parsed.format ?? 'csv';

    const tenant = await resolveTenant(parsed.tenant ?? null);
    const { tenantId } = await resolveTenantScope(user, tenant ? tenant.id : null); // 403 out-of-scope
    const services = await getEngine().listServices(); // live values + fresh config
    const scoped =
      tenantId === null ? services : services.filter((s) => s.tenantId === tenantId);

    const rows = scoped.map((s) => ({
      key: s.key,
      name: s.name,
      nameFa: s.nameFa,
      tenantName: s.tenantName,
      tier: s.tier,
      criticality: s.criticality,
      endpoint: s.endpoint,
      status: s.status,
      slaTarget: s.slaTarget,
      uptime: s.uptime, // latest uptime ratio from the engine snapshot
      avgLatencyMs: s.latencyMs, // current
      errorRate: s.errorRate, // current
      tps: s.throughput, // current transactions/sec
    }));

    const ts = exportTimestamp();
    if (format === 'json') {
      return jsonAttachment(rows, `sentinel-services-${ts}.json`);
    }
    return csvAttachment([...SERVICE_EXPORT_HEADERS], rows, `sentinel-services-${ts}.csv`);
  } catch (err) {
    return toErrorResponse(err);
  }
}
