// GET /api/services/[key] — service detail payload for the /services/[key]
// page (design system §5): the live health DTO (engine), the current-window
// contract row (same math as /contracts), recent incidents, and the evidence
// trail (notifications + chaos experiments).
//
// Authz: requireUser (matches GET /api/services); tenant scoping rides on the
// service's own tenant — a scoped (non-admin) user gets a 404 for foreign
// clients so keys are not even confirmable to exist.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getEngine } from '@/server/engine';
import { toAlertDTO, toChaosDTO, toIncidentDTO } from '@/server/dto';
import { toErrorResponse } from '@/server/http';
import { requireUser, resolveTenantScope } from '@/server/authz';
import { getServiceContractRow } from '@/server/contracts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, context: { params: Promise<{ key: string }> }) {
  try {
    const user = await requireUser(req);
    const { key } = await context.params;
    const row = await db.service.findUnique({
      where: { key },
      include: { tenant: true },
    });
    if (!row) {
      return NextResponse.json({ error: 'Service not found' }, { status: 404 });
    }
    // Tenant guard — the service's own client (null tenant = fleet-wide
    // service, readable like the registry list route).
    if (row.tenantId) {
      await resolveTenantScope(user, row.tenantId);
    }
    const [service, contract, incidents, alerts, chaos] = await Promise.all([
      getEngine()
        .listServices()
        .then((list) => list.find((s) => s.key === key) ?? null),
      getServiceContractRow(row.id),
      db.incident.findMany({
        where: { serviceId: row.id },
        orderBy: { startedAt: 'desc' },
        take: 10,
        include: { service: true },
      }),
      db.alert.findMany({
        where: { serviceId: row.id },
        orderBy: { sentAt: 'desc' },
        take: 10,
        include: { service: true },
      }),
      db.chaosExperiment.findMany({
        where: { serviceId: row.id },
        orderBy: { startedAt: 'desc' },
        take: 5,
        include: { service: true },
      }),
    ]);
    if (!service || !contract) {
      return NextResponse.json({ error: 'Service not found' }, { status: 404 });
    }
    // Transaction-profile summary : which money source is live
    // and what it says — the card and the formula popovers print this.
    let tpsProfile: {
      active: boolean;
      tps: number;
      meanTps: number | null;
      peak: { bucket: number; tps: number } | null;
      coveredBuckets: number | null;
      importedAt: string | null;
      importedBy: string | null;
    } | null = null;
    if (row.tpsProfile) {
      try {
        const parsed = JSON.parse(row.tpsProfile) as {
          buckets?: number[];
          tzOffsetMinutes?: number;
          meta?: { meanTps?: number | null; importedAt?: string; importedBy?: string };
        };
        const buckets = parsed.buckets;
        if (Array.isArray(buckets) && buckets.length === 168) {
          const covered = buckets.filter((b) => b > 0).length;
          let peak: { bucket: number; tps: number } | null = null;
          buckets.forEach((tps, bucket) => {
            if (peak === null || tps > peak!.tps) peak = { bucket, tps };
          });
          tpsProfile = {
            active: true,
            tps: row.tps,
            meanTps: typeof parsed.meta?.meanTps === 'number' ? parsed.meta.meanTps : null,
            peak,
            coveredBuckets: covered,
            importedAt: parsed.meta?.importedAt ?? null,
            importedBy: parsed.meta?.importedBy ?? null,
          };
        } else {
          // Corrupt row: surface honestly instead of pretending flat money.
          tpsProfile = { active: false, tps: row.tps, meanTps: null, peak: null, coveredBuckets: null, importedAt: null, importedBy: null };
        }
      } catch {
        tpsProfile = { active: false, tps: row.tps, meanTps: null, peak: null, coveredBuckets: null, importedAt: null, importedBy: null };
      }
    }
    return NextResponse.json({
      service,
      contract,
      tpsProfile,
      incidents: incidents.map(toIncidentDTO),
      alerts: alerts.map((a) => toAlertDTO(a)),
      chaos: chaos.map(toChaosDTO),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
