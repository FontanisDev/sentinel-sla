// POST /api/auth/setup — first-run wizard: create the owner (only when zero
// users exist). Public (allow-listed) by design:
// anonymous bootstrap; every later call requires authentication.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { audit, requestMeta } from '@/server/authz';
import {
  createSession,
  SESSION_COOKIE,
  sessionCookieOptions,
  userCount,
} from '@/server/auth/session';
import { hashPassword, passwordPolicyError } from '@/server/auth/passwords';
import { toErrorResponse, HttpError } from '@/server/http';
import { enforceRateLimit, RATE_RULES } from '@/server/ratelimit';

export const dynamic = 'force-dynamic';

const setupSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters'),
  email: z.string().trim().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
  locale: z.enum(['en', 'fa']).default('en'),
});

/** GET — the wizard asks "is setup still available?" before rendering. */
export async function GET() {
  return NextResponse.json({ available: (await userCount()) === 0 });
}

export async function POST(req: Request) {
  try {
    // Rate limit: abuse guard on the bootstrap wizard.
    const limited = enforceRateLimit(req, 'auth:setup', RATE_RULES.setup);
    if (limited) return limited;

    if ((await userCount()) > 0) {
      throw new HttpError(403, 'Setup is already complete. Log in instead.');
    }
    const body = setupSchema.safeParse(await req.json().catch(() => null));
    if (!body.success) {
      throw new HttpError(400, body.error.issues[0]?.message ?? 'Invalid payload');
    }
    const policyError = passwordPolicyError(body.data.password);
    if (policyError) throw new HttpError(400, policyError);

    const meta = requestMeta(req);
    const user = await db.user.create({
      data: {
        name: body.data.name,
        email: body.data.email.toLowerCase(),
        passwordHash: await hashPassword(body.data.password),
        role: 'owner',
        locale: body.data.locale,
      },
    });
    const raw = await createSession(user.id, meta);

    await audit({
      actorId: user.id,
      actorName: user.name,
      action: 'user.created',
      detail: `owner account created via first-run setup (${user.email})`,
      ...meta,
    });

    const res = NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        locale: user.locale,
      },
    });
    res.cookies.set(SESSION_COOKIE, raw, sessionCookieOptions());
    return res;
  } catch (err) {
    return toErrorResponse(err);
  }
}
