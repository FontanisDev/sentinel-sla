// Sentinel-SLA — channel adapters (real transports).
//
// One adapter per channel kind. Every adapter returns the SAME AttemptResult
// so the dispatcher's retry/dead-letter policy (policy.decideFailure) is
// transport-agnostic:
//   { ok, statusCode?, error?, latencyMs }
//
// Transports:
//   telegram  — Bot API sendMessage (POST {base}/bot<token>/sendMessage);
//               ack links ride along as an inline keyboard button when a
//               signed token exists.
//   bale      — Bale messenger (Iranian Telegram-compatible Bot API, same
//               request shape, different base URL).
//   webhook   — JSON POST to the channel target with an optional HMAC-SHA256
//               body signature header (X-Sentinel-Signature: sha256=<hex>).
//   mattermost— Mattermost incoming webhook: POST {text, channel?, username?}
//               to the hook URL. One-way chat delivery (no ack callback).
//   jira      — Jira REST v2 issue create: POST {base}/rest/api/2/issue with
//               Basic auth (secret "email:api-token") or Bearer PAT. The
//               created issue key rides back as AttemptResult.ref.
//   redmine   — Redmine REST issue create: POST {base}/issues.json with the
//               X-Redmine-API-Key header. ref = "#<id>".
//   email     — minimal RFC 5321 SMTP client (EHLO/AUTH PLAIN/MAIL/RCPT/DATA)
//               over node:net (or node:tls for implicit-TLS port 465). No new
//               dependencies — offline-first.
//   simulate  — demo/no-network mode: bookkeeping only, always ok.
//
// All network calls carry a hard timeout; a timeout is an error like any
// other and flows into the same retry policy. Nothing here reads the db —
// configuration arrives fully resolved via NotifyConfig.

import { createHmac } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export type AdapterKind = 'telegram' | 'bale' | 'webhook' | 'email' | 'simulate';

export interface AttemptResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
  latencyMs: number;
  /**
   * Created-ticket reference for the ticketing kinds (Jira issue key,
   * Redmine "#id") — surfaced in the delivery log so an engineer can jump
   * straight to the ticket. Undefined for message transports.
   */
  ref?: string;
}

/**
 * Raw per-kind settings as stored on the channel row (JSON text or null).
 * Parsed + validated per kind at the adapter boundary — the adapters own the
 * "is this usable?" answer and refuse honestly (attempt error, never throw).
 */
export function parseChannelSettings(
  kind: string,
  raw: string | null,
): { ok: true; value: Record<string, unknown> | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'channel-settings-invalid-json' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'channel-settings-not-an-object' };
  }
  if (kind === 'jira' || kind === 'redmine') {
    const o = parsed as Record<string, unknown>;
    const key = kind === 'jira' ? 'projectKey' : 'projectId';
    const v = o[key];
    if (typeof v !== 'string' || v.trim().length < (kind === 'jira' ? 2 : 1)) {
      return { ok: false, error: `${kind}-settings-missing-${key}` };
    }
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export interface SmtpConfig {
  host: string;
  port: number;
  from: string;
  user?: string | null;
  pass?: string | null;
  /** implicit TLS (port 465 style). STARTTLS is not attempted — documented. */
  implicitTls?: boolean;
}

export interface NotifyConfig {
  telegramToken: string | null;
  baleToken: string | null;
  telegramBase: string; // overridable for tests (mock server)
  baleBase: string;
  smtp: SmtpConfig | null; // null = email transport not configured
  timeoutMs: number;
}

export const DEFAULT_NOTIFY_CONFIG: NotifyConfig = {
  telegramToken: null,
  baleToken: null,
  telegramBase: 'https://api.telegram.org',
  baleBase: 'https://tapi.bale.ai',
  smtp: null,
  timeoutMs: 10_000,
};

export interface OutgoingMessage {
  title: string;
  body: string;
  topic: string;
  severity: string;
  incidentId?: string | null;
  ackUrl?: string | null;
  sentAt: Date;
  /**
   * Optional file attachment (executive digest: the newest archived
   * PDF report rides along to file-capable channels). Telegram/Bale deliver
   * it via sendDocument; webhook/email transports are text-only and ignore it
   * (documented in the UI — no fake attachment claims).
   */
  document?: { filename: string; data: Buffer } | null;
}

function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

// ── telegram / bale (Bot API shape) ──────────────────────────────────────────

export function buildAckKeyboard(ackUrl: string | null | undefined): Array<Array<{ text: string; url: string }>> | undefined {
  if (!ackUrl) return undefined;
  return [[{ text: '✅ Acknowledge / تأیید', url: ackUrl }]];
}

/**
 * Multipart sendDocument (Bot API shape) — the PDF-attach path for the
 * executive digest. Uses the platform's native FormData/Blob so no upload
 * dependency is added (offline-first: node 18+ and Bun both ship them).
 */
export async function botApiSendDocument(
  base: string,
  token: string,
  chatId: string,
  msg: OutgoingMessage,
  timeoutMs: number,
): Promise<AttemptResult> {
  const started = Date.now();
  if (!token) return { ok: false, error: 'bot-token-not-configured', latencyMs: 0 };
  if (!msg.document) return { ok: false, error: 'no-document', latencyMs: 0 };
  const url = `${base.replace(/\/$/, '')}/bot${token}/sendDocument`;
  try {
    const form = new FormData();
    form.set('chat_id', chatId);
    form.set('caption', `${msg.title}\n${msg.body}`.slice(0, 1024)); // Bot API caption limit
    const bytes = msg.document.data;
    form.set(
      'document',
      new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], {
        type: 'application/pdf',
      }),
      msg.document.filename,
    );
    const res = await timedFetch(url, { method: 'POST', body: form }, timeoutMs);
    const latencyMs = Date.now() - started;
    const ok = res.status === 200;
    let error: string | undefined;
    if (!ok) {
      let detail = '';
      try {
        const j = (await res.json()) as { description?: string };
        detail = j?.description ? ` — ${j.description}` : '';
      } catch {
        /* non-JSON error body */
      }
      error = `bot-api-${res.status}${detail}`;
    }
    return { ok, statusCode: res.status, error, latencyMs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started };
  }
}

