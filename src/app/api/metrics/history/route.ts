// GET /api/metrics/history?serviceId=&minutes= — persisted metric snapshots (helper for charts).

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import type { ServiceStatus } from '@/lib/types';
import { HttpError, toErrorResponse } from '@/server/http';
import { clampInt, metricsHistoryQuerySchema } from '@/server/validation';
import { requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireUser(req); // phase-2 authz
    const url = new URL(req.url);
    const parsed = metricsHistoryQuerySchema.parse({
      serviceId: url.searchParams.get('serviceId') ?? '',
      minutes: url.searchParams.get('minutes') ?? undefined,
    });
    const service = await db.service.findUnique({ where: { id: parsed.serviceId } });
    if (!service) throw new HttpError(404, 'Service not found');

    const minutes = clampInt(parsed.minutes ?? 60, 5, 360); // default 60, clamp 5–360
    const since = new Date(Date.now() - minutes * 60_000);
    const snapshots = await db.metricSnapshot.findMany({
      where: { serviceId: service.id, ts: { gte: since } },
      orderBy: { ts: 'asc' },
    });

    return NextResponse.json({
      snapshots: snapshots.map((s) => ({
        ts: s.ts.getTime(),
        latencyMs: s.latencyMs,
        errorRate: s.errorRate,
        throughput: s.throughput,
        status: s.status as ServiceStatus,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
