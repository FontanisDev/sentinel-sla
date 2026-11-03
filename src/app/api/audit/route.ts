// GET /api/audit — read the audit trail (admin+).
//
// Filters: action, actorId, hours (lookback), take (max 200, default 50).
// Also returns the distinct action vocabulary so the Settings UI can render
// a filter dropdown without hardcoding labels. Read-only — no rate limit
// beyond the generic API cost (indexed queries only).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { toErrorResponse } from '@/server/http';
import { requireRole } from '@/server/authz';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  action: z.string().trim().max(60).optional(),
  actorId: z.string().trim().max(64).optional(),
  hours: z.coerce.number().int().min(1).max(24 * 90).optional(),
  take: z.coerce.number().int().min(1).max(200).default(50),
});

function toEntryDTO(row: {
  id: string;
  ts: Date;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  detail: string | null;
  ip: string | null;
}) {
  return {
    id: row.id,
    ts: row.ts.toISOString(),
    actorType: row.actorType,
    actorId: row.actorId,
    actorName: row.actorName,
    action: row.action,
    detail: row.detail,
    ip: row.ip,
  };
}

export async function GET(req: Request) {
  try {
    await requireRole(req, 'admin');

    const url = new URL(req.url);
    const q = querySchema.parse({
      action: url.searchParams.get('action') ?? undefined,
      actorId: url.searchParams.get('actorId') ?? undefined,
      hours: url.searchParams.get('hours') ?? undefined,
      take: url.searchParams.get('take') ?? undefined,
    });

    const since = q.hours ? new Date(Date.now() - q.hours * 3600_000) : null;

    const [rows, actions] = await Promise.all([
      db.auditLog.findMany({
        where: {
          ...(q.action ? { action: q.action } : {}),
          ...(q.actorId ? { actorId: q.actorId } : {}),
          ...(since ? { ts: { gte: since } } : {}),
        },
        orderBy: { ts: 'desc' },
        take: q.take,
      }),
      db.auditLog.findMany({
        distinct: ['action'],
        select: { action: true },
        orderBy: { action: 'asc' },
      }),
    ]);

    return NextResponse.json({
      entries: rows.map(toEntryDTO),
      actions: actions.map((a) => a.action),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
