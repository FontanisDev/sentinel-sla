// POST /api/maintenance/[id]/cancel — on-call aborts planned maintenance.
// POST-action route for consistency with /api/incidents/[id]/resolve.
//
//   200 → MaintenanceWindowDTO (status 'cancelled')
//   404 unknown window, 409 window not active, 400 invalid id

import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/server/http';
import { cancelMaintenanceWindow } from '@/server/maintenance';
import { maintenanceIdSchema } from '@/server/validation';
import { requireRole, requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireRole(req, 'engineer'); // phase-2 authz: ops mutation
    const { id } = await context.params;
    const windowId = maintenanceIdSchema.parse(id);
    return NextResponse.json(await cancelMaintenanceWindow(windowId));
  } catch (err) {
    return toErrorResponse(err);
  }
}