async function botApiSend(
  base: string,
  token: string,
  chatId: string,
  msg: OutgoingMessage,
  timeoutMs: number,
  extra: Record<string, unknown> = {},
): Promise<AttemptResult> {
  // digest rows carry the PDF when the archive has one — sendDocument path
  if (msg.document) return botApiSendDocument(base, token, chatId, msg, timeoutMs);
  const started = Date.now();
  if (!token) return { ok: false, error: 'bot-token-not-configured', latencyMs: 0 };
  const url = `${base.replace(/\/$/, '')}/bot${token}/sendMessage`;
  try {
    const res = await timedFetch(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `${msg.title}\n${msg.body}`,
          disable_web_page_preview: true,
          ...extra,
        }),
      },
      timeoutMs,
    );
    const latencyMs = Date.now() - started;
    const ok = res.status === 200;
    let error: string | undefined;
    if (!ok) {
      let detail = '';
      try {
        const j = (await res.json()) as { description?: string };
        detail = j?.description ? ` — ${j.description}` : '';
      } catch {
        /* non-JSON error body */
      }
      error = `bot-api-${res.status}${detail}`;
    }
    return { ok, statusCode: res.status, error, latencyMs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started };
  }
}

export function sendTelegram(
  target: string,
  msg: OutgoingMessage,
  cfg: NotifyConfig,
  ackUrl?: string | null,
): Promise<AttemptResult> {
  const keyboard = buildAckKeyboard(ackUrl);
  return botApiSend(cfg.telegramBase, cfg.telegramToken ?? '', target, msg, cfg.timeoutMs, keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {});
}

export function sendBale(target: string, msg: OutgoingMessage, cfg: NotifyConfig, ackUrl?: string | null): Promise<AttemptResult> {
  const keyboard = buildAckKeyboard(ackUrl);
  return botApiSend(cfg.baleBase, cfg.baleToken ?? '', target, msg, cfg.timeoutMs, keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {});
}

// ── webhook (signed JSON POST) ───────────────────────────────────────────────

export interface WebhookPayload {
  source: 'sentinel-sla';
  topic: string;
  severity: string;
  title: string;
  body: string;
  incidentId: string | null;
  ackUrl: string | null;
  sentAt: string;
}

export function buildWebhookPayload(msg: OutgoingMessage, ackUrl: string | null): WebhookPayload {
  return {
    source: 'sentinel-sla',
    topic: msg.topic,
    severity: msg.severity,
    title: msg.title,
    body: msg.body,
    incidentId: msg.incidentId ?? null,
    ackUrl,
    sentAt: msg.sentAt.toISOString(),
  };
}

/** HMAC signature header value: `sha256=<hex>` over the exact body bytes. */
export function signWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

