// POST /api/auth/logout — destroy the current session + audit.

import { NextResponse } from 'next/server';
import { audit, requestMeta, requireUser } from '@/server/authz';
import { destroyCurrentSession, SESSION_COOKIE, sessionCookieOptions } from '@/server/auth/session';
import { toErrorResponse } from '@/server/http';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const meta = requestMeta(req);
    await destroyCurrentSession();
    await audit({
      actorId: user.id,
      actorName: user.name,
      action: 'logout',
      detail: 'session ended',
      ...meta,
    });
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions(), maxAge: 0 });
    return res;
  } catch (err) {
    return toErrorResponse(err);
  }
}
