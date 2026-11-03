// Sentinel-SLA — transactional outbox + dispatcher.
//
// Flow: detection/recovery/escalation/rule events → emitNotification() →
// one Alert feed row per audience (the dashboard story) + one NotificationOutbox
// row per MATCHING ENABLED channel (the delivery story). The dispatcher (worker
// loop / engine loop / explicit call) claims due rows, optionally merges same-
// service groups into one message, sends through the adapter, and records EVERY
// attempt in DeliveryLog. Failures back off exponentially (policy.decideFailure)
// and dead-letter after maxAttempts. Channel health counters + the linked Alert
// row's status are updated on terminal states.
//
// Transport mode (docs/ARCHITECTURE.md — offline-first):
//   simulate — demo/no-network: no packets leave the box; DeliveryLog rows are
//              still written so the audit story is identical across modes.
//   real     — actual adapters; failures retry then dead-letter honestly.
//   auto     — real in live mode, simulate in demo mode (default).
//
// Concurrency: the loop is started only by loop-owning processes (engine
// backgroundLoops / worker) with a globalThis guard + overlap flag; scheduler
// passes take the shared advisory lock (locks.ts) so two replicas never
// double-deliver on Postgres.

import { db } from '@/lib/db';
import { getConfig } from '@/server/config';
import { tryAcquireSchedulerLock, releaseSchedulerLock } from '@/server/locks';
import type { NotifyAudience, NotifySeverity, NotifyTopic, NotifyVars } from '@/server/notify/templates';
import { renderNotification } from '@/server/notify/templates';
import {
  dedupKeyFor,
  groupKeyFor,
  quietAdjustedAvailableAt,
  signAckToken,
  type QuietWindow,
} from '@/server/notify/policy';
import { dispatchByKind, DEFAULT_NOTIFY_CONFIG, type NotifyConfig, type OutgoingMessage } from '@/server/notify/adapters';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const TEHRAN_TZ_OFFSET_MIN = 210; // UTC+3:30 — the product's home market

/**
 * Newest archived PDF report. Returns null when the
 * archive is empty — a digest then ships text-only (honest: we never fake an
 * attachment). File-name convention from reportgen: sentinel-sla-report-*.pdf.
 */
export async function latestReportDocument(): Promise<{ filename: string; data: Buffer } | null> {
  try {
    const dir = getConfig().reportsDir;
    const names = (await readdir(dir)).filter((n) => /^sentinel-sla-report-.*\.pdf$/.test(n)).sort();
    if (names.length === 0) return null;
    const newest = names[names.length - 1];
    const data = await readFile(path.join(dir, newest));
    return { filename: newest, data };
  } catch {
    return null;
  }
}

export interface MatchedChannel {
  id: string;
  kind: string; // telegram | bale | webhook | email | mattermost | jira | redmine
  target: string;
  audience: string;
  secret: string | null;
  settings: string | null; // per-kind non-secret JSON (jira projectKey, redmine projectId, …)
}

/** Ticket-system kinds are for actionable incidents — the executive digest
 *  (topic 'digest') never creates tickets; chat kinds still receive it. */

async function matchingChannels(audience: NotifyAudience, topic?: NotifyTopic): Promise<MatchedChannel[]> {
  if (topic === 'digest') {
    const rows = (await db.$queryRaw`
      SELECT id, kind, target, audience, secret, settings
      FROM NotificationChannel
      WHERE enabled = TRUE AND (audience = ${audience} OR audience = 'both')
        AND kind NOT IN ('jira', 'redmine')
      ORDER BY createdAt ASC
    `) as MatchedChannel[];
    return rows;
  }
  const rows = (await db.$queryRaw`
    SELECT id, kind, target, audience, secret, settings
    FROM NotificationChannel
    WHERE enabled = TRUE AND (audience = ${audience} OR audience = 'both')
    ORDER BY createdAt ASC
  `) as MatchedChannel[];
  return rows;
}

// ── transport configuration ──────────────────────────────────────────────────

