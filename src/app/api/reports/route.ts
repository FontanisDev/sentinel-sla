// POST /api/reports — generate a report PDF (manual origin; executive floor).
// GET  /api/reports — list generated reports (newest 20).
//
// three templates (executive | statement | incident) × two
// languages (en | fa) from the SAME data snapshot; the SHA-256 printed in
// the title block is stored on the archive row (tamper-evident). The PDF
// pipeline lives in src/server/reportgen.ts + src/server/reports/* and is
// shared with the scheduler so manual + scheduled PDFs come from the exact
// same code path — only the generatedBy origin differs. Every generate and
// download is audit-logged.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { toErrorResponse, readJsonBody, HttpError } from '@/server/http';
import { generateSlaReport } from '@/server/reportgen';
import type { ReportDTO } from '@/lib/types';
import { requireRole, requireUser, resolveTenantScope } from '@/server/authz';
import { resolveTenant } from '@/server/tenants';
import { enforceRateLimit, RATE_RULES } from '@/server/ratelimit';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const generateSchema = z.object({
  kind: z.enum(['executive', 'statement', 'incident']).default('executive'),
  language: z.enum(['en', 'fa']).default('en'),
  /** scope: tenant for statement/executive; omit = fleet-wide executive */
  tenantId: z.string().trim().min(1).max(64).optional(),
  /** the incident to report on (kind=incident only) */
  incidentId: z.string().trim().min(1).max(64).optional(),
});

function toReportDTO(row: {
  id: string; periodStart: Date; periodEnd: Date; generatedAt: Date;
  fileName: string; fileSize: number; generatedBy: string;
  kind: string; language: string; subjectId: string | null; snapshotHash: string;
}): ReportDTO {
  return {
    id: row.id,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    generatedAt: row.generatedAt.toISOString(),
    fileName: row.fileName,
    fileSize: row.fileSize,
    generatedBy: row.generatedBy,
    kind: row.kind,
    language: row.language,
    subjectId: row.subjectId,
    snapshotHash: row.snapshotHash,
  };
}

export async function GET(req: Request) {
  try {
    await requireUser(req); // phase-2 authz
    const rows = await db.slaReport.findMany({
      orderBy: { generatedAt: 'desc' },
      take: 20,
    });
    // Contract (types.ts + openapi.yaml): bare array of ReportDTO.
    return NextResponse.json(rows.map(toReportDTO));
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    // Rate limit: PDF generation spawns the report pipeline — expensive.
    const limited = enforceRateLimit(req, 'reports:generate', RATE_RULES.reportGenerate);
    if (limited) return limited;

    const user = await requireRole(req, 'executive'); // phase-2 authz
    const body = generateSchema.parse(await readJsonBody(req));

    // kind-specific requirements — rejected honestly, before any work.
    if (body.kind === 'statement' && !body.tenantId) {
      throw new HttpError(400, 'kind=statement requires tenantId (a per-client statement)');
    }
    if (body.kind === 'incident' && !body.incidentId) {
      throw new HttpError(400, 'kind=incident requires incidentId');
    }

    // Tenant scope (phase-2): an executive scoped to their clients cannot
    // generate a report for a client they do not belong to.
    let requestedTenantId: string | null = null;
    if (body.tenantId) {
      const tenant = await resolveTenant(body.tenantId);
      if (!tenant) throw new HttpError(404, `Tenant '${body.tenantId}' not found`);
      requestedTenantId = tenant.id;
    }
    const { tenantId } = await resolveTenantScope(user, requestedTenantId);
    const report = await generateSlaReport({
      kind: body.kind,
      language: body.language,
      tenantId,
      incidentId: body.incidentId ?? null,
      generatedBy: 'manual',
      generatedByName: user.name || user.email,
    });
    await db.auditLog.create({
      data: {
        actorType: 'user',
        actorId: user.id,
        actorName: user.name || user.email,
        action: 'report.generate',
        detail: `kind=${report.kind} lang=${report.language} file=${report.fileName} sha256=${report.snapshotHash.slice(0, 12)}`,
      },
    });
    // Contract (types.ts + openapi.yaml): bare ReportDTO on 201 Created.
    return NextResponse.json(report, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
