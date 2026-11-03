// DELETE /api/rules/[id] — remove a policy rule.
//
//   200 → { ok: true }, 404 unknown rule, 400 invalid id

import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/server/http';
import { deleteAlertRule } from '@/server/alertgovernance';
import { governanceIdSchema } from '@/server/validation';
import { requireRole, requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireRole(req, 'engineer'); // phase-2 authz: ops mutation
    const { id } = await context.params;
    const ruleId = governanceIdSchema.parse(id);
    await deleteAlertRule(ruleId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
