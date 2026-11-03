// POST /api/auth/login — credential login with lockout + audit.
// GET /api/auth/login is not exposed (login is POST-only).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { audit, requestMeta } from '@/server/authz';
import {
  checkLogin,
  createSession,
  SESSION_COOKIE,
  sessionCookieOptions,
} from '@/server/auth/session';
import { toErrorResponse, HttpError } from '@/server/http';
import { enforceRateLimit, RATE_RULES } from '@/server/ratelimit';

export const dynamic = 'force-dynamic';

const loginSchema = z.object({
  email: z.string().trim().min(3, 'Enter your email address'),
  password: z.string().min(1, 'Enter your password'),
});

export async function POST(req: Request) {
  try {
    // Rate limit: brute-force throttle beside the DB account lockout.
    const limited = enforceRateLimit(req, 'auth:login', RATE_RULES.login);
    if (limited) return limited;

    const body = loginSchema.safeParse(await req.json().catch(() => null));
    if (!body.success) {
      throw new HttpError(400, body.error.issues[0]?.message ?? 'Invalid payload');
    }
    const meta = requestMeta(req);
    const outcome = await checkLogin(body.data.email, body.data.password);

    if (!outcome.ok) {
      if (outcome.reason === 'locked') {
        await audit({
          action: 'login.locked',
          detail: `locked account attempted login (${body.data.email})`,
          ...meta,
        });
        throw new HttpError(
          429,
          `Account temporarily locked after repeated failures. Try again in ${Math.ceil(
            (outcome.retryAfterSec ?? 900) / 60,
          )} minute(s).`,
        );
      }
      await audit({
        action: 'login.failed',
        detail: `failed login for ${body.data.email}${outcome.reason === 'disabled' ? ' (account disabled)' : ''}`,
        ...meta,
      });
      // Generic message for invalid credentials; the disabled notice is safe
      // (it only reaches someone holding correct credentials).
      throw new HttpError(
        outcome.reason === 'disabled' ? 403 : 401,
        outcome.reason === 'disabled'
          ? 'This account has been disabled. Contact an administrator.'
          : 'Invalid email or password.',
      );
    }

    const user = await dbGuard(outcome.userId);
    const raw = await createSession(user.id, meta);
    await audit({
      actorId: user.id,
      actorName: user.name,
      action: 'login',
      detail: `login via password (${user.email})`,
      ...meta,
    });

    const res = NextResponse.json({
      ok: true,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, locale: user.locale },
    });
    res.cookies.set(SESSION_COOKIE, raw, sessionCookieOptions());
    return res;
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Load the just-authenticated user (exists by construction; guard anyway). */
async function dbGuard(userId: string) {
  const { db } = await import('@/lib/db');
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new HttpError(500, 'Authenticated user vanished — please retry.');
  return user;
}
