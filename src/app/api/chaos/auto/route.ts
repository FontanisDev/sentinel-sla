// POST /api/chaos/auto — toggle the automatic chaos self-test scheduler.

import { NextResponse } from 'next/server';
import { getEngine } from '@/server/engine';
import { readJsonBody, toErrorResponse } from '@/server/http';
import { autoChaosSchema, clampInt } from '@/server/validation';
import { requireRole, requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    await requireRole(req, 'engineer'); // phase-2 authz
    const parsed = autoChaosSchema.parse(await readJsonBody(req));
    const intervalMin = clampInt(parsed.intervalMin ?? 3, 1, 30); // default 3, clamp 1–30
    const engine = getEngine();
    engine.setAutoChaos(parsed.enabled, intervalMin);
    const state = engine.getEngineState();
    return NextResponse.json({
      ok: true,
      autoChaos: state.autoChaos,
      autoChaosIntervalMin: state.autoChaosIntervalMin,
      nextAutoChaosAt: state.nextAutoChaosAt,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