export interface NotifySettings {
  config: NotifyConfig;
  /** effective transport: 'simulate' | 'real' (auto already resolved) */
  transport: 'simulate' | 'real';
  ackSecret: string | null;
  publicBaseUrl: string;
}

/** IntegrationSetting first, env fallback — resolved fresh per dispatch pass. */
async function integrationValue(key: string, envVar: string): Promise<string | null> {
  try {
    const row = await db.integrationSetting.findUnique({ where: { key } });
    if (row?.value && row.value.trim().length > 0) return row.value.trim();
  } catch {
    /* table can be absent in exotic migrations — env is the fallback */
  }
  const env = process.env[envVar];
  return env && env.trim().length > 0 ? env.trim() : null;
}

export async function resolveNotifySettings(): Promise<NotifySettings> {
  const cfg = getConfig();
  const [telegramToken, baleToken, ackSecret] = await Promise.all([
    integrationValue('telegramBotToken', 'SENTINEL_TELEGRAM_BOT_TOKEN'),
    integrationValue('baleBotToken', 'SENTINEL_BALE_BOT_TOKEN'),
    integrationValue('ackSecret', 'SENTINEL_ACK_SECRET'),
  ]);
  const smtpHost = process.env.SENTINEL_SMTP_HOST ?? null;
  const transport = cfg.notifyTransport === 'auto' ? (cfg.mode === 'live' ? 'real' : 'simulate') : cfg.notifyTransport;
  return {
    config: {
      ...DEFAULT_NOTIFY_CONFIG,
      telegramToken,
      baleToken,
      telegramBase: process.env.SENTINEL_TELEGRAM_API_BASE ?? DEFAULT_NOTIFY_CONFIG.telegramBase,
      baleBase: process.env.SENTINEL_BALE_API_BASE ?? DEFAULT_NOTIFY_CONFIG.baleBase,
      timeoutMs: 10_000,
      smtp: smtpHost
        ? {
            host: smtpHost,
            port: Number(process.env.SENTINEL_SMTP_PORT ?? 587),
            from: process.env.SENTINEL_SMTP_FROM ?? 'sentinel@localhost',
            user: process.env.SENTINEL_SMTP_USER ?? null,
            pass: process.env.SENTINEL_SMTP_PASS ?? null,
            implicitTls: process.env.SENTINEL_SMTP_IMPLICIT_TLS === '1',
          }
        : null,
    },
    transport,
    ackSecret,
    publicBaseUrl: (process.env.SENTINEL_PUBLIC_BASE_URL ?? `http://localhost:${cfg.port ?? 3000}`).replace(/\/$/, ''),
  };
}

/** The signed ack link for an incident (null when no secret is configured). */
export async function ackUrlFor(incidentId: string, nowMs: number): Promise<string | null> {
  const s = await resolveNotifySettings();
  if (!s.ackSecret) return null;
  const token = signAckToken(incidentId, s.ackSecret, nowMs);
  return `${s.publicBaseUrl}/ack?token=${token}`;
}

// ── emit (the single entry point every alerting path uses) ───────────────────

export interface EmitInput {
  topic: NotifyTopic;
  severity: NotifySeverity;
  audiences: NotifyAudience[];
  vars: NotifyVars;
  incidentId?: string | null;
  serviceId?: string | null;
  serviceName?: string | null;
  ruleId?: string | null;
  /** rule quiet-hours window (rules only) — warning/info defer to window end */
  quiet?: QuietWindow | null;
  maxAttempts?: number;
  test?: boolean;
  now?: number;
}

export interface EmitResult {
  alertIds: string[];
  enqueued: number;
  deduped: number;
}

/**
 * Render + persist the Alert feed rows and fan the notification out to every
 * matching enabled channel as outbox rows. When NO channel matches, the Alert
 * row is still written (status delivered — the dashboard IS the delivery).
 */
