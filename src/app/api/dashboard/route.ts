// GET /api/dashboard — full live snapshot (engine state, KPIs, tenants, services,
// incidents, alerts, chaos, reports, maintenance windows).
//
// Query params:
//   ?tenant=<tenantId>  — scope services, KPIs, incidents, alerts and chaos
//                         experiments to one tenant (unknown id → 404)
//   ?tenant=all         — fleet-wide scope (default when the param is absent)

import { NextResponse } from 'next/server';
import { getEngine } from '@/server/engine';
import { toErrorResponse } from '@/server/http';
import { parseTenantParam } from '@/server/tenants';
import { requireUser, resolveTenantScope } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const user = await requireUser(req); // phase-2 authz
    const url = new URL(req.url);
    const requested = parseTenantParam(url.searchParams.get('tenant'));
    const { tenantId } = await resolveTenantScope(user, requested); // 403 out-of-scope
    const snapshot = await getEngine().getDashboardSnapshot(tenantId);
    return NextResponse.json(snapshot);
  } catch (err) {
    return toErrorResponse(err);
  }
}