export async function sendWebhook(
  target: string,
  msg: OutgoingMessage,
  cfg: NotifyConfig,
  secret: string | null,
  ackUrl: string | null,
): Promise<AttemptResult> {
  const started = Date.now();
  const payload = buildWebhookPayload(msg, ackUrl);
  const body = JSON.stringify(payload);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (secret) headers['x-sentinel-signature'] = signWebhookBody(body, secret);
    const res = await timedFetch(target, { method: 'POST', headers, body }, cfg.timeoutMs);
    const latencyMs = Date.now() - started;
    const ok = res.status >= 200 && res.status < 300;
    return { ok, statusCode: res.status, error: ok ? undefined : `http-${res.status}`, latencyMs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started };
  }
}

// ── mattermost (incoming webhook, one-way chat) ──────────────────────────────

export interface MattermostPayload {
  text: string;
  channel?: string;
  username?: string;
  props?: { sentinel: { topic: string; severity: string; incidentId: string | null } };
}

export function buildMattermostPayload(msg: OutgoingMessage, settings: Record<string, unknown> | null): MattermostPayload {
  const payload: MattermostPayload = {
    text: `${msg.title}\n${msg.body}`,
    props: { sentinel: { topic: msg.topic, severity: msg.severity, incidentId: msg.incidentId ?? null } },
  };
  if (settings) {
    const channel = settings['channel'];
    if (typeof channel === 'string' && channel.trim()) payload.channel = channel.trim();
    const username = settings['username'];
    if (typeof username === 'string' && username.trim()) payload.username = username.trim();
  }
  return payload;
}

export async function sendMattermost(
  target: string,
  msg: OutgoingMessage,
  cfg: NotifyConfig,
  settingsRaw: string | null,
): Promise<AttemptResult> {
  const started = Date.now();
  const parsed = parseChannelSettings('mattermost', settingsRaw);
  if (!parsed.ok) return { ok: false, error: parsed.error, latencyMs: 0 };
  const body = JSON.stringify(buildMattermostPayload(msg, parsed.value));
  try {
    const res = await timedFetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, cfg.timeoutMs);
    const latencyMs = Date.now() - started;
    // Mattermost answers 200 with the body "ok" on success.
    const ok = res.status === 200;
    return { ok, statusCode: res.status, error: ok ? undefined : `mattermost-${res.status}`, latencyMs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started };
  }
}

// ── jira (REST v2 issue create) ──────────────────────────────────────────────

export interface JiraIssueFields {
  project: { key: string };
  summary: string;
  description: string;
  issuetype: { name: string };
}

export function buildJiraIssueFields(msg: OutgoingMessage, settings: Record<string, unknown> | null): JiraIssueFields | { error: string } {
  if (!settings || typeof settings['projectKey'] !== 'string' || !settings['projectKey'].trim()) {
    return { error: 'jira-settings-missing-projectKey' };
  }
  const issueTypeName = typeof settings['issueTypeName'] === 'string' && settings['issueTypeName'].trim() ? settings['issueTypeName'].trim() : 'Task';
  return {
    project: { key: (settings['projectKey'] as string).trim() },
    summary: msg.title,
    description: `${msg.body}\n\n— Sentinel-SLA (${msg.topic}, severity ${msg.severity}${msg.incidentId ? `, incident ${msg.incidentId}` : ''})`,
    issuetype: { name: issueTypeName },
  };
}

/**
 * Jira credential: `email:api-token` (Atlassian cloud Basic auth) or a bare
 * Personal Access Token (Jira Server/Data Center Bearer). Refuses honestly
 * when absent — a 401 from a wrong credential shows up as the server's
 * status code, not a guess.
 */
function jiraAuthHeader(secret: string | null): { header: string } | { error: string } {
  if (!secret || !secret.trim()) return { error: 'jira-credential-not-configured' };
  if (secret.includes(':')) {
    return { header: `Basic ${Buffer.from(secret, 'utf8').toString('base64')}` };
  }
  return { header: `Bearer ${secret.trim()}` };
}

