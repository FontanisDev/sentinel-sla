// GET /api/schedules/runs — v2.5 schedule firing audit trail.
//
//   → ScheduleRunDTO[] (newest first, default 8, max 50)
//
// Every due-run and Run-now lands here — success (with the produced report)
// and failure (with the error's first line) alike. The dashboard embeds the
// newest 8; this route exists for deeper inspection / support tooling.
// NOTE: static segment wins over /api/schedules/[id] in Next.js routing.

import { NextResponse } from 'next/server';
import { getEngine } from '@/server/engine';
import { toErrorResponse } from '@/server/http';
import { listScheduleRuns } from '@/server/reportscheduling';
import { requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireUser(req); // phase-2 authz
    await getEngine().ensureInit();
    const url = new URL(req.url);
    const raw = Number(url.searchParams.get('limit') ?? 8);
    const limit = Number.isFinite(raw) ? Math.min(50, Math.max(1, Math.trunc(raw))) : 8;
    return NextResponse.json(await listScheduleRuns(limit));
  } catch (err) {
    return toErrorResponse(err);
  }
}
