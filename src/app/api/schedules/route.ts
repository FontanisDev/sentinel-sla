// /api/schedules — GET: list report schedules | POST: create one.
//
//   GET  → ReportScheduleDTO[] (enabled first, oldest first)
//   POST → 201 + ReportScheduleDTO, 400 validation, 404 unknown tenant
//
// Due schedules are fired by the engine tick (see src/server/reportscheduling.ts
// + engine.ts); this route is pure CRUD over the same rows.

import { NextResponse } from 'next/server';
import { getEngine } from '@/server/engine';
import { readJsonBody, toErrorResponse } from '@/server/http';
import { createReportSchedule, listReportSchedules } from '@/server/reportscheduling';
import { createReportScheduleSchema } from '@/server/validation';
import { requireRole, requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireUser(req); // phase-2 authz
    await getEngine().ensureInit();
    return NextResponse.json(await listReportSchedules());
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    await requireRole(req, 'engineer'); // phase-2 authz
    const parsed = createReportScheduleSchema.parse(await readJsonBody(req));
    await getEngine().ensureInit();
    const schedule = await createReportSchedule(parsed);
    return NextResponse.json(schedule, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
