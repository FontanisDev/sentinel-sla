// /api/maintenance — GET: list maintenance windows | POST: open a window.
//
// Response shapes follow the contract convention (bare payloads):
//   GET  → MaintenanceWindowDTO[] (active first, then recently ended; limit 15)
//   POST → 201 + MaintenanceWindowDTO (bare), 400 validation, 404 unknown service
//
// While a window is ACTIVE, alert delivery is suppressed for the covered
// service (serviceId omitted/null = fleet-wide); incidents are still detected
// and recorded — SLA truth is never altered (see src/server/maintenance.ts).

import { NextResponse } from 'next/server';
import { getEngine } from '@/server/engine';
import { readJsonBody, toErrorResponse } from '@/server/http';
import { createMaintenanceWindow, listMaintenanceWindows } from '@/server/maintenance';
import { createMaintenanceWindowSchema } from '@/server/validation';
import { requireRole, requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireUser(req); // phase-2 authz
    // ensureInit runs the (idempotent) seed so services exist even on a cold
    // boot; listMaintenanceWindows lazily expires due windows first.
    await getEngine().ensureInit();
    return NextResponse.json(await listMaintenanceWindows());
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    await requireRole(req, 'engineer'); // phase-2 authz
    const parsed = createMaintenanceWindowSchema.parse(await readJsonBody(req));
    await getEngine().ensureInit();
    const window = await createMaintenanceWindow(parsed);
    return NextResponse.json(window, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
