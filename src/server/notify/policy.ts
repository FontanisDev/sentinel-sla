// Sentinel-SLA — dispatch policy (pure module).
//
// Every decision the outbox dispatcher makes that a reviewer might ask "why?"
// about lives here as a pure function of injected inputs (no db, no clock, no
// network): retry backoff, give-up→dead-letter, quiet-hours deferral,
// de-duplication and the signed-acknowledgement tokens. The dispatcher in
// outbox.ts is then a thin, boring executor.
//
// Backoff policy (documented in docs/DOMAIN.md §6): attempt N (1-based) that
// fails is retried after min(30s · 2^(N−1), 15 min) — 30s, 1m, 2m, 4m, 8m, 15m,
// 15m… A message whose attempts reach maxAttempts without success goes to the
// dead-letter state (`dead`) with the last error preserved. Delivery log rows
// are written for EVERY attempt regardless of outcome.

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface DispatchDecision {
  status: 'pending' | 'dead';
  /** Earliest next attempt (undefined for dead). */
  availableAtMs?: number;
}

/**
 * Decide the fate of a message whose attempt N just failed.
 * attempts is the count AFTER incrementing for the failed attempt.
 */
export function decideFailure(
  attempts: number,
  maxAttempts: number,
  nowMs: number,
  baseDelayMs = 30_000,
  maxDelayMs = 15 * 60_000,
): DispatchDecision {
  if (!Number.isFinite(attempts) || attempts < 1) attempts = 1;
  if (attempts >= maxAttempts) return { status: 'dead' };
  const delay = Math.min(baseDelayMs * 2 ** (attempts - 1), maxDelayMs);
  return { status: 'pending', availableAtMs: nowMs + delay };
}

/** Human-readable backoff table for docs/UI/tests. */
export function backoffTable(maxAttempts = 6, baseDelayMs = 30_000, maxDelayMs = 15 * 60_000): number[] {
  const out: number[] = [];
  for (let n = 1; n < maxAttempts; n++) {
    out.push(Math.min(baseDelayMs * 2 ** (n - 1), maxDelayMs));
  }
  return out;
}

// ── quiet hours ──────────────────────────────────────────────────────────────

export interface QuietWindow {
  /** minutes from midnight, 0..1439; start===end means full-day quiet */
  startMin: number;
  endMin: number;
}

/** Is `minuteOfDay` inside [start,end) (wrap-safe)? start===end = always quiet. */
export function inQuietHours(minuteOfDay: number, w: QuietWindow): boolean {
  const m = ((Math.round(minuteOfDay) % 1440) + 1440) % 1440;
  if (w.startMin === w.endMin) return true;
  if (w.startMin < w.endMin) return m >= w.startMin && m < w.endMin;
  return m >= w.startMin || m < w.endMin; // wraps midnight
}

/**
 * Minutes from `minuteOfDay` until the window ends (wrap-safe).
 * 0 when inside-but-ending-now semantics are not needed — always ≥ 1 while inside.
 */
export function minutesUntilQuietEnd(minuteOfDay: number, w: QuietWindow): number {
  const m = ((Math.round(minuteOfDay) % 1440) + 1440) % 1440;
  if (!inQuietHours(m, w)) return 0;
  let diff = w.endMin - m;
  if (diff <= 0) diff += 1440;
  return diff;
}

/**
 * Whether a message of `severity` may be delivered RIGHT NOW given a rule's
 * quiet window. Policy: critical pages always go out (a production outage
 * never waits for morning); warning/info are DEFERRED to the window end —
 * queued in the outbox with availableAt shifted, never dropped.
 * Returns the effective availableAt epoch-ms.
 */
export function quietAdjustedAvailableAt(
  nowMs: number,
  severity: 'critical' | 'warning' | 'info',
  quiet: QuietWindow | null,
  tzOffsetMin = 0, // minutes EAST of UTC (e.g. Tehran = 210)
): number {
  if (!quiet || severity === 'critical') return nowMs;
  const local = new Date(nowMs + tzOffsetMin * 60_000);
  const minuteOfDay = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (!inQuietHours(minuteOfDay, quiet)) return nowMs;
  return nowMs + minutesUntilQuietEnd(minuteOfDay, quiet) * 60_000;
}

// ── de-duplication ───────────────────────────────────────────────────────────

/**
 * Stable dedup key for a notification stream. Two messages with the same key
 * and no delivered terminal state yet collapse to one — Alertmanager-style
 * de-dup. `null` disables dedup for that message (tests, digests).
 */
export function dedupKeyFor(parts: {
  topic: string;
  incidentId?: string | null;
  ruleId?: string | null;
  audience: string;
  channelId: string;
  windowMs?: number; // time-bucket (default 10 min) so repeats stay honest
  nowMs?: number;
}): string | null {
  if (parts.topic === 'test' || parts.topic === 'digest') return null;
  const bucket = Math.floor((parts.nowMs ?? Date.now()) / (parts.windowMs ?? 600_000));
  return [parts.topic, parts.incidentId ?? '-', parts.ruleId ?? '-', parts.audience, parts.channelId, bucket].join(':');
}

// ── grouping ─────────────────────────────────────────────────────────────────

/**
 * Grouping key: messages to the SAME channel about the SAME service may be
 * merged into one multi-line message by the dispatcher (Alertmanager group_by
 * semantics, scoped to what actually matters here). Null = never grouped.
 */
export function groupKeyFor(parts: { serviceId?: string | null; channelId: string; topic: string }): string | null {
  if (parts.topic === 'test' || parts.topic === 'digest') return null;
  if (!parts.serviceId) return null;
  return `${parts.channelId}:${parts.serviceId}`;
}

// ── signed acknowledgement tokens ────────────────────────────────────────────
// Format: base64url({incidentId, exp}).hexHMAC-SHA256(secret, payload)
// Verified by the public /ack page and the Telegram callback. No state — the
// link survives process restarts as long as the secret does.

export interface AckPayload {
  incidentId: string;
  /** expiry epoch-ms */
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function signAckToken(incidentId: string, secret: string, nowMs: number, ttlMs = 7 * 24 * 3600_000): string {
  const payload: AckPayload = { incidentId, exp: nowMs + ttlMs };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const mac = createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${mac}`;
}

export function verifyAckToken(
  token: string,
  secret: string,
  nowMs: number,
): { ok: true; incidentId: string } | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' } {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed' };
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(mac, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature' };
  let payload: AckPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AckPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof payload?.incidentId !== 'string' || typeof payload?.exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (payload.exp < nowMs) return { ok: false, reason: 'expired' };
  return { ok: true, incidentId: payload.incidentId };
}

/** callback_data payload for the Telegram/Bale ack button (64-byte limit). */
export function ackCallbackData(token: string): string {
  return `ack:${token}`;
}

export function parseAckCallbackData(data: string): string | null {
  if (!data.startsWith('ack:')) return null;
  const token = data.slice(4);
  return token.length > 0 ? token : null;
}
