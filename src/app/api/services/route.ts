// /api/services — GET: monitored services | POST: add a service (picked up by the engine next tick).
//
// v2: POST accepts an optional `tenantId` to assign the service to a tenant
// (must exist → 404 otherwise).

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getEngine } from '@/server/engine';
import { HttpError, readJsonBody, toErrorResponse } from '@/server/http';
import { createServiceSchema } from '@/server/validation';
import { assignServiceTenant, getTenantById } from '@/server/tenants';
import { requireRole, requireUser, requireTenantAccess, roleAtLeast } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireUser(req); // phase-2 authz
    const services = await getEngine().listServices();
    return NextResponse.json({ services });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireRole(req, 'engineer'); // phase-2 authz: ops mutation
    const parsed = createServiceSchema.parse(await readJsonBody(req));

    const existing = await db.service.findUnique({ where: { key: parsed.key } });
    if (existing) {
      throw new HttpError(409, `Service key '${parsed.key}' already exists`);
    }

    let tenantId: string | null = null;
    if (parsed.tenantId) {
      const tenant = await getTenantById(parsed.tenantId);
      if (!tenant) throw new HttpError(404, `Tenant '${parsed.tenantId}' not found`);
      // phase-2 tenant scope: a scoped engineer cannot assign into a client
      // they do not belong to.
      await requireTenantAccess(user, tenant.id);
      tenantId = tenant.id;
    } else if (!roleAtLeast(user, 'admin')) {
      // Scoped users must name their client explicitly; only admins may
      // create fleet-unassigned services.
      throw new HttpError(403, 'Select one of your assigned clients (tenantId).');
    }

    const created = await db.service.create({
      data: {
        key: parsed.key,
        name: parsed.name,
        nameFa: parsed.nameFa ?? null,
        tier: parsed.tier ?? 'tier-2',
        endpoint: parsed.endpoint ?? `https://${parsed.key}.example.ir/health`,
        baseLatencyMs: parsed.baseLatencyMs ?? 120,
        tps: parsed.tps ?? 50,
        avgTransactionValue: parsed.avgTransactionValue ?? 250000,
        slaTarget: parsed.slaTarget ?? 0.999,
        penaltyBase: parsed.penaltyBase ?? 50000000,
        penaltyPerMinute: parsed.penaltyPerMinute ?? 7500000,
        criticality: parsed.criticality ?? 'medium',
        probeSource: parsed.probeSource ? JSON.stringify(parsed.probeSource) : null,
        enabled: true,
      },
    });

    if (tenantId) await assignServiceTenant(created.id, tenantId);

    const engine = getEngine();
    await engine.reloadServices(); // engine picks it up immediately
    const dto = await engine.getServiceDTO(created.id);
    return NextResponse.json({ service: dto }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
