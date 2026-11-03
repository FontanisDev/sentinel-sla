// POST /api/incidents/[id]/resolve — on-call manual intervention.

import { NextResponse } from 'next/server';
import { getEngine } from '@/server/engine';
import { toIncidentDTO } from '@/server/dto';
import { toErrorResponse } from '@/server/http';
import { requireRole, requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireRole(req, 'engineer'); // phase-2 authz: ops mutation
    const { id } = await context.params;
    const incident = await getEngine().resolveManually(id);
    return NextResponse.json({ incident: toIncidentDTO(incident) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
