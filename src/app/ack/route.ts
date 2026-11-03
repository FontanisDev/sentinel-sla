// GET /ack — signed acknowledgement link ("acknowledge … via a
// signed link in the message").
//
// Public page: the HMAC token in the query string IS the authentication —
// no session required (the on-call engineer may click from their phone's
// Telegram app where no Sentinel session exists). The token is verified with
// timing-safe comparison; expired/invalid tokens render an honest error in
// both languages. A successful acknowledgement is idempotent-friendly: the
// engine's 409 "already acknowledged" is rendered as a friendly already-done
// state rather than an error.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getEngine } from '@/server/engine';
import { verifyAckToken } from '@/server/notify/policy';

export const dynamic = "force-dynamic";

export const runtime = "nodejs";

async function resolveAckSecret(): Promise<string | null> {
  try {
    const row = await db.integrationSetting.findUnique({ where: { key: 'ackSecret' } });
    if (row?.value && row.value.trim().length > 0) return row.value.trim();
  } catch {
    /* env is the fallback */
  }
  const env = process.env.SENTINEL_ACK_SECRET;
  return env && env.trim().length > 0 ? env.trim() : null;
}

function html(title: string, bodyFa: string, bodyEn: string, tone: 'ok' | 'err'): NextResponse {
  const bg = tone === 'ok' ? '#0d3320' : '#33130d';
  const fg = tone === 'ok' ? '#7ce2a7' : '#f2a08c';
  const page = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${title}</title>
<style>
  body { font-family: system-ui, -apple-system, 'Segoe UI', Tahoma, sans-serif;
         background: ${bg}; color: ${fg}; min-height: 100vh; display: flex;
         align-items: center; justify-content: center; margin: 0; }
  .card { text-align: center; padding: 2.5rem 3rem; border-radius: 16px;
          background: rgba(0,0,0,.25); max-width: 34rem; }
  .fa { font-size: 1.15rem; margin: 0 0 1rem; line-height: 1.9; }
  .en { font-size: .95rem; margin: 0; direction: ltr; opacity: .85; }
</style>
</head>
<body><div class="card">
  <p class="fa">${bodyFa}</p>
  <p class="en">${bodyEn}</p>
</div></body></html>`;
  return new NextResponse(page, {
    status: tone === 'ok' ? 200 : 400,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const token = url.searchParams.get('token') ?? '';

  const secret = await resolveAckSecret();
  if (!secret) {
    return html(
      'تأیید حادثه',
      'لینک‌های تأیید روی این نصب فعال نیستند. از داشبورد سنتیل استفاده کنید.',
      'Ack links are not enabled on this instance. Use the Sentinel dashboard instead.',
      'err',
    );
  }

  const verdict = verifyAckToken(token, secret, Date.now());
  if (!verdict.ok) {
    const reasonFa =
      verdict.reason === 'expired'
        ? 'اعتبار این لینک تأیید به پایان رسیده است.'
        : 'لینک تأیید معتبر نیست.';
    const reasonEn =
      verdict.reason === 'expired' ? 'This acknowledgement link has expired.' : 'This acknowledgement link is invalid.';
    return html('تأیید حادثه', reasonFa, reasonEn, 'err');
  }

  try {
    const engine = getEngine();
    await engine.ensureInit();
    const incident = await engine.acknowledgeIncident(verdict.incidentId, 'signed-link');
    return html(
      'تأیید حادثه',
      `حادثه «${incident.service.name}» تأیید شد. تیم فنی در جریان است.`,
      `Incident on "${incident.service.name}" acknowledged. The on-call has been marked.`,
      'ok',
    );
  } catch (err) {
    const status = err instanceof Error && 'status' in err ? Number((err as { status: number }).status) : 500;
    if (status === 409) {
      return html(
        'تأیید حادثه',
        'این حادثه قبلاً تأیید شده است.',
        'This incident was already acknowledged.',
        'ok',
      );
    }
    if (status === 404) {
      return html(
        'تأیید حادثه',
        'حادثه مورد نظر یافت نشد (احتمالاً بسته شده است).',
        'The incident was not found (it may already be closed).',
        'err',
      );
    }
    return html(
      'تأیید حادثه',
      'خطای غیرمنتظره در تأیید حادثه. دوباره تلاش کنید.',
      'Unexpected error while acknowledging. Please retry.',
      'err',
    );
  }
}
