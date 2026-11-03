// GET /api/incidents/[id] — incident detail payload for the /incidents/[id]
// page (design system §5): the incident, the notifications sent about it
// (evidence panel) and the other incidents of the same service (context).
//
// Authz: requireUser (reads are open to every signed-in role, matching
// GET /api/incidents); tenant scoping rides on the OWNING SERVICE — a scoped
// (non-admin) user can only open incidents of services inside their own
// memberships, everything else is a 404 so ids from foreign tenants are not
// even confirmable to exist.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { toAlertDTO, toIncidentDTO } from '@/server/dto';
import { toErrorResponse } from '@/server/http';
import { requireUser, resolveTenantScope } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req);
    const { id } = await context.params;
    const row = await db.incident.findUnique({
      where: { id },
      include: { service: true },
    });
    if (!row) {
      return NextResponse.json({ error: 'Incident not found' }, { status: 404 });
    }
    // Tenant guard — incidents inherit their service's tenant (null tenant =
    // fleet-wide service, readable like the ledger list route).
    if (row.service.tenantId) {
      await resolveTenantScope(user, row.service.tenantId);
    }
    const [alerts, related] = await Promise.all([
      db.alert.findMany({
        where: { incidentId: id },
        orderBy: { sentAt: 'desc' },
        take: 12,
        include: { service: true },
      }),
      db.incident.findMany({
        where: { serviceId: row.serviceId, id: { not: id } },
        orderBy: { startedAt: 'desc' },
        take: 6,
        include: { service: true },
      }),
    ]);
    return NextResponse.json({
      incident: toIncidentDTO(row),
      alerts: alerts.map((a) => toAlertDTO(a)),
      related: related.map(toIncidentDTO),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
