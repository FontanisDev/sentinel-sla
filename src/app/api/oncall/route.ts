// /api/oncall — GET: rotation entries | POST: add one.
//
//   GET  → OnCallEntryDTO[] (sorted by day, then start), `active` computed vs now
//   POST → 201 + OnCallEntryDTO, 400 validation

import { NextResponse } from 'next/server';
import { getEngine } from '@/server/engine';
import { readJsonBody, toErrorResponse } from '@/server/http';
import { createOnCallEntry, listOnCall } from '@/server/alertgovernance';
import { createOnCallSchema } from '@/server/validation';
import { requireRole, requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireUser(req); // phase-2 authz
    await getEngine().ensureInit();
    return NextResponse.json(await listOnCall());
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    await requireRole(req, 'engineer'); // phase-2 authz
    const parsed = createOnCallSchema.parse(await readJsonBody(req));
    await getEngine().ensureInit();
    const entry = await createOnCallEntry(parsed);
    return NextResponse.json(entry, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