export async function emitNotification(input: EmitInput): Promise<EmitResult> {
  const now = input.now ?? Date.now();
  const settings = await resolveNotifySettings();
  const alertIds: string[] = [];
  let enqueued = 0;
  let deduped = 0;

  for (const audience of input.audiences) {
    const channels = input.test
      ? await matchingChannels(audience, input.topic).then((cs) => cs.slice(0, 1))
      : await matchingChannels(audience, input.topic);

    // Ack link rides along on page-like topics when the instance can sign one;
    // it must exist BEFORE rendering so templates can embed it.
    let ackUrl: string | null = null;
    if (!input.test && input.incidentId && (input.topic === 'detection' || input.topic === 'escalation')) {
      ackUrl = await ackUrlFor(input.incidentId, now);
    }
    const rendered = renderNotification(input.topic, input.severity, audience, {
      ...input.vars,
      ackUrl: ackUrl ?? undefined,
    });

    const alertRow = await db.alert.create({
      data: {
        incidentId: input.incidentId ?? null,
        serviceId: input.serviceId ?? null,
        channel: channels.some((c) => c.kind === 'telegram' || c.kind === 'bale')
          ? 'telegram'
          : channels.some((c) => c.kind === 'webhook')
            ? 'webhook'
            : channels.length > 0
              ? channels[0].kind
              : 'dashboard',
        audience,
        severity: input.severity,
        title: rendered.title,
        message: rendered.body,
        status: channels.length === 0 ? 'delivered' : 'pending',
      },
    });
    alertIds.push(alertRow.id);

    for (const ch of channels) {
      const dKey = dedupKeyFor({
        topic: input.topic,
        incidentId: input.incidentId ?? null,
        ruleId: input.ruleId ?? null,
        audience,
        channelId: ch.id,
        nowMs: now,
      });
      if (dKey) {
        const dup = (await db.$queryRaw`
          SELECT id FROM NotificationOutbox
          WHERE dedupKey = ${dKey} AND status IN ('pending', 'delivering')
          LIMIT 1
        `) as { id: string }[];
        if (dup.length > 0) {
          deduped += 1;
          continue;
        }
      }
      const gKey = groupKeyFor({ serviceId: input.serviceId, channelId: ch.id, topic: input.topic });
      const availableAtMs = quietAdjustedAvailableAt(
        now,
        input.severity,
        input.quiet ?? null,
        TEHRAN_TZ_OFFSET_MIN,
      );
      await db.notificationOutbox.create({
        data: {
          availableAt: new Date(availableAtMs),
          kind: ch.kind,
          channelId: ch.id,
          target: ch.target,
          audience,
          severity: input.severity,
          topic: input.topic,
          title: rendered.title,
          body: rendered.body,
          incidentId: input.incidentId ?? null,
          serviceName: input.serviceName ?? null,
          alertId: alertRow.id,
          ackUrl,
          dedupKey: dKey,
          groupKey: gKey,
          maxAttempts: input.maxAttempts ?? 5,
          test: input.test ?? false,
        },
      });
      enqueued += 1;
    }
  }

  return { alertIds, enqueued, deduped };
}

// ── dispatcher ───────────────────────────────────────────────────────────────

interface OutboxRow {
  id: string;
  kind: string;
  channelId: string | null;
  target: string | null;
  audience: string;
  severity: string;
  topic: string;
  title: string;
  body: string;
  incidentId: string | null;
  serviceName: string | null;
  alertId: string | null;
  ackUrl: string | null;
  groupKey: string | null;
  attempts: number;
  maxAttempts: number;
}

export interface DispatchReport {
  now: number;
  claimed: number;
  delivered: number;
  failed: number;
  dead: number;
  grouped: number;
  skippedLocked: boolean;
}

/**
 * One dispatch pass. `now` is injectable — the escalation/dead-letter tests
 * drive the clock manually instead of sleeping through real backoffs.
 */
