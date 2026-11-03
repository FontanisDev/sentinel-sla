// GET /api/export/analytics — JSON download of the analytics payload (v2.1).
//
// Query params (zod-validated; invalid → 400 {error}):
//   ?format=json           — the ONLY supported format (csv → 400 with a clear
//                            message; the payload is nested, not tabular)
//   ?tenant=<tenantId|all> — scope to one tenant's services (unknown id → 404)
//   ?windowHours=<1-24>    — default 24, clamped
//
// Body = AnalyticsDTO (bare) — reuses computeAnalytics from src/server/analytics.ts.
// Content-Disposition: attachment; filename="sentinel-analytics-<ts>.json".

import { computeAnalytics } from '@/server/analytics';
import { getEngine } from '@/server/engine';
import { exportTimestamp, jsonAttachment } from '@/server/export';
import { HttpError, toErrorResponse } from '@/server/http';
import { resolveTenant } from '@/server/tenants';
import { analyticsExportQuerySchema, clampInt } from '@/server/validation';
import { requireUser, resolveTenantScope } from '@/server/authz';
import { enforceRateLimit, RATE_RULES } from '@/server/ratelimit';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const limited = enforceRateLimit(req, 'export', RATE_RULES.export);
    if (limited) return limited;

    const user = await requireUser(req); // phase-2 authz
    const url = new URL(req.url);
    const parsed = analyticsExportQuerySchema.parse({
      format: url.searchParams.get('format') ?? undefined,
      tenant: url.searchParams.get('tenant') ?? undefined,
      windowHours: url.searchParams.get('windowHours') ?? undefined,
    });
    const format = parsed.format ?? 'json';
    if (format === 'csv') {
      throw new HttpError(400, 'Analytics export supports JSON only — use format=json');
    }
    const windowHours = clampInt(parsed.windowHours ?? 24, 1, 24);

    await getEngine().ensureInit(); // seeding + fresh service cache
    const tenant = await resolveTenant(parsed.tenant ?? null);
    const { tenantId } = await resolveTenantScope(user, tenant ? tenant.id : null); // 403 out-of-scope
    const analytics = await computeAnalytics(tenantId, windowHours);
    return jsonAttachment(analytics, `sentinel-analytics-${exportTimestamp()}.json`);
  } catch (err) {
    return toErrorResponse(err);
  }
}
