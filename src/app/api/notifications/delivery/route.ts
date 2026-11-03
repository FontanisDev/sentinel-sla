// GET /api/notifications/delivery — the delivery log ("delivery
// log with status and error text").
//
//   ?channelId=<id>  optional filter for one channel's page
//   ?limit=<n>       default 50, cap 200
//
//   200 → DeliveryLogRow[] (newest first: kind, ok, statusCode, error,
//         latencyMs, at, message title/severity/test flag)
//
// Engineer floor (ops read).

import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/server/http';
import { requireRole, requireUser } from '@/server/authz';
import { getEngine } from '@/server/engine';
import { recentDeliveryLog } from '@/server/notify/outbox';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireUser(req); // phase-2 authz: telemetry read, all roles
    await getEngine().ensureInit();
    const url = new URL(req.url);
    const channelId = url.searchParams.get('channelId');
    const limitRaw = Number(url.searchParams.get('limit') ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50;
    if (channelId !== null && !/^[a-zA-Z0-9_-]{1,64}$/.test(channelId)) {
      return NextResponse.json({ error: 'invalid channelId' }, { status: 400 });
    }
    const rows = await recentDeliveryLog({ channelId: channelId ?? undefined, limit });
    return NextResponse.json(rows);
  } catch (err) {
    return toErrorResponse(err);
  }
}