export async function runOutboxDispatch(opts: { now?: number; limit?: number } = {}): Promise<DispatchReport> {
  const now = opts.now ?? Date.now();
  const report: DispatchReport = { now, claimed: 0, delivered: 0, failed: 0, dead: 0, grouped: 0, skippedLocked: false };
  const settings = await resolveNotifySettings();

  const ok = await tryAcquireSchedulerLock('outbox-dispatch');
  if (!ok) {
    report.skippedLocked = true;
    return report;
  }

  try {
    // claim due rows: mark delivering + bump attempts (single owner per pass).
    // NOTE: Prisma stores SQLite DateTimes as INTEGER ms — raw comparisons and
    // writes must use epoch numbers, never ISO strings (text > any integer in
    // SQLite's cross-type ordering would make every row look "due").
    const dueIds = (
      await db.$queryRaw`
        SELECT id FROM NotificationOutbox
        WHERE status = 'pending' AND availableAt <= ${now}
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, createdAt ASC
        LIMIT ${opts.limit ?? 25}
      `
    ) as { id: string }[];
    if (dueIds.length === 0) {
      await maybePrune(now);
      return report;
    }
    for (const { id } of dueIds) {
      await db.$executeRaw`
        UPDATE NotificationOutbox
        SET status = 'delivering', attempts = attempts + 1, lastAttemptAt = ${now}
        WHERE id = ${id} AND status = 'pending'
      `;
    }
    // fetch claimed rows fully bound — one parameterized query per id
    const fetched: OutboxRow[] = [];
    for (const { id } of dueIds) {
      const r = (await db.$queryRaw`
        SELECT id, kind, channelId, target, audience, severity, topic, title, body,
               incidentId, serviceName, alertId, ackUrl, groupKey, attempts, maxAttempts
        FROM NotificationOutbox WHERE id = ${id}
      `) as OutboxRow[];
      if (r[0]) fetched.push(r[0]);
    }
    report.claimed = fetched.length;

    // group merge: same groupKey (channel+service) → one message
    const groups = new Map<string, OutboxRow[]>();
    for (const row of fetched) {
      const key = row.groupKey ?? `solo:${row.id}`;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }

    for (const [, list] of groups) {
      const primary = list[0];
      const merged = list.length > 1;
      if (merged) report.grouped += 1;

      const msg = merged ? groupedMessage(list, primary.audience as NotifyAudience) : { title: primary.title, body: primary.body };

      const effectiveKind = settings.transport === 'simulate' ? 'simulate' : primary.kind;
      // structured ack link (webhook JSON field + bot answer callbacks); the
      // rendered body already embeds it for text transports
      const ackUrl = merged ? list.find((r) => r.ackUrl)?.ackUrl ?? null : primary.ackUrl;
      // digest: file-capable bot channels get the newest archived PDF
      // attached (real transport only — simulate is bookkeeping-only).
      let document: OutgoingMessage['document'] = null;
      if (primary.topic === 'digest' && (primary.kind === 'telegram' || primary.kind === 'bale') && settings.transport === 'real') {
        document = await latestReportDocument();
      }
      const outgoing: OutgoingMessage = {
        title: msg.title,
        body: msg.body,
        topic: primary.topic,
        severity: primary.severity,
        incidentId: primary.incidentId,
        ackUrl,
        sentAt: new Date(now),
        document,
      };

      // channel secret + settings are read live (rows only snapshot target)
      let secret: string | null = null;
      let settingsRaw: string | null = null;
      if (primary.channelId) {
        const ch = (await db.$queryRaw`
          SELECT secret, settings FROM NotificationChannel WHERE id = ${primary.channelId}
        `) as { secret: string | null; settings: string | null }[];
        secret = ch[0]?.secret ?? null;
        settingsRaw = ch[0]?.settings ?? null;
      }

      const result = await dispatchByKind(effectiveKind, primary.target ?? '', outgoing, settings.config, secret, ackUrl, settingsRaw);

      for (const row of list) {
        await db.deliveryLog.create({
          data: {
            outboxId: row.id,
            channelId: row.channelId,
            kind: effectiveKind,
            ok: result.ok,
            statusCode: result.statusCode ?? null,
            error: result.error ?? null,
            ref: result.ref ?? null,
            latencyMs: result.latencyMs,
          },
        });
        if (result.ok) {
          await db.$executeRaw`
            UPDATE NotificationOutbox
            SET status = 'delivered', deliveredAt = ${now}, lastError = NULL
            WHERE id = ${row.id}
          `;
          if (row.channelId) {
            await db.$executeRaw`
              UPDATE NotificationChannel
              SET deliveredCount = COALESCE(deliveredCount,0) + 1, lastDeliveryAt = ${now}, lastError = NULL
              WHERE id = ${row.channelId}
            `;
          }
          report.delivered += 1;
        } else {
          const dead = row.attempts >= row.maxAttempts;
          if (dead) {
            await db.$executeRaw`
              UPDATE NotificationOutbox
              SET status = 'dead', lastError = ${result.error ?? 'delivery failed'}
              WHERE id = ${row.id}
            `;
            report.dead += 1;
          } else {
            const delayMs = Math.min(30_000 * 2 ** (row.attempts - 1), 15 * 60_000);
            await db.$executeRaw`
              UPDATE NotificationOutbox
              SET status = 'pending', availableAt = ${now + delayMs},
                  lastError = ${result.error ?? 'delivery failed'}
              WHERE id = ${row.id}
            `;
            report.failed += 1;
          }
          if (row.channelId) {
            await db.$executeRaw`
              UPDATE NotificationChannel
              SET failedCount = COALESCE(failedCount,0) + 1, lastError = ${result.error ?? 'delivery failed'}
              WHERE id = ${row.channelId}
            `;
          }
        }
        await settleAlertRow(row.alertId);
      }
    }

    await maybePrune(now);
    return report;
  } finally {
    await releaseSchedulerLock('outbox-dispatch');
  }
}