export async function sendJira(
  target: string,
  msg: OutgoingMessage,
  cfg: NotifyConfig,
  secret: string | null,
  settingsRaw: string | null,
): Promise<AttemptResult> {
  const started = Date.now();
  const auth = jiraAuthHeader(secret);
  if ('error' in auth) return { ok: false, error: auth.error, latencyMs: 0 };
  const parsed = parseChannelSettings('jira', settingsRaw);
  if (!parsed.ok) return { ok: false, error: parsed.error, latencyMs: 0 };
  const fields = buildJiraIssueFields(msg, parsed.value);
  if ('error' in fields) return { ok: false, error: fields.error, latencyMs: 0 };
  const url = `${target.replace(/\/$/, '')}/rest/api/2/issue`;
  try {
    const res = await timedFetch(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth.header },
        body: JSON.stringify({ fields }),
      },
      cfg.timeoutMs,
    );
    const latencyMs = Date.now() - started;
    if (res.status === 201) {
      let ref: string | undefined;
      try {
        const j = (await res.json()) as { key?: string };
        if (j?.key) ref = j.key;
      } catch {
        /* body not JSON — success without a parseable key */
      }
      return { ok: true, statusCode: 201, ref, latencyMs };
    }
    let detail = '';
    try {
      const j = (await res.json()) as { errorMessages?: string[] };
      detail = j?.errorMessages?.length ? ` — ${j.errorMessages.join('; ')}` : '';
    } catch {
      /* non-JSON error body */
    }
    return { ok: false, statusCode: res.status, error: `jira-${res.status}${detail}`, latencyMs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started };
  }
}

// ── redmine (REST issue create) ──────────────────────────────────────────────

export interface RedmineIssueBody {
  issue: { subject: string; description: string; project_id: string };
}

export function buildRedmineIssueBody(msg: OutgoingMessage, settings: Record<string, unknown> | null): RedmineIssueBody | { error: string } {
  if (!settings || typeof settings['projectId'] !== 'string' || !settings['projectId'].trim()) {
    return { error: 'redmine-settings-missing-projectId' };
  }
  return {
    issue: {
      subject: msg.title,
      description: `${msg.body}\n\n— Sentinel-SLA (${msg.topic}, severity ${msg.severity}${msg.incidentId ? `, incident ${msg.incidentId}` : ''})`,
      project_id: (settings['projectId'] as string).trim(),
    },
  };
}

export async function sendRedmine(
  target: string,
  msg: OutgoingMessage,
  cfg: NotifyConfig,
  secret: string | null,
  settingsRaw: string | null,
): Promise<AttemptResult> {
  const started = Date.now();
  if (!secret || !secret.trim()) return { ok: false, error: 'redmine-credential-not-configured', latencyMs: 0 };
  const parsed = parseChannelSettings('redmine', settingsRaw);
  if (!parsed.ok) return { ok: false, error: parsed.error, latencyMs: 0 };
  const body = buildRedmineIssueBody(msg, parsed.value);
  if ('error' in body) return { ok: false, error: body.error, latencyMs: 0 };
  const url = `${target.replace(/\/$/, '')}/issues.json`;
  try {
    const res = await timedFetch(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-redmine-api-key': secret.trim() },
        body: JSON.stringify(body),
      },
      cfg.timeoutMs,
    );
    const latencyMs = Date.now() - started;
    if (res.status === 201) {
      let ref: string | undefined;
      try {
        const j = (await res.json()) as { issue?: { id?: number } };
        if (typeof j?.issue?.id === 'number') ref = `#${j.issue.id}`;
      } catch {
        /* body not JSON — success without a parseable id */
      }
      return { ok: true, statusCode: 201, ref, latencyMs };
    }
    return { ok: false, statusCode: res.status, error: `redmine-${res.status}`, latencyMs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started };
  }
}

// ── email (minimal SMTP client, RFC 5321 subset) ─────────────────────────────

/** RFC 2047 base64 subject encoding for non-ASCII (Persian) subjects. */
export function encodeSubject(subject: string): string {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return `=?utf-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

/** DATA payload with dot-stuffing, terminated by CRLF.CRLF (RFC 5321 §4.1.1.4). */
export function buildEmailPayload(from: string, to: string, subject: string, body: string, sentAt: Date): string {
  const lines = [
    `From: Sentinel-SLA <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${sentAt.toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
  ];
  return lines.join('\r\n').replace(/\r\n\./g, '\r\n..') + '\r\n.\r\n';
}

/**
 * One-shot SMTP send on a fresh connection (simple, honest, and fine for the
 * volumes an SLA notifier produces). Resolves when the final DATA dot is
 * accepted (250); any non-2xx reply or socket error rejects the send.
 */
