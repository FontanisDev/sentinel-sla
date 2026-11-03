// /api/channels — GET: list notification channels | POST: create one.
//
//   GET  → NotificationChannelDTO[] (enabled first)
//   POST → 201 + NotificationChannelDTO, 400 validation (incl. per-kind target)

import { NextResponse } from 'next/server';
import { getEngine } from '@/server/engine';
import { HttpError, readJsonBody, toErrorResponse } from '@/server/http';
import { createChannel, listChannels, validateChannelTarget } from '@/server/alertgovernance';
import { createChannelSchema } from '@/server/validation';
import { requireRole, requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireUser(req); // phase-2 authz
    await getEngine().ensureInit();
    return NextResponse.json(await listChannels());
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    await requireRole(req, 'engineer'); // phase-2 authz
    const parsed = createChannelSchema.parse(await readJsonBody(req));
    await getEngine().ensureInit();
    const targetError = validateChannelTarget(parsed.kind, parsed.target);
    if (targetError) throw new HttpError(400, targetError);
    const channel = await createChannel(parsed);
    return NextResponse.json(channel, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
