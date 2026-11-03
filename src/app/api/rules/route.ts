// /api/rules — GET: list alert policy rules | POST: create one.
//
//   GET  → AlertRuleDTO[] (enabled first, newest first)
//   POST → 201 + AlertRuleDTO, 400 validation, 404 unknown service
//
// Rules are evaluated by the engine every ~5s against live service metrics
// (see src/server/alertgovernance.ts + engine.evaluateAlertRules).

import { NextResponse } from 'next/server';
import { getEngine } from '@/server/engine';
import { readJsonBody, toErrorResponse } from '@/server/http';
import { createAlertRule, listAlertRules } from '@/server/alertgovernance';
import { createAlertRuleSchema } from '@/server/validation';
import { requireRole, requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireUser(req); // phase-2 authz
    await getEngine().ensureInit();
    return NextResponse.json(await listAlertRules());
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    await requireRole(req, 'engineer'); // phase-2 authz
    const parsed = createAlertRuleSchema.parse(await readJsonBody(req));
    await getEngine().ensureInit();
    const rule = await createAlertRule(parsed);
    return NextResponse.json(rule, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
