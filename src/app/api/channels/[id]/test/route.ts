// POST /api/channels/[id]/test — real test delivery for ONE channel (
// item 4: "Channel page: add, edit, test-send"). Enqueues a test message that
// only this channel receives; the outbox dispatcher carries it (simulate
// transport → instant bookkeeping, real transport → the configured adapter).
// Outcome lands in the delivery log + channel counters like any other message.
//
// Engineer floor (ops mutation).

import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/server/http';
import { requireRole } from '@/server/authz';
import { testChannelDelivery } from '@/server/alertgovernance';
import { governanceIdSchema } from '@/server/validation';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireRole(req, 'engineer');
    const { id } = await context.params;
    const channelId = governanceIdSchema.parse(id);
    const channel = await testChannelDelivery(channelId);
    return NextResponse.json(channel);
  } catch (err) {
    return toErrorResponse(err);
  }
}