export function sendEmail(target: string, msg: OutgoingMessage, cfg: NotifyConfig): Promise<AttemptResult> {
  const started = Date.now();
  const smtp = cfg.smtp;
  if (!smtp) return Promise.resolve({ ok: false, error: 'smtp-not-configured', latencyMs: 0 });

  return new Promise<AttemptResult>((resolve) => {
    const finish = (r: Omit<AttemptResult, 'latencyMs'>): void => resolve({ ...r, latencyMs: Date.now() - started });
    const socket: Socket = smtp.implicitTls
      ? tlsConnect({ host: smtp.host, port: smtp.port })
      : netConnect({ host: smtp.host, port: smtp.port });

    socket.setTimeout(cfg.timeoutMs);

    // The plan: each entry waits for a server reply carrying `expect`; when it
    // arrives, `onReply` fires (the next command or the DATA payload) and we
    // wait for the following entry. authPlain is inserted dynamically.
    const authPlain =
      smtp.user && smtp.pass
        ? Buffer.from(`\u0000${smtp.user}\u0000${smtp.pass}`, 'utf8').toString('base64')
        : null;
    const payload = buildEmailPayload(smtp.from, target, msg.title, `${msg.title}\n${msg.body}`, msg.sentAt);

    const plan: Array<{ expect: number; onReply?: () => void }> = [
      { expect: 220, onReply: () => socket.write('EHLO sentinel\r\n') },
      { expect: 250, onReply: () => (authPlain ? socket.write(`AUTH PLAIN ${authPlain}\r\n`) : socket.write(`MAIL FROM:<${smtp.from}>\r\n`)) },
    ];
    if (authPlain) {
      plan.push({ expect: 235, onReply: () => socket.write(`MAIL FROM:<${smtp.from}>\r\n`) });
    }
    plan.push(
      { expect: 250, onReply: () => socket.write(`RCPT TO:<${target}>\r\n`) },
      { expect: 250, onReply: () => socket.write('DATA\r\n') },
      { expect: 354, onReply: () => socket.write(payload) }, // payload ends with CRLF.CRLF
      { expect: 250, onReply: () => socket.write('QUIT\r\n') },
      { expect: 221 }, // goodbye → success
    );

    let step = 0;
    let buffer = '';

    const fail = (error: string, statusCode?: number): void => {
      socket.destroy();
      finish({ ok: false, error, statusCode });
    };

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      // replies end with "NNN<SP>text\r\n"; "-" continuation lines are skipped
      while (/\r\n/.test(buffer)) {
        const m = /^(\d{3})([ -])(.*)\r\n/.exec(buffer);
        if (!m) break;
        buffer = buffer.slice(m.index + m[0].length);
        if (m[2] === '-') continue;
        const stepDef = plan[step];
        const code = Number(m[1]);
        if (!stepDef || code !== stepDef.expect) {
          fail(`smtp-${code}-expected-${stepDef?.expect ?? 'reply'}`, code);
          return;
        }
        step += 1;
        if (step >= plan.length) {
          socket.end();
          finish({ ok: true, statusCode: code });
          return;
        }
        stepDef.onReply?.();
      }
    });
    socket.on('timeout', () => fail('smtp-timeout'));
    socket.on('error', (err: Error) => fail(err.message));
  });
}

// ── simulate (demo / offline bookkeeping) ────────────────────────────────────

export async function sendSimulate(): Promise<AttemptResult> {
  return { ok: true, statusCode: 200, latencyMs: 0 };
}

// ── dispatch surface ─────────────────────────────────────────────────────────

export function dispatchByKind(
  kind: string,
  target: string,
  msg: OutgoingMessage,
  cfg: NotifyConfig,
  channelSecret: string | null,
  ackUrl: string | null,
  channelSettingsRaw: string | null = null,
): Promise<AttemptResult> {
  switch (kind) {
    case 'telegram':
      return sendTelegram(target, msg, cfg, ackUrl);
    case 'bale':
      return sendBale(target, msg, cfg, ackUrl);
    case 'webhook':
      return sendWebhook(target, msg, cfg, channelSecret, ackUrl);
    case 'email':
      return sendEmail(target, msg, cfg);
    case 'mattermost':
      return sendMattermost(target, msg, cfg, channelSettingsRaw);
    case 'jira':
      return sendJira(target, msg, cfg, channelSecret, channelSettingsRaw);
    case 'redmine':
      return sendRedmine(target, msg, cfg, channelSecret, channelSettingsRaw);
    case 'simulate':
      return sendSimulate();
    default:
      return Promise.resolve({ ok: false, error: `unknown-adapter:${kind}`, latencyMs: 0 });
  }
}
