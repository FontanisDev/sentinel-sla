// GET /api/auth/session — who am I? (UI bootstraps role/locale from here.)
// Public (allow-listed): returns { authenticated: false } instead of 401 so
// the client router can decide between /login and the app without error noise.

import { NextResponse } from 'next/server';
import { resolveSessionUser } from '@/server/auth/session';
import { toErrorResponse } from '@/server/http';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const user = await resolveSessionUser(req);
    if (!user) return NextResponse.json({ authenticated: false });
    return NextResponse.json({
      authenticated: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        locale: user.locale,
        via: user.via,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
