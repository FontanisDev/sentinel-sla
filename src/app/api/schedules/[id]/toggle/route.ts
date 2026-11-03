// POST /api/schedules/[id]/toggle — enable or pause a report schedule.
//
//   body { enabled: boolean } → 200 + ReportScheduleDTO, 404 unknown id, 400 invalid

import { NextResponse } from 'next/server';
import { readJsonBody, toErrorResponse } from '@/server/http';
import { setReportScheduleEnabled } from '@/server/reportscheduling';
import { governanceIdSchema, scheduleToggleSchema } from '@/server/validation';
import { requireRole, requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireRole(req, 'engineer'); // phase-2 authz: ops mutation
    const { id } = await context.params;
    const scheduleId = governanceIdSchema.parse(id);
    const { enabled } = scheduleToggleSchema.parse(await readJsonBody(req));
    return NextResponse.json(await setReportScheduleEnabled(scheduleId, enabled));
  } catch (err) {
    return toErrorResponse(err);
  }
}
