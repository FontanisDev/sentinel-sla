// GET /api/reports/[id]/download — stream a generated report PDF.
// downloads are audit-logged (who pulled which statement).

import { promises as fs } from 'fs';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { resolveReportFile } from '@/server/reportarchive';
import { toErrorResponse, HttpError } from '@/server/http';
import { requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(req); // phase-2 authz
    const { id } = await context.params;
    const row = await db.slaReport.findUnique({ where: { id } });
    if (!row) throw new HttpError(404, 'Report not found');

    // resolveReportFile basename-guards every candidate (traversal-safe).
    const target = await resolveReportFile(row.filePath, row.fileName);
    if (!target) throw new HttpError(404, 'Report file is no longer available');

    const data = await fs.readFile(target);

    await db.auditLog.create({
      data: {
        actorType: 'user',
        actorId: user.id,
        actorName: user.name || user.email,
        action: 'report.download',
        detail: `kind=${row.kind} lang=${row.language} file=${row.fileName}`,
      },
    });

    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(data.length),
        'Content-Disposition': `attachment; filename="${row.fileName}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