/** Synthetic grouped message (Alertmanager group_by semantics, scoped). */
function groupedMessage(rows: OutboxRow[], audience: NotifyAudience): { title: string; body: string } {
  const n = rows.length;
  const svc = rows[0].serviceName ?? 'service';
  const title =
    audience === 'executive' ? `${n.toLocaleString('fa-IR')} هشدار فعال — ${svc}` : `[GROUPED] ${n} alerts — ${svc}`;
  const body = rows
    .map((r) => `• [${r.severity.toUpperCase()}] ${r.title}: ${r.body.slice(0, 200)}`)
    .join('\n');
  return { title, body };
}

/**
 * Terminal-state rollup for the Alert feed row: when no outbox row for the
 * alert is pending/delivering anymore, delivered wins over dead-mixed, all-dead
 * means failed. Honest and idempotent.
 */
async function settleAlertRow(alertId: string | null): Promise<void> {
  if (!alertId) return;
  const stats = (
    await db.$queryRaw`
      SELECT
        SUM(CASE WHEN status IN ('pending','delivering') THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead,
        COUNT(*) AS total
      FROM NotificationOutbox WHERE alertId = ${alertId}
    `
  ) as { open: number | null; dead: number | null; total: number | null }[];
  const open = Number(stats[0]?.open ?? 0);
  if (open > 0) return; // still in flight
  const dead = Number(stats[0]?.dead ?? 0);
  const total = Number(stats[0]?.total ?? 0);
  const status = total > 0 && dead === total ? 'failed' : 'delivered';
  await db.$executeRaw`UPDATE Alert SET status = ${status} WHERE id = ${alertId}`;
}

// ── prune (keep the outbox a queue, not an archive) ──────────────────────────

let pruneCounter = 0;

