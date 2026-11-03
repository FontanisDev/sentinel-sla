// GET /api/analytics — richer executive reporting (post-MVP):
//   ?tenant=<tenantId|all>   — scope to one tenant's services (unknown id → 404;
//                              absent or `all` = fleet-wide)
//   ?windowHours=<1-24>      — rolling window (default 24, clamped to 1–24)
//
// Returns AnalyticsDTO (error budgets, hourly MTTD/MTTR/penalty trends, and a
// 5-minute service-availability heatmap over the last ≤6h of snapshots).

import { NextResponse } from 'next/server';
import { computeAnalytics } from '@/server/analytics';
import { getEngine } from '@/server/engine';
import { toErrorResponse } from '@/server/http';
import { clampInt, analyticsQuerySchema } from '@/server/validation';
import { resolveTenant } from '@/server/tenants';
import { requireUser, resolveTenantScope } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const user = await requireUser(req); // phase-2 authz
    const url = new URL(req.url);
    const parsed = analyticsQuerySchema.parse({
      tenant: url.searchParams.get('tenant') ?? undefined,
      windowHours: url.searchParams.get('windowHours') ?? undefined,
    });
    const windowHours = clampInt(parsed.windowHours ?? 24, 1, 24);

    await getEngine().ensureInit(); // seeding (tenants) + fresh service cache
    const tenant = await resolveTenant(parsed.tenant ?? null);
    const { tenantId } = await resolveTenantScope(user, tenant ? tenant.id : null); // 403 out-of-scope
    const analytics = await computeAnalytics(tenantId, windowHours);
    return NextResponse.json(analytics);
  } catch (err) {
    return toErrorResponse(err);
  }
}
