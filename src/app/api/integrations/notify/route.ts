// /api/integrations/notify — notification transport settings (admin).
//
//   GET  → which notify secrets are SET (booleans only — never the values),
//          the effective transport, and whether SMTP is configured
//   PUT  { telegramBotToken?, baleBotToken?, ackSecret? } (null clears)
//        → upsert IntegrationSetting rows; changes audit-logged
//
// Bot tokens win over env fallbacks (resolveNotifySettings reads settings
// first). ackSecret enables signed /ack links + the Telegram ack button.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { toErrorResponse, HttpError } from '@/server/http';
import { requireRole } from '@/server/authz';
import { getConfig } from '@/server/config';
import { resolveNotifySettings } from '@/server/notify/outbox';

export const dynamic = 'force-dynamic';

const putSchema = z.object({
  telegramBotToken: z.string().trim().min(8).max(200).nullable().optional(),
  baleBotToken: z.string().trim().min(8).max(200).nullable().optional(),
  ackSecret: z.string().trim().min(32).max(200).nullable().optional(),
});

const SECRET_KEYS = ['telegramBotToken', 'baleBotToken', 'ackSecret'] as const;
type SecretKey = (typeof SECRET_KEYS)[number];

async function upsertSecret(key: SecretKey, value: string | null): Promise<void> {
  if (value === null) {
    await db.integrationSetting.deleteMany({ where: { key } });
    return;
  }
  await db.integrationSetting.upsert({
    where: { key },
    update: { value, updatedAt: new Date(), updatedBy: 'admin' },
    create: { key, value, updatedBy: 'admin' },
  });
}

export async function GET(req: Request) {
  try {
    await requireRole(req, 'admin');
    await getConfig(); // validate env early
    const settings = await resolveNotifySettings();
    const rows = await db.integrationSetting.findMany({ where: { key: { in: [...SECRET_KEYS] } } });
    const set = new Set(rows.map((r) => r.key));
    return NextResponse.json({
      transport: settings.transport,
      mode: getConfig().mode,
      telegramBotTokenSet: set.has('telegramBotToken') || settings.config.telegramToken !== null,
      baleBotTokenSet: set.has('baleBotToken') || settings.config.baleToken !== null,
      ackSecretSet: set.has('ackSecret') || settings.ackSecret !== null,
      smtpConfigured: settings.config.smtp !== null,
      smtpHost: settings.config.smtp?.host ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(req: Request) {
  try {
    const user = await requireRole(req, 'admin');
    let parsed: z.infer<typeof putSchema>;
    try {
      parsed = putSchema.parse(await req.json());
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new HttpError(400, `Invalid payload: ${err.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      }
      throw err;
    }
    const changed: string[] = [];
    for (const key of SECRET_KEYS) {
      const value = parsed[key];
      if (value === undefined) continue;
      await upsertSecret(key, value);
      changed.push(key);
    }
    if (changed.length > 0) {
      await db.auditLog.create({
        data: {
          actorType: 'user',
          actorId: user.id,
          actorName: user.email,
          action: 'integration.notify.updated',
          detail: `keys=${changed.join(',')} (values not logged)`,
        },
      });
    }
    const settings = await resolveNotifySettings();
    return NextResponse.json({
      ok: true,
      transport: settings.transport,
      telegramBotTokenSet: settings.config.telegramToken !== null,
      baleBotTokenSet: settings.config.baleToken !== null,
      ackSecretSet: settings.ackSecret !== null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
