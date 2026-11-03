// POST /api/channels/[id]/toggle — enable or disable a notification channel.
//
//   body { enabled: boolean } → 200 + NotificationChannelDTO, 404, 400

import { NextResponse } from 'next/server';
import { readJsonBody, toErrorResponse } from '@/server/http';
import { setChannelEnabled } from '@/server/alertgovernance';
import { channelToggleSchema, governanceIdSchema } from '@/server/validation';
import { requireRole, requireUser } from '@/server/authz';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireRole(req, 'engineer'); // phase-2 authz: ops mutation
    const { id } = await context.params;
    const channelId = governanceIdSchema.parse(id);
    const { enabled } = channelToggleSchema.parse(await readJsonBody(req));
    return NextResponse.json(await setChannelEnabled(channelId, enabled));
  } catch (err) {
    return toErrorResponse(err);
  }
}
