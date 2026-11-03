// POST /api/rules/[id]/toggle — enable or disable a policy rule.
//
//   body { enabled: boolean } → 200 + AlertRuleDTO, 404 unknown rule, 400 invalid

import { NextResponse } from 'next/server';
import { readJsonBody, toErrorResponse } from '@/server/http';
import { setAlertRuleEnabled } from '@/server/alertgovernance';
import { governanceIdSchema, ruleToggleSchema } from '@/server/validation';
import { requireRole, requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireRole(req, 'engineer'); // phase-2 authz: ops mutation
    const { id } = await context.params;
    const ruleId = governanceIdSchema.parse(id);
    const { enabled } = ruleToggleSchema.parse(await readJsonBody(req));
    return NextResponse.json(await setAlertRuleEnabled(ruleId, enabled));
  } catch (err) {
    return toErrorResponse(err);
  }
}