async function maybePrune(now: number): Promise<void> {
  pruneCounter += 1;
  if (pruneCounter % 50 !== 1) return; // roughly every 50th pass
  const deliveredCutoff = now - 7 * 24 * 3600_000; // epoch ms — DateTime columns are integer ms
  const logCutoff = now - 30 * 24 * 3600_000;
  await db.$executeRaw`
    DELETE FROM DeliveryLog WHERE outboxId IN (
      SELECT id FROM NotificationOutbox WHERE status = 'delivered' AND deliveredAt < ${deliveredCutoff}
    )
  `;
  await db.$executeRaw`DELETE FROM NotificationOutbox WHERE status = 'delivered' AND deliveredAt < ${deliveredCutoff}`;
  await db.$executeRaw`DELETE FROM DeliveryLog WHERE at < ${logCutoff}`;
}

// ── read models (channel page + APIs) ────────────────────────────────────────

export async function outboxStats(): Promise<{ depth: number; dead: number }> {
  const rows = (await db.$queryRaw`
    SELECT
      SUM(CASE WHEN status IN ('pending','delivering') THEN 1 ELSE 0 END) AS depth,
      SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead
    FROM NotificationOutbox
  `) as { depth: number | null; dead: number | null }[];
  return { depth: Number(rows[0]?.depth ?? 0), dead: Number(rows[0]?.dead ?? 0) };
}

export interface DeliveryLogRow {
  id: string;
  outboxId: string;
  channelId: string | null;
  kind: string;
  ok: number | boolean;
  statusCode: number | null;
  error: string | null;
  ref: string | null;
  latencyMs: number;
  at: string | Date;
  title: string | null;
  severity: string | null;
  test: number | boolean | null;
}

export async function recentDeliveryLog(opts: { channelId?: string; limit?: number } = {}): Promise<DeliveryLogRow[]> {
  const limit = opts.limit ?? 50;
  if (opts.channelId) {
    return (await db.$queryRaw`
      SELECT l.id, l.outboxId, l.channelId, l.kind, l.ok, l.statusCode, l.error, l.ref, l.latencyMs, l.at,
             o.title, o.severity, o.test
      FROM DeliveryLog l LEFT JOIN NotificationOutbox o ON o.id = l.outboxId
      WHERE l.channelId = ${opts.channelId}
      ORDER BY l.at DESC LIMIT ${limit}
    `) as DeliveryLogRow[];
  }
  return (await db.$queryRaw`
    SELECT l.id, l.outboxId, l.channelId, l.kind, l.ok, l.statusCode, l.error, l.ref, l.latencyMs, l.at,
           o.title, o.severity, o.test
    FROM DeliveryLog l LEFT JOIN NotificationOutbox o ON o.id = l.outboxId
    ORDER BY l.at DESC LIMIT ${limit}
  `) as DeliveryLogRow[];
}

export async function listOutbox(opts: { status?: string; limit?: number } = {}): Promise<
  Array<{ id: string; topic: string; severity: string; audience: string; kind: string; target: string | null; title: string; status: string; attempts: number; maxAttempts: number; lastError: string | null; availableAt: string; createdAt: string; test: boolean }>
> {
  const limit = opts.limit ?? 100;
  const rows = opts.status
    ? ((await db.$queryRaw`
        SELECT id, topic, severity, audience, kind, target, title, status, attempts, maxAttempts,
               lastError, availableAt, createdAt, test
        FROM NotificationOutbox WHERE status = ${opts.status}
        ORDER BY createdAt DESC LIMIT ${limit}
      `) as Record<string, unknown>[])
    : ((await db.$queryRaw`
        SELECT id, topic, severity, audience, kind, target, title, status, attempts, maxAttempts,
               lastError, availableAt, createdAt, test
        FROM NotificationOutbox ORDER BY createdAt DESC LIMIT ${limit}
      `) as Record<string, unknown>[]);
  return rows.map((r) => ({
    id: String(r.id),
    topic: String(r.topic),
    severity: String(r.severity),
    audience: String(r.audience),
    kind: String(r.kind),
    target: (r.target as string | null) ?? null,
    title: String(r.title),
    status: String(r.status),
    attempts: Number(r.attempts ?? 0),
    maxAttempts: Number(r.maxAttempts ?? 0),
    lastError: (r.lastError as string | null) ?? null,
    availableAt: new Date(r.availableAt as string).toISOString(),
    createdAt: new Date(r.createdAt as string).toISOString(),
    test: Boolean(r.test),
  }));
}

