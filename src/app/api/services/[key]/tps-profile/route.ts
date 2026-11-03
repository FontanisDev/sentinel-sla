// POST /api/services/[key]/tps-profile — Shaparak/PSP transaction-count CSV
// → the service's hour-of-week tps profile ("Shaparak/PSP-style
// transaction-count sources").
//
// Journey: the operator pastes or uploads a PSP/Shaparak hourly report on
// the service page, runs it as a dry-run (default — parses, aggregates,
// previews the 168 buckets, writes nothing), then commits. Commit is
// all-or-nothing: any rejected row aborts (money inputs are never silently
// partial — the dry-run lists every rejection with its physical CSV line).
// DELETE reverts the service to its flat `tps` column. Both writes are
// audit-logged.
//
// Authz mirrors GET/POST /api/services/[key]: engineer+ may import; a
// tenant-scoped (non-admin) user only for services of their own clients —
// foreign keys 404 so their existence is not even confirmable.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { HttpError, readJsonBody, toErrorResponse } from '@/server/http';
import { requireRole, resolveTenantScope } from '@/server/authz';
import {
  SHAPARAK_MAX_BYTES,
  parseShaparakSheet,
  summarizeProfile,
} from '@/server/shaparak-import';
import { TEHRAN_TZ_OFFSET_MINUTES } from '@/domain/tps-profile';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, context: { params: Promise<{ key: string }> }) {
  try {
    const user = await requireRole(req, 'engineer');
    const { key } = await context.params;
    const service = await db.service.findUnique({ where: { key }, select: { id: true, key: true, name: true, tenantId: true } });
    if (!service) {
      return NextResponse.json({ error: 'Service not found' }, { status: 404 });
    }
    if (service.tenantId) {
      await resolveTenantScope(user, service.tenantId);
    }

    const body = (await readJsonBody(req)) as { csv?: unknown; mode?: unknown };
    if (typeof body.csv !== 'string' || body.csv.trim() === '') {
      throw new HttpError(400, "Body must be JSON with a non-empty 'csv' string");
    }
    if (body.csv.length > SHAPARAK_MAX_BYTES) {
      throw new HttpError(413, `CSV exceeds ${SHAPARAK_MAX_BYTES} bytes`);
    }
    const mode = body.mode === 'commit' ? 'commit' : 'dryRun';

    const parsed = parseShaparakSheet(body.csv);
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    const summary = summarizeProfile(parsed);

    const report = {
      mode,
      committed: false,
      service: { key: service.key, name: service.name },
      shape: parsed.shape,
      rowsUsed: summary.rowsUsed,
      rowsRejected: summary.rowsRejected,
      rejected: parsed.rejected,
      window: parsed.window,
      coverage: {
        coveredBuckets: summary.coveredBuckets,
        of: 168,
        percent: Math.round((summary.coveredBuckets / 168) * 1000) / 10,
      },
      meanTps: summary.meanTps,
      peak: summary.peak,
      trough: summary.trough,
      tzOffsetMinutes: TEHRAN_TZ_OFFSET_MINUTES,
      buckets: summary.buckets,
    };

    if (mode !== 'commit') {
      return NextResponse.json(report);
    }

    // All-or-nothing commit: rejected rows abort (money inputs are never
    // silently partial). The dry-run already listed every rejection.
    if (parsed.rejected.length > 0) {
      return NextResponse.json(
        {
          ...report,
          error: `Import aborted: ${parsed.rejected.length} of ${parsed.rows.length + parsed.rejected.length} rows were rejected. Fix the sheet and re-run (the dry-run lists every failing line).`,
        },
        { status: 422 },
      );
    }

    const stored = JSON.stringify({
      buckets: summary.buckets,
      tzOffsetMinutes: TEHRAN_TZ_OFFSET_MINUTES,
      meta: {
        source: 'shaparak-csv',
        shape: parsed.shape,
        rowsUsed: summary.rowsUsed,
        window: parsed.window,
        meanTps: summary.meanTps,
        importedAt: new Date().toISOString(),
        importedBy: user.email,
      },
    });

    await db.service.update({ where: { id: service.id }, data: { tpsProfile: stored } });
    await db.auditLog.create({
      data: {
        actorType: 'user',
        actorId: user.id,
        actorName: user.email,
        action: 'service.tps-profile.imported',
        detail: `service=${service.key} rows=${summary.rowsUsed} coverage=${report.coverage.percent}% meanTps=${summary.meanTps?.toFixed(4) ?? 'n/a'}`,
      },
    });

    return NextResponse.json({ ...report, committed: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ key: string }> }) {
  try {
    const user = await requireRole(req, 'engineer');
    const { key } = await context.params;
    const service = await db.service.findUnique({ where: { key }, select: { id: true, key: true, name: true, tenantId: true, tpsProfile: true } });
    if (!service) {
      return NextResponse.json({ error: 'Service not found' }, { status: 404 });
    }
    if (service.tenantId) {
      await resolveTenantScope(user, service.tenantId);
    }
    if (!service.tpsProfile) {
      return NextResponse.json({ ok: true, removed: false, message: 'No transaction profile stored — the flat tps rate already drives money.' });
    }
    await db.service.update({ where: { id: service.id }, data: { tpsProfile: null } });
    await db.auditLog.create({
      data: {
        actorType: 'user',
        actorId: user.id,
        actorName: user.email,
        action: 'service.tps-profile.removed',
        detail: `service=${service.key} money falls back to the flat tps column`,
      },
    });
    return NextResponse.json({ ok: true, removed: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
