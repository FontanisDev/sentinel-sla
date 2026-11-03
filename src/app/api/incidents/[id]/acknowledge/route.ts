// POST /api/incidents/[id]/acknowledge — v2.5 on-call ownership.
// Stamps acknowledgedAt/by + MTTA on an ongoing incident; 409 when already
// acknowledged or resolved. Body `{ "by": "<handle>" }` is optional.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getEngine } from '@/server/engine';
import { toIncidentDTO } from '@/server/dto';
import { toErrorResponse } from '@/server/http';
import { acknowledgeIncidentSchema } from '@/server/validation';
import { requireRole, requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireRole(req, 'engineer'); // phase-2 authz: ops mutation
    const { id } = await context.params;
    // Empty body is legal (defaults to 'On-call' server-side).
    let body: unknown = {};
    try {
      const raw = await req.text();
      if (raw.trim().length > 0) body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const parsed = acknowledgeIncidentSchema.parse(body);
    const incident = await getEngine().acknowledgeIncident(id, parsed.by);
    return NextResponse.json({ incident: toIncidentDTO(incident) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid acknowledge payload', details: err.issues }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}
