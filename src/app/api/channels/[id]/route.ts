// /api/channels/[id] — notification channel lifecycle.
//
//   PATCH  → edit name/target/audience/enabled/secret (PATCH semantics:
//            undefined = keep, secret null = clear) → NotificationChannelDTO
//   DELETE → remove the channel → { ok: true }
//
// Both mutations are engineer-floor (ops); 404 unknown, 400 validation
// (per-kind target format re-checked on every target change).

import { NextResponse } from 'next/server';
import { toErrorResponse, readJsonBody } from '@/server/http';
import { deleteChannel, updateChannel } from '@/server/alertgovernance';
import { governanceIdSchema, updateChannelSchema } from '@/server/validation';
import { requireRole } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireRole(req, 'engineer'); // phase-2 authz: ops mutation
    const { id } = await context.params;
    const channelId = governanceIdSchema.parse(id);
    const parsed = updateChannelSchema.parse(await readJsonBody(req));
    const channel = await updateChannel(channelId, parsed);
    return NextResponse.json(channel);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireRole(req, 'engineer'); // phase-2 authz: ops mutation
    const { id } = await context.params;
    const channelId = governanceIdSchema.parse(id);
    await deleteChannel(channelId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
