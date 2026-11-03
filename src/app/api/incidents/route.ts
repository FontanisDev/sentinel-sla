// GET /api/incidents — recent incidents (join service name), optional status
// filter and optional inclusive startedAt bounds (?since=&until=, ISO with
// offset) — the server twin of the §6.8 TimeRange picker.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { toIncidentDTO } from '@/server/dto';
import { toErrorResponse } from '@/server/http';
import { incidentQuerySchema } from '@/server/validation';
import { requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireUser(req); // phase-2 authz
    const url = new URL(req.url);
    const parsed = incidentQuerySchema.parse({
      limit: url.searchParams.get('limit') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      since: url.searchParams.get('since') ?? undefined,
      until: url.searchParams.get('until') ?? undefined,
    });
    const limit = parsed.limit ?? 20;
    const incidents = await db.incident.findMany({
      where: {
        ...(parsed.status ? { status: parsed.status } : {}),
        ...(parsed.since || parsed.until
          ? {
              startedAt: {
                ...(parsed.since ? { gte: new Date(parsed.since) } : {}),
                ...(parsed.until ? { lte: new Date(parsed.until) } : {}),
              },
            }
          : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: { service: true },
    });
    return NextResponse.json({ incidents: incidents.map(toIncidentDTO) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
