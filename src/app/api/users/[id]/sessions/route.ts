// DELETE /api/users/[id]/sessions — "log out everywhere" for one account
// (admin+). logout everywhere. Audit-logged.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { toErrorResponse, HttpError } from '@/server/http';
import { requireRole, audit, requestMeta } from '@/server/authz';
import { enforceRateLimit, RATE_RULES } from '@/server/ratelimit';

export const dynamic = 'force-dynamic';

const idSchema = z.string().min(1).max(64);

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const limited = enforceRateLimit(req, 'users:sessions', RATE_RULES.mutation);
    if (limited) return limited;

    const admin = await requireRole(req, 'admin');
    const { id } = await context.params;
    const userId = idSchema.parse(id);

    const target = await db.user.findUnique({ where: { id: userId } });
    if (!target) throw new HttpError(404, 'User not found.');
    if (target.role === 'owner' && admin.role !== 'owner') {
      throw new HttpError(403, 'Only the owner can end the owner sessions.');
    }

    const removed = await db.session.deleteMany({ where: { userId } });

    await audit({
      actorId: admin.id,
      actorName: admin.name,
      action: 'user.sessions_revoked',
      detail: `revoked ${removed.count} session(s) for ${target.email}`,
      ...requestMeta(req),
    });

    return NextResponse.json({ ok: true, revoked: removed.count });
  } catch (err) {
    return toErrorResponse(err);
  }
}
