// PATCH  /api/users/[id] — update an operator account (admin+): role change,
//                          name, locale, password reset, disable/enable.
// DELETE /api/users/[id] — remove an operator account (owner only).
//
// Guardrails:
//   * the LAST enabled owner can never be demoted, disabled or deleted;
//   * an admin cannot touch the owner account;
//   * disabling deletes every live session immediately (logout-everywhere);
//   * every mutation is audit-logged with actor + target.
//
// Account administration.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { toErrorResponse, readJsonBody, HttpError } from '@/server/http';
import { requireRole, audit, requestMeta } from '@/server/authz';
import { hashPassword, passwordPolicyError } from '@/server/auth/passwords';
import { enforceRateLimit, RATE_RULES } from '@/server/ratelimit';

export const dynamic = 'force-dynamic';

const ROLES = ['owner', 'admin', 'engineer', 'executive', 'viewer'] as const;

const patchSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    role: z.enum(ROLES).optional(),
    locale: z.enum(['en', 'fa']).optional(),
    password: z.string().min(1).max(200).optional(),
    disabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Empty update' });

async function enabledOwnerCount(excludeUserId: string): Promise<number> {
  return db.user.count({ where: { role: 'owner', disabled: false, NOT: { id: excludeUserId } } });
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const limited = enforceRateLimit(req, 'users:update', RATE_RULES.mutation);
    if (limited) return limited;

    const admin = await requireRole(req, 'admin');
    const { id } = await context.params;

    const target = await db.user.findUnique({ where: { id } });
    if (!target) throw new HttpError(404, 'User not found.');
    if (target.role === 'owner' && admin.role !== 'owner') {
      throw new HttpError(403, 'Only the owner can modify the owner account.');
    }

    const body = patchSchema.parse(await readJsonBody(req));
    const changes: string[] = [];
    const data: {
      name?: string;
      role?: string;
      locale?: string;
      passwordHash?: string;
      disabled?: boolean;
      failedLogins?: number;
      lockedUntil?: null;
    } = {};

    if (body.name !== undefined && body.name !== target.name) {
      data.name = body.name;
      changes.push('name');
    }
    if (body.locale !== undefined && body.locale !== target.locale) {
      data.locale = body.locale;
      changes.push('locale');
    }
    if (body.password !== undefined) {
      const policyError = passwordPolicyError(body.password);
      if (policyError) throw new HttpError(400, policyError);
      data.passwordHash = await hashPassword(body.password);
      changes.push('password');
    }
    if (body.role !== undefined && body.role !== target.role) {
      if (target.role === 'owner' && (await enabledOwnerCount(target.id)) === 0) {
        throw new HttpError(400, 'Cannot demote the last enabled owner.');
      }
      if (body.role === 'owner' && admin.role !== 'owner') {
        throw new HttpError(403, 'Only the owner can grant the owner role.');
      }
      data.role = body.role;
      changes.push(`role→${body.role}`);
    }
    if (body.disabled !== undefined && body.disabled !== target.disabled) {
      if (body.disabled) {
        if (target.role === 'owner' && (await enabledOwnerCount(target.id)) === 0) {
          throw new HttpError(400, 'Cannot disable the last enabled owner.');
        }
        if (target.id === admin.id) {
          throw new HttpError(400, 'You cannot disable your own account.');
        }
      }
      data.disabled = body.disabled;
      // FailLogin/lock state resets on admin action so a re-enabled account
      // starts clean.
      data.failedLogins = 0;
      data.lockedUntil = null;
      changes.push(body.disabled ? 'disabled' : 'enabled');
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ ok: true, unchanged: true });
    }

    const updated = await db.user.update({
      where: { id: target.id },
      data,
      include: { memberships: { select: { tenantId: true, role: true } } },
    });

    // Password reset or disable → revoke every live session right now.
    if (data.passwordHash || data.disabled === true) {
      await db.session.deleteMany({ where: { userId: target.id } });
    }

    await audit({
      actorId: admin.id,
      actorName: admin.name,
      action: 'user.updated',
      detail: `updated ${target.email} (${changes.join(', ')})`,
      ...requestMeta(req),
    });

    return NextResponse.json({
      ok: true,
      user: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        locale: updated.locale,
        disabled: updated.disabled,
        lastLoginAt: updated.lastLoginAt?.toISOString() ?? null,
        createdAt: updated.createdAt.toISOString(),
        memberships: updated.memberships,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const limited = enforceRateLimit(req, 'users:delete', RATE_RULES.mutation);
    if (limited) return limited;

    const admin = await requireRole(req, 'owner'); // deletion is owner-only
    const { id } = await context.params;

    if (id === admin.id) throw new HttpError(400, 'You cannot delete your own account.');

    const target = await db.user.findUnique({ where: { id } });
    if (!target) throw new HttpError(404, 'User not found.');
    if (target.role === 'owner' && (await enabledOwnerCount(target.id)) === 0) {
      throw new HttpError(400, 'Cannot delete the last enabled owner.');
    }

    await db.user.delete({ where: { id: target.id } }); // sessions/memberships cascade
    await audit({
      actorId: admin.id,
      actorName: admin.name,
      action: 'user.deleted',
      detail: `deleted account ${target.email} (${target.role})`,
      ...requestMeta(req),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
