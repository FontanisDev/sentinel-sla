// /api/chaos — GET: recent experiments | POST: launch a chaos experiment.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getEngine } from '@/server/engine';
import { toChaosDTO } from '@/server/dto';
import { readJsonBody, toErrorResponse } from '@/server/http';
import { chaosPayloadSchema, clampInt } from '@/server/validation';
import { requireRole, requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireUser(req); // phase-2 authz
    const experiments = await db.chaosExperiment.findMany({
      orderBy: { startedAt: 'desc' },
      take: 20,
      include: { service: true },
    });
    return NextResponse.json({ experiments: experiments.map(toChaosDTO) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    await requireRole(req, 'engineer'); // phase-2 authz
    const parsed = chaosPayloadSchema.parse(await readJsonBody(req));
    const durationSec = clampInt(parsed.durationSec ?? 45, 10, 300); // default 45, clamp 10–300
    const experiment = await getEngine().launchChaos({
      serviceId: parsed.serviceId,
      type: parsed.type,
      durationSec,
    });
    return NextResponse.json({ experiment: toChaosDTO(experiment) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
