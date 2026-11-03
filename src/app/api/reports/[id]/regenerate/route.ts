// POST /api/reports/[id]/regenerate — rebuild a report from its stored
// parameters. Creates a NEW archive row with a fresh SHA-256
// over the CURRENT data snapshot — history is never overwritten. Audit-
// logged; executive floor like generation; rate-limited like generation.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { toErrorResponse } from '@/server/http';
import { regenerateReport } from '@/server/reportgen';
import { requireRole } from '@/server/authz';
import { enforceRateLimit, RATE_RULES } from '@/server/ratelimit';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const limited = enforceRateLimit(req, 'reports:generate', RATE_RULES.reportGenerate);
    if (limited) return limited;

    const user = await requireRole(req, 'executive');
    const { id } = await context.params;
    const report = await regenerateReport(id, user.name || user.email);
    await db.auditLog.create({
      data: {
        actorType: 'user',
        actorId: user.id,
        actorName: user.name || user.email,
        action: 'report.regenerate',
        detail: `source=${id} kind=${report.kind} lang=${report.language} file=${report.fileName} sha256=${report.snapshotHash.slice(0, 12)}`,
      },
    });
    return NextResponse.json(report, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