/** Requeue a dead-lettered message (admin retry). Returns false if not dead. */
export async function retryDead(rollbackId: string, nowMs = Date.now()): Promise<boolean> {
  const res = await db.$executeRaw`
    UPDATE NotificationOutbox
    SET status = 'pending', attempts = 0, availableAt = ${nowMs}, lastError = NULL
    WHERE id = ${rollbackId} AND status = 'dead'
  `;
  return res > 0;
}

// ── test-send (channel page) ─────────────────────────────────────────────────

/**
 * Enqueue a test message to ONE channel directly (bypasses audience fan-out)
 * and — in simulate transport — run an immediate dispatch pass so the demo
 * shows the outcome instantly. In real transport the dispatcher delivers on
 * its next tick (honest: the user sees pending→delivered in the log).
 */
export async function sendTestMessage(channelId: string): Promise<{ ok: boolean; error?: string }> {
  const ch = (await db.$queryRaw`
    SELECT id, kind, target, audience, name FROM NotificationChannel WHERE id = ${channelId}
  `) as { id: string; kind: string; target: string; audience: string; name: string }[];
  if (ch.length === 0) return { ok: false, error: 'channel-not-found' };
  const row = ch[0];
  const settings = await resolveNotifySettings();
  const audience: NotifyAudience = row.audience === 'executive' ? 'executive' : 'technical';
  const rendered = renderNotification('test', 'info', audience, {
    channelName: row.name,
    kind: row.kind,
    kindFa: row.kind === 'telegram' ? 'تلگرام' : row.kind === 'bale' ? 'بله' : row.kind === 'email' ? 'ایمیل' : row.kind === 'mattermost' ? 'ماترموست' : row.kind === 'jira' ? 'جیرا' : row.kind === 'redmine' ? 'ردماین' : 'وب‌هوک',
    sentAt: new Date().toISOString(),
  });
  await db.notificationOutbox.create({
    data: {
      kind: row.kind,
      channelId: row.id,
      target: row.target,
      audience,
      severity: 'info',
      topic: 'test',
      title: rendered.title,
      body: rendered.body,
      serviceName: null,
      test: true,
    },
  });
  if (settings.transport === 'simulate') {
    const report = await runOutboxDispatch();
    return { ok: report.dead === 0 };
  }
  return { ok: true };
}

// ── loop lifecycle ───────────────────────────────────────────────────────────

const LOOP_KEY = '__sentinel_outbox_loop__';

interface LoopState {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
}

function loopState(): LoopState {
  const g = globalThis as unknown as { [LOOP_KEY]?: LoopState };
  if (!g[LOOP_KEY]) g[LOOP_KEY] = { timer: null, running: false };
  return g[LOOP_KEY];
}

/** Idempotent start (engine backgroundLoops / worker / live mode). */
export function startOutboxDispatcher(intervalMs = 5_000): number {
  const st = loopState();
  if (st.timer !== null) return intervalMs;
  st.timer = setInterval(() => {
    if (st.running) return; // overlap guard — a slow pass never stacks
    st.running = true;
    void runOutboxDispatch()
      .catch((err: unknown) =>
        console.error('[sentinel:outbox] dispatch pass failed:', err instanceof Error ? err.message : err),
      )
      .finally(() => {
        st.running = false;
      });
  }, intervalMs);
  console.log(`[sentinel:outbox] dispatcher started (every ${Math.round(intervalMs / 1000)}s)`);
  return intervalMs;
}

export function stopOutboxDispatcher(): void {
  const st = loopState();
  if (st.timer !== null) {
    clearInterval(st.timer);
    st.timer = null;
    console.log('[sentinel:outbox] dispatcher stopped');
  }
}
