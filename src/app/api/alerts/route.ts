// GET /api/alerts — recent alerts, newest first.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { toAlertDTO } from '@/server/dto';
import { toErrorResponse } from '@/server/http';
import { alertQuerySchema } from '@/server/validation';
import { requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireUser(req); // phase-2 authz
    const url = new URL(req.url);
    const parsed = alertQuerySchema.parse({
      limit: url.searchParams.get('limit') ?? undefined,
    });
    const limit = parsed.limit ?? 25;
    const alerts = await db.alert.findMany({
      orderBy: { sentAt: 'desc' },
      take: limit,
      include: { service: true },
    });
    return NextResponse.json({ alerts: alerts.map(toAlertDTO) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
