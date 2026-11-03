// POST /api/integrations/telegram/callback — Telegram/Bale bot update receiver
//.
//
// Auth: the `X-Telegram-Bot-Api-Secret-Token` header must match the configured
// secret (IntegrationSetting key `telegramWebhookSecret`, env fallback
// SENTINEL_TELEGRAM_WEBHOOK_SECRET). 503 when unset, 401 on mismatch — same
// deliberate out-of-session model as the Alertmanager webhook (bots cannot
// hold sessions; the shared secret IS the authentication).
//
// Semantics: handles `callback_query` updates whose data is `ack:<token>`
// (the inline button attached to detection/escalation pages). The token is the
// signed ack token (policy.signAckToken) — verified, then the incident is
// acknowledged as `bot:<from>`. Expired/invalid tokens answer with an alert
// popup instead of acknowledging. Non-callback updates are accepted and
// ignored (bots receive every message; only button presses matter here).

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { toErrorResponse, HttpError } from '@/server/http';
import { getEngine } from '@/server/engine';
import { parseAckCallbackData, verifyAckToken } from '@/server/notify/policy';

export const dynamic = 'force-dynamic';

interface TgUser {
  username?: string;
  first_name?: string;
  id?: number;
}
interface TgCallbackQuery {
  data?: string;
  from?: TgUser;
  id?: string | number;
}
interface TgUpdate {
  callback_query?: TgCallbackQuery;
  message?: { text?: string };
}

async function resolveCallbackSecret(): Promise<string | null> {
  try {
    const row = await db.integrationSetting.findUnique({ where: { key: 'telegramWebhookSecret' } });
    if (row?.value && row.value.trim().length >= 16) return row.value.trim();
  } catch {
    /* settings table unavailable — env is the fallback */
  }
  const env = process.env.SENTINEL_TELEGRAM_WEBHOOK_SECRET;
  return env && env.trim().length >= 16 ? env.trim() : null;
}

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

function botBase(): string {
  return process.env.SENTINEL_TELEGRAM_API_BASE ?? 'https://api.telegram.org';
}

function botToken(): string {
  return process.env.SENTINEL_TELEGRAM_BOT_TOKEN ?? '';
}

/** Best-effort answerCallbackQuery so the user sees a toast in the bot. */
async function answerCallback(callbackId: string, text: string, showAlert: boolean): Promise<void> {
  const token = botToken();
  if (!token || !callbackId) return;
  try {
    await fetch(`${botBase().replace(/\/$/, '')}/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackId, text, show_alert: showAlert }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* cosmetic — the ack state is already decided */
  }
}

export async function POST(req: Request) {
  let callbackId = '';
  try {
    const secret = await resolveCallbackSecret();
    if (!secret) {
      throw new HttpError(503, 'Telegram callback is not configured (set telegramWebhookSecret).');
    }
    const provided = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
    if (provided !== secret) {
      throw new HttpError(401, 'Invalid callback secret token.');
    }

    const update = (await req.json().catch(() => null)) as TgUpdate | null;
    const cq = update?.callback_query;
    if (!cq || typeof cq.data !== 'string') {
      return NextResponse.json({ ok: true, ignored: true });
    }
    callbackId = String(cq.id ?? '');

    const token = parseAckCallbackData(cq.data);
    if (!token) {
      await answerCallback(callbackId, 'Unrecognised button.', true);
      return NextResponse.json({ ok: true, ignored: true });
    }

    const ackSecret = await resolveAckSecret();
    if (!ackSecret) {
      throw new HttpError(503, 'Ack links are not configured (set ackSecret).');
    }
    const verdict = verifyAckToken(token, ackSecret, Date.now());
    const who = cq.from?.username
      ? `bot:@${cq.from.username}`
      : `bot:${cq.from?.first_name ?? cq.from?.id ?? 'unknown'}`;

    if (!verdict.ok) {
      await answerCallback(
        callbackId,
        verdict.reason === 'expired' ? 'This acknowledgement link has expired.' : 'This acknowledgement link is invalid.',
        true,
      );
      return NextResponse.json({ ok: true, acknowledged: false, reason: verdict.reason });
    }

    const engine = getEngine();
    await engine.ensureInit();
    try {
      await engine.acknowledgeIncident(verdict.incidentId, who);
      await answerCallback(callbackId, 'Incident acknowledged.', false);
      return NextResponse.json({ ok: true, acknowledged: true, by: who });
    } catch (err) {
      // 409 already-acknowledged is a benign race (button pressed twice)
      if (err instanceof HttpError && err.status === 409) {
        await answerCallback(callbackId, 'Already acknowledged.', false);
        return NextResponse.json({ ok: true, acknowledged: true, already: true });
      }
      throw err;
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
