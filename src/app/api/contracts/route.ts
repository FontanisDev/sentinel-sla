// GET /api/contracts — contract compliance view for the current Jalali month
//. Exec-facing money view; every authenticated
// role may read it (the dashboard already exposes the same money figures),
// tenant-scoped exactly like /api/dashboard via resolveTenantScope.
//
// Query params:
//   ?tenant=<tenantId>  — one client (unknown id → 404)
//   ?tenant=all         — fleet-wide scope (default when the param is absent)

import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/server/http';
import { parseTenantParam } from '@/server/tenants';
import { requireUser, resolveTenantScope } from '@/server/authz';
import { getContractsSnapshot } from '@/server/contracts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const url = new URL(req.url);
    const requested = parseTenantParam(url.searchParams.get('tenant'));
    const { tenantId } = await resolveTenantScope(user, requested); // 403 out-of-scope
    const snapshot = await getContractsSnapshot(tenantId);
    return NextResponse.json(snapshot);
  } catch (err) {
    return toErrorResponse(err);
  }
}
