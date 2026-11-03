// POST /api/schedules/[id]/run — fire a schedule's report pipeline NOW.
//
//   → 200 + ReportScheduleDTO (lastRunAt advanced), 404 unknown id,
//     500 PDF pipeline failure
//
// Same code path as the engine's due-run (generatedBy 'scheduled') — the
// button exists so the full cron pipeline is observable without waiting
// for the real calendar slot.

import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/server/http';
import { runReportSchedule } from '@/server/reportscheduling';
import { governanceIdSchema } from '@/server/validation';
import { requireRole, requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireRole(req, 'engineer'); // phase-2 authz: ops mutation
    const { id } = await context.params;
    const scheduleId = governanceIdSchema.parse(id);
    // 'manual' trigger — the firing lands in the ScheduleRun audit trail
    // with the Run-now origin, distinct from engine due-runs.
    return NextResponse.json(await runReportSchedule(scheduleId, 'manual'));
  } catch (err) {
    return toErrorResponse(err);
  }
}
