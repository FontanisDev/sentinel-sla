// /api/escalation — GET: read the fleet escalation policy | PUT: edit it.
//
//   GET → EscalationPolicyDTO (seeds the default row on first read)
//   PUT → 200 + EscalationPolicyDTO, 400 validation
//
// The engine re-reads the policy row on every ladder check (~5s), so edits
// take effect without any restart. readJsonBody is imported from http.ts like
// every other mutation route.

import { NextResponse } from 'next/server';
import { getEngine } from '@/server/engine';
import { readJsonBody, toErrorResponse } from '@/server/http';
import { getEscalationPolicy, updateEscalationPolicy } from '@/server/escalation';
import { updateEscalationSchema } from '@/server/validation';
import { requireRole, requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireUser(req); // phase-2 authz
    await getEngine().ensureInit();
    return NextResponse.json(await getEscalationPolicy());
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(req: Request) {
  try {
    await requireRole(req, 'engineer'); // phase-2 authz
    const parsed = updateEscalationSchema.parse(await readJsonBody(req));
    await getEngine().ensureInit();
    return NextResponse.json(await updateEscalationPolicy(parsed));
  } catch (err) {
    return toErrorResponse(err);
  }
}
