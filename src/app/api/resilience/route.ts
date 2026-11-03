// /api/resilience — the self-test schedule, its result ledger and
// the recent chaos experiment history behind the /resilience page.
//
//   GET    (any signed-in user) → schedule + stats + recent runs +
//          recent chaos experiments + live-mode chaos-hook inventory.
//          Nothing secret: hook URLs are echoed presence-only (count only),
//          and hook secrets are never echoed at all.
//   PUT    (admin) { enabled, hour, dayOfWeek } → persist the weekly
//          self-test schedule; audit-logged.
//   POST   (engineer+) → "Run now": starts one self-test through the exact
//          runSelfTest() path the weekly scheduler uses; audit-logged.
//          The measurement takes ~40–60 s (fault window + detection), so the
//          API returns 202 immediately and the result lands in the ledger —
//          the page polls GET while a run is in `running` state. 409 when a
//          run is already in flight.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { toErrorResponse, HttpError } from '@/server/http';
import { requireRole, requireUser } from '@/server/authz';
import { toChaosDTO } from '@/server/dto';
import { getConfig } from '@/server/config';
import {
  hasRunningSelfTest,
  readSelfTestConfig,
  runSelfTest,
  selfTestNextInstant,
  selfTestStats,
  writeSelfTestConfig,
} from '@/server/resilience/selftest';

export const dynamic = 'force-dynamic';

const putSchema = z.object({
  enabled: z.boolean(),
  hour: z.number().int().min(0).max(23),
  dayOfWeek: z.number().int().min(0).max(6),
});

export async function GET(req: Request) {
  try {
    await requireUser(req);
    const cfg = await readSelfTestConfig();
    const [stats, runs, chaos, hookGroups] = await Promise.all([
      selfTestStats(),
      db.selfTestRun.findMany({ orderBy: { startedAt: 'desc' }, take: 20 }),
      db.chaosExperiment.findMany({ orderBy: { startedAt: 'desc' }, take: 20, include: { service: true } }),
      db.service.groupBy({
        by: ['chaosHookUrl'],
        _count: { id: true },
        where: { enabled: true },
      }),
    ]);
    const running = runs.find((r) => r.status === 'running') ?? null;
    const next = cfg.enabled ? selfTestNextInstant(cfg, new Date())?.toISOString() ?? null : null;
    return NextResponse.json({
      mode: getConfig().mode,
      config: cfg,
      nextRunAt: next,
      stats,
      running: running ? { id: running.id, startedAt: running.startedAt.toISOString() } : null,
      runs: runs.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        mode: r.mode,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        mttdSec: r.mttdSec,
        mttrSec: r.mttrSec,
        gateSec: r.gateSec,
        gatePassed: r.gatePassed,
        error: r.error,
      })),
      chaosExperiments: chaos.map(toChaosDTO),
      // live-mode chaos hooks: inventory without values (count only)
      chaosHooks: {
        servicesWithHook: hookGroups.filter((g) => g.chaosHookUrl !== null).reduce((n, g) => n + g._count.id, 0),
        servicesTotal: hookGroups.reduce((n, g) => n + g._count.id, 0),
      },
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
    await writeSelfTestConfig(parsed);
    await db.auditLog.create({
      data: {
        actorType: 'user',
        actorId: user.id,
        actorName: user.email,
        action: 'resilience.selftest.updated',
        detail: `enabled=${parsed.enabled} hour=${parsed.hour} dayOfWeek=${parsed.dayOfWeek}`,
      },
    });
    return NextResponse.json({ ok: true, ...parsed });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireRole(req, 'engineer');
    if (await hasRunningSelfTest()) {
      throw new HttpError(409, 'selftest-already-running: a self-test run is in flight — see /resilience');
    }
    await db.auditLog.create({
      data: {
        actorType: 'user',
        actorId: user.id,
        actorName: user.email,
        action: 'resilience.selftest.run_now',
        detail: 'manual self-test requested',
      },
    });
    // Fire-and-forget: the measurement blocks ~40–60 s; the ledger row is the
    // source of truth and the page polls while status=running.
    void runSelfTest('manual');
    return NextResponse.json({ ok: true, started: true }, { status: 202 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
