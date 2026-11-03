// GET  /api/users — list operator accounts (admin+).
// POST /api/users — create an operator account (admin+; owner row itself is
//                   created only by /setup).
//
// Account administration.: every mutation here is audit-logged
// (user.created). Password policy and argon2id hashing are shared with the
// login/setup pipeline — there is exactly one password implementation.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { toErrorResponse, readJsonBody, HttpError } from '@/server/http';
import { requireRole, audit, requestMeta } from '@/server/authz';
import { hashPassword, passwordPolicyError } from '@/server/auth/passwords';
import { enforceRateLimit, RATE_RULES } from '@/server/ratelimit';

export const dynamic = 'force-dynamic';

const ROLES = ['owner', 'admin', 'engineer', 'executive', 'viewer'] as const;

const createUserSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(120),
  password: z.string().min(1).max(200),
  role: z.enum(ROLES).default('viewer'),
  locale: z.enum(['en', 'fa']).default('en'),
  memberships: z
    .array(
      z.object({
        tenantId: z.string().trim().min(1).max(64),
        role: z.enum(['tenant-admin', 'engineer', 'executive', 'viewer']).default('viewer'),
      }),
    )
    .max(50)
    .default([]),
});

function toUserDTO(u: {
  id: string;
  name: string;
  email: string;
  role: string;
  locale: string;
  disabled: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  memberships: { tenantId: string; role: string }[];
}) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    locale: u.locale,
    disabled: u.disabled,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    memberships: u.memberships,
  };
}

export async function GET(req: Request) {
  try {
    await requireRole(req, 'admin'); // account administration is admin+ only
    const users = await db.user.findMany({
      orderBy: { createdAt: 'asc' },
      include: { memberships: { select: { tenantId: true, role: true } } },
    });
    return NextResponse.json(users.map(toUserDTO));
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const limited = enforceRateLimit(req, 'users:create', RATE_RULES.mutation);
    if (limited) return limited;

    const admin = await requireRole(req, 'admin');
    const body = createUserSchema.parse(await readJsonBody(req));

    const policyError = passwordPolicyError(body.password);
    if (policyError) throw new HttpError(400, policyError);

    // Only an owner may mint another owner (admins stop at admin).
    if (body.role === 'owner' && admin.role !== 'owner') {
      throw new HttpError(403, 'Only the owner can create another owner account.');
    }

    const email = body.email.toLowerCase();
    const dupe = await db.user.findUnique({ where: { email } });
    if (dupe) throw new HttpError(409, 'A user with this email already exists.');

    // Memberships must reference real tenants — validate up front.
    if (body.memberships.length > 0) {
      const ids = body.memberships.map((m) => m.tenantId);
      const found = await db.tenant.findMany({ where: { id: { in: ids } }, select: { id: true } });
      if (found.length !== new Set(ids).size) {
        throw new HttpError(400, 'One or more tenants do not exist.');
      }
    }

    const user = await db.user.create({
      data: {
        name: body.name,
        email,
        passwordHash: await hashPassword(body.password),
        role: body.role,
        locale: body.locale,
        memberships: {
          create: body.memberships.map((m) => ({ tenantId: m.tenantId, role: m.role })),
        },
      },
      include: { memberships: { select: { tenantId: true, role: true } } },
    });

    await audit({
      actorId: admin.id,
      actorName: admin.name,
      action: 'user.created',
      detail: `created ${body.role} account ${user.email}`,
      ...requestMeta(req),
    });

    return NextResponse.json(toUserDTO(user), { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
