// GET/PUT /api/integrations/prometheus — Settings → Integrations.
//
// GET (admin+): returns the stored Prometheus connection (baseUrl + auth
// kind). Secrets are never echoed — only their kind and a masked preview.
// PUT (admin+): validates and stores the connection; every change is
// audit-logged. The ingestion worker reads these settings per tick.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { toErrorResponse, HttpError } from '@/server/http';
import { requireRole } from '@/server/authz';
import { readPrometheusSettings, writePrometheusSettings } from '@/server/ingestion';

export const dynamic = 'force-dynamic';

const authSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('basic'), username: z.string().min(1).max(120), password: z.string().min(1).max(240) }),
  z.object({ kind: z.literal('bearer'), token: z.string().min(1).max(240) }),
]);

const putSchema = z.object({
  baseUrl: z.string().trim().url().max(300),
  auth: authSchema.default({ kind: 'none' }),
});

function maskAuth(auth: { kind: string } & Record<string, unknown>): Record<string, unknown> {
  if (auth.kind === 'basic') {
    return { kind: 'basic', username: auth.username, passwordSet: true };
  }
  if (auth.kind === 'bearer') {
    return { kind: 'bearer', tokenPreview: `${String(auth.token).slice(0, 3)}…` };
  }
  return { kind: 'none' };
}

export async function GET(req: Request) {
  try {
    await requireRole(req, 'admin');
    const settings = await readPrometheusSettings();
    if (!settings) {
      return NextResponse.json({ configured: false, baseUrl: null, auth: { kind: 'none' } });
    }
    return NextResponse.json({
      configured: true,
      baseUrl: settings.baseUrl,
      auth: maskAuth(settings.auth as { kind: string } & Record<string, unknown>),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(req: Request) {
  try {
    const user = await requireRole(req, 'admin');
    const body = putSchema.parse(await req.json());
    // normalise trailing slashes off the base URL
    const baseUrl = body.baseUrl.replace(/\/+$/, '');
    await writePrometheusSettings({ baseUrl, auth: body.auth }, user.id);
    await db.auditLog.create({
      data: {
        actorType: 'user',
        actorId: user.id,
        actorName: user.email,
        action: 'integration.prometheus.updated',
        detail: `baseUrl=${baseUrl} auth=${body.auth.kind}`,
      },
    });
    return NextResponse.json({ ok: true, baseUrl, auth: maskAuth(body.auth as { kind: string } & Record<string, unknown>) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return toErrorResponse(new HttpError(400, `Invalid payload: ${err.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`));
    }
    return toErrorResponse(err);
  }
}
