// /api/notifications/outbox — the dead-letter office.
//
//   GET  ?status=pending|delivering|delivered|dead&limit=n
//        → outbox rows (newest first) — engineers see the queue + dead letters
//   POST { id, action: 'retry' }
//        → requeue a dead-lettered message (admin floor) → { ok: true }
//
// Retry resets attempts to 0 so the backoff ladder starts fresh; the message
// keeps its history in the delivery log.

import { NextResponse } from 'next/server';
import { HttpError, readJsonBody, toErrorResponse } from '@/server/http';
import { requireRole, requireUser } from '@/server/authz';
import { getEngine } from '@/server/engine';
import { listOutbox, retryDead } from '@/server/notify/outbox';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const outboxQuerySchema = z.object({
  status: z.enum(['pending', 'delivering', 'delivered', 'dead']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const retrySchema = z.object({
  id: z.string().trim().min(1).max(64),
  action: z.literal('retry'),
});

export async function GET(req: Request) {
  try {
    await requireUser(req); // phase-2 authz: telemetry read, all roles
    await getEngine().ensureInit();
    const url = new URL(req.url);
    const q = outboxQuerySchema.parse({
      status: url.searchParams.get('status') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    });
    return NextResponse.json(await listOutbox({ status: q.status, limit: q.limit }));
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    await requireRole(req, 'admin'); // requeueing dead letters is an admin call
    const parsed = retrySchema.parse(await readJsonBody(req));
    const ok = await retryDead(parsed.id);
    if (!ok) throw new HttpError(404, 'No dead-lettered message with that id');
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
