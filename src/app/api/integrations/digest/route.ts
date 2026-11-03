// /api/integrations/digest — executive digest schedule (admin).
//
//   GET   → current schedule (frequency/hour/dayOfWeek), last-run info and
//           the NEXT due instant (null when off) — everything the settings
//           card renders, nothing secret.
//   PUT   { frequency: 'off'|'daily'|'weekly', hour: 0-23, dayOfWeek?: 0-6 }
//         → validates and persists to IntegrationSetting; audit-logged.
//   POST  → "Run now": emits one digest immediately through the exact same
//           runDigestNow() path the scheduler uses (no separate manual code
//           path to drift); audit-logged. Honest result: enqueued count and
//           the error string when digest-disabled or the fan-out failed.
//
// Executive digests page executives — configure/admin floor by design.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { toErrorResponse, HttpError } from '@/server/http';
import { requireRole } from '@/server/authz';
import {
  readDigestConfig,
  writeDigestConfig,
  readDigestRunInfo,
  runDigestNow,
  digestNextInstant,
} from '@/server/notify/digest';

export const dynamic = 'force-dynamic';

const putSchema = z.object({
  frequency: z.enum(['off', 'daily', 'weekly']),
  hour: z.number().int().min(0).max(23),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
});

export async function GET(req: Request) {
  try {
    await requireRole(req, 'admin');
    const [cfg, run] = await Promise.all([readDigestConfig(), readDigestRunInfo()]);
    const next =
      cfg.frequency === 'off' ? null : digestNextInstant(cfg, new Date())?.toISOString() ?? null;
    return NextResponse.json({
      frequency: cfg.frequency,
      hour: cfg.hour,
      dayOfWeek: cfg.dayOfWeek,
      nextRunAt: next,
      lastRunAt: run.lastRunAt,
      lastRunOk: run.lastRunOk,
      lastError: run.lastError,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(req: Request) {
  try {
    const user = await requireRole(req, 'admin');
    let parsed: z.infer<typeof putSchema>;
    try {
      parsed = putSchema.parse(await req.json());
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new HttpError(400, `Invalid payload: ${err.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      }
      throw err;
    }
    if (parsed.frequency === 'weekly' && parsed.dayOfWeek === undefined) {
      throw new HttpError(400, 'dayOfWeek (0-6) is required for weekly digests');
    }
    const next = {
      frequency: parsed.frequency,
      hour: parsed.hour,
      dayOfWeek: parsed.dayOfWeek ?? 6,
    };
    await writeDigestConfig(next);
    await db.auditLog.create({
      data: {
        actorType: 'user',
        actorId: user.id,
        actorName: user.email,
        action: 'integration.digest.updated',
        detail: `frequency=${next.frequency} hour=${next.hour} dayOfWeek=${next.dayOfWeek}`,
      },
    });
    return NextResponse.json({ ok: true, ...next });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireRole(req, 'admin');
    const result = await runDigestNow();
    await db.auditLog.create({
      data: {
        actorType: 'user',
        actorId: user.id,
        actorName: user.email,
        action: 'integration.digest.run_now',
        detail: result.ok ? `enqueued=${result.enqueued}` : `error=${result.error ?? 'unknown'}`,
      },
    });
    if (!result.ok) {
      // honest: 'digest-disabled' is a 409 (config conflict), everything else 500
      if (result.error === 'digest-disabled') {
        throw new HttpError(409, 'Digest is disabled — choose a daily or weekly schedule first');
      }
      throw new HttpError(500, result.error ?? 'digest run failed');
    }
    return NextResponse.json({ ok: true, enqueued: result.enqueued });
  } catch (err) {
    return toErrorResponse(err);
  }
}
