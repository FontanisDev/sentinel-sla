// Sentinel-SLA — v2.2 alert governance data access (rules, channels, on-call).
//
// Same parameterized raw-SQL pattern as maintenance.ts/tenants.ts (HMR-safe
// under `prisma db push`; every value bound — OWASP ASVS L1).
//
// Semantics:
// - AlertRule: a user-defined policy evaluated by the engine every tick
//   against live per-service metrics, DISTINCT from probe-based detection.
//   Firing respects a per-rule cooldown; each firing writes Alert rows for
//   the rule's audience and increments delivery counters on matching channels.
// - NotificationChannel: delivery endpoint (telegram/webhook/email) with a
//   per-channel delivery counter + last outcome. Test deliveries exercise
//   the same path as real ones.
// - OnCallEntry: rotation member with a weekly coverage window. `active` is
//   computed against "now" at read time (day + minute-of-day, wrap-safe).

import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { HttpError } from '@/server/http';
import { sendTestMessage } from '@/server/notify/outbox';
import type {
  AlertMetric,
  AlertOperator,
  AlertRuleDTO,
  ChannelKind,
  ChannelStatus,
  CreateAlertRulePayload,
  CreateChannelPayload,
  CreateOnCallPayload,
  NotificationChannelDTO,
  OnCallEntryDTO,
  RuleAudience,
  UpdateChannelPayload,
} from '@/lib/types';

export interface AlertRuleRow {
  id: string;
  name: string;
  serviceId: string | null;
  metric: string;
  operator: string;
  threshold: number | unknown;
  severity: string;
  audience: string;
  cooldownMin: number | unknown;
  quietStartMin: number | null | unknown;
  quietEndMin: number | null | unknown;
  enabled: number | unknown;
  timesFired: number | unknown;
  lastFiredAt: Date | string | null;
  createdAt: Date | string;
  serviceName?: string | null;
}

export interface ChannelRow {
  id: string;
  name: string;
  kind: string;
  target: string;
  audience: string;
  enabled: number | unknown;
  deliveredCount: number | unknown;
  failedCount: number | unknown;
  lastDeliveryAt: Date | string | null;
  lastError: string | null;
  settings: string | null;
  createdAt: Date | string;
}

export interface OnCallRow {
  id: string;
  engineerName: string;
  role: string;
  handle: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

function newId(): string {
  const t = Date.now().toString(36).padStart(8, '0');
  const rand = Math.random().toString(36).slice(2, 12);
  return `c${t}${rand}`;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function channelStatus(enabled: boolean, lastError: string | null): ChannelStatus {
  if (!enabled) return 'disabled';
  return lastError ? 'degraded' : 'healthy';
}

// ── rules ───────────────────────────────────────────────────────────────────

// Column list spelled once — injected via Prisma.raw (compile-time identifiers,
// never user input; plain ${} would bind it as a VALUE parameter, not SQL).
const RULE_COLS = Prisma.raw(`r.id, r.name, r.serviceId, r.metric, r.operator, r.threshold, r.severity,
           r.audience, r.cooldownMin, r.quietStartMin, r.quietEndMin, r.enabled, r.timesFired,
           r.lastFiredAt, r.createdAt`);

export function toAlertRuleDTO(row: AlertRuleRow): AlertRuleDTO {
  return {
    id: row.id,
    name: row.name,
    serviceId: row.serviceId ?? null,
    serviceName: row.serviceName ?? null,
    metric: row.metric as AlertMetric,
    operator: row.operator as AlertOperator,
    threshold: Number(row.threshold ?? 0),
    severity: row.severity as AlertRuleDTO['severity'],
    audience: row.audience as RuleAudience,
    cooldownMin: Number(row.cooldownMin ?? 15),
    quietStartMin: row.quietStartMin === null || row.quietStartMin === undefined ? null : Number(row.quietStartMin),
    quietEndMin: row.quietEndMin === null || row.quietEndMin === undefined ? null : Number(row.quietEndMin),
    enabled: Boolean(row.enabled),
    timesFired: Number(row.timesFired ?? 0),
    lastFiredAt: toIso(row.lastFiredAt),
    createdAt: toIso(row.createdAt) ?? new Date().toISOString(),
    // live state is engine-owned; bare DB reads default to "not violating"
    violatedNow: false,
    measuredValue: null,
    violatedServiceName: null,
  };
}

/** All rules, enabled first, newest created first. */
export async function listAlertRules(): Promise<AlertRuleDTO[]> {
  const rows = (await db.$queryRaw`
    SELECT ${RULE_COLS}, s.name AS serviceName
    FROM AlertRule r
    LEFT JOIN Service s ON s.id = r.serviceId
    ORDER BY CASE WHEN r.enabled = TRUE THEN 1 ELSE 0 END DESC, r.createdAt DESC
  `) as AlertRuleRow[];
  return rows.map(toAlertRuleDTO);
}

/** Enabled rules only — the engine's hot path (tick evaluation). */
export async function listEnabledRules(): Promise<AlertRuleDTO[]> {
  const rows = (await db.$queryRaw`
    SELECT ${RULE_COLS}, s.name AS serviceName
    FROM AlertRule r
    LEFT JOIN Service s ON s.id = r.serviceId
    WHERE r.enabled = TRUE
  `) as AlertRuleRow[];
  return rows.map(toAlertRuleDTO);
}

async function getRuleRow(id: string): Promise<AlertRuleRow | null> {
  const rows = (await db.$queryRaw`
    SELECT ${RULE_COLS}, s.name AS serviceName
    FROM AlertRule r
    LEFT JOIN Service s ON s.id = r.serviceId
    WHERE r.id = ${id} LIMIT 1
  `) as AlertRuleRow[];
  return rows.length > 0 ? rows[0] : null;
}

export async function createAlertRule(payload: CreateAlertRulePayload): Promise<AlertRuleDTO> {
  const id = newId();
  const now = new Date(); // Date param → ORM-native storage (see maintenance.ts note)
  if (payload.serviceId) {
    const svc = (await db.$queryRaw`
      SELECT id FROM Service WHERE id = ${payload.serviceId} LIMIT 1
    `) as { id: string }[];
    if (svc.length === 0) throw new HttpError(404, `Service '${payload.serviceId}' not found`);
  }
  await db.$executeRaw`
    INSERT INTO AlertRule
      (id, name, serviceId, metric, operator, threshold, severity, audience, cooldownMin,
       quietStartMin, quietEndMin, enabled, timesFired, lastFiredAt, createdAt)
    VALUES
      (${id}, ${payload.name}, ${payload.serviceId ?? null}, ${payload.metric}, ${payload.operator},
       ${payload.threshold}, ${payload.severity ?? 'warning'}, ${payload.audience ?? 'technical'},
       ${payload.cooldownMin ?? 15}, ${payload.quietStartMin ?? null}, ${payload.quietEndMin ?? null},
       1, 0, NULL, ${now})
  `;
  const row = await getRuleRow(id);
  if (!row) throw new HttpError(500, 'Alert rule creation failed');
  return toAlertRuleDTO(row);
}

/** Toggle a rule. 404 unknown id; returns the updated rule. */
export async function setAlertRuleEnabled(id: string, enabled: boolean): Promise<AlertRuleDTO> {
  const updated = await db.$executeRaw`
    UPDATE AlertRule SET enabled = ${enabled ? 1 : 0} WHERE id = ${id}
  `;
  if (updated === 0) throw new HttpError(404, 'Alert rule not found');
  const row = await getRuleRow(id);
  if (!row) throw new HttpError(500, 'Alert rule update failed');
  return toAlertRuleDTO(row);
}

export async function deleteAlertRule(id: string): Promise<void> {
  const deleted = await db.$executeRaw`DELETE FROM AlertRule WHERE id = ${id}`;
  if (deleted === 0) throw new HttpError(404, 'Alert rule not found');
}

/**
 * Mark a rule as fired (cooldown bookkeeping). Race-safe single UPDATE —
 * only advances when the cooldown window has elapsed.
 */
export async function markRuleFired(id: string): Promise<void> {
  await db.$executeRaw`
    UPDATE AlertRule
    SET timesFired = COALESCE(timesFired, 0) + 1, lastFiredAt = ${new Date()}
    WHERE id = ${id}
  `;
}

// ── channels ─────────────────────────────────────────────────────────────────

export function toChannelDTO(row: ChannelRow): NotificationChannelDTO {
  const enabled = Boolean(row.enabled);
  // settings is non-secret per-kind config — echoed for round-tripping forms;
  // malformed JSON is surfaced as null rather than thrown over the API floor.
  let settings: Record<string, unknown> | null = null;
  if (row.settings) {
    try {
      const parsed = JSON.parse(row.settings) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
    } catch {
      settings = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ChannelKind,
    target: row.target,
    audience: row.audience as RuleAudience,
    enabled,
    deliveredCount: Number(row.deliveredCount ?? 0),
    failedCount: Number(row.failedCount ?? 0),
    lastDeliveryAt: toIso(row.lastDeliveryAt),
    lastError: row.lastError ?? null,
    settings,
    status: channelStatus(enabled, row.lastError ?? null),
    createdAt: toIso(row.createdAt) ?? new Date().toISOString(),
  };
}

const CHANNEL_COLS = Prisma.raw(`id, name, kind, target, audience, enabled, deliveredCount, failedCount,
  lastDeliveryAt, lastError, settings, createdAt`);

export async function listChannels(): Promise<NotificationChannelDTO[]> {
  const rows = (await db.$queryRaw`
    SELECT ${CHANNEL_COLS}
    FROM NotificationChannel
    ORDER BY CASE WHEN enabled = TRUE THEN 1 ELSE 0 END DESC, createdAt ASC
  `) as ChannelRow[];
  return rows.map(toChannelDTO);
}

async function getChannelRow(id: string): Promise<ChannelRow | null> {
  const rows = (await db.$queryRaw`
    SELECT ${CHANNEL_COLS} FROM NotificationChannel WHERE id = ${id} LIMIT 1
  `) as ChannelRow[];
  return rows.length > 0 ? rows[0] : null;
}

/** Per-kind target validation (OWASP ASVS L1 — reject garbage before storing). */
export function validateChannelTarget(kind: ChannelKind, target: string): string | null {
  if (kind === 'telegram' || kind === 'bale')
    return /^-?\d{4,}$|^@[A-Za-z0-9_]{4,}$/.test(target)
      ? null
      : `${kind === 'bale' ? 'Bale' : 'Telegram'} target must be a numeric chat id or @username`;
  if (kind === 'webhook' || kind === 'mattermost') {
    try {
      const u = new URL(target);
      const label = kind === 'webhook' ? 'Webhook' : 'Mattermost';
      return u.protocol === 'https:' || u.protocol === 'http:' ? null : `${label} target must be an http(s) URL`;
    } catch {
      return `${kind === 'webhook' ? 'Webhook' : 'Mattermost'} target must be a valid URL`;
    }
  }
  if (kind === 'jira' || kind === 'redmine') {
    try {
      const u = new URL(target);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('bad protocol');
      const label = kind === 'jira' ? 'Jira' : 'Redmine';
      return u.pathname === '/' || u.pathname === ''
        ? null
        : `${label} target must be the site base URL without a path (e.g. https://jira.example.com)`;
    } catch {
      return `${kind === 'jira' ? 'Jira' : 'Redmine'} target must be a valid base URL (e.g. https://jira.example.com)`;
    }
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(target) ? null : 'Email target must be a valid address';
}

export async function createChannel(payload: CreateChannelPayload): Promise<NotificationChannelDTO> {
  const id = newId();
  const now = new Date(); // Date param → ORM-native storage (see maintenance.ts note)
  const settingsJson = payload.settings ? JSON.stringify(payload.settings) : null;
  await db.$executeRaw`
    INSERT INTO NotificationChannel
      (id, name, kind, target, audience, enabled, secret, settings, deliveredCount, failedCount, lastDeliveryAt, lastError, createdAt)
    VALUES
      (${id}, ${payload.name}, ${payload.kind}, ${payload.target}, ${payload.audience ?? 'technical'},
       1, ${payload.secret ?? null}, ${settingsJson}, 0, 0, NULL, NULL, ${now})
  `;
  const row = await getChannelRow(id);
  if (!row) throw new HttpError(500, 'Channel creation failed');
  return toChannelDTO(row);
}

/** PATCH semantics: undefined = keep, null secret/settings = clear. */
export async function updateChannel(id: string, payload: UpdateChannelPayload): Promise<NotificationChannelDTO> {
  const row = await getChannelRow(id);
  if (!row) throw new HttpError(404, 'Channel not found');
  const name = payload.name?.trim() ?? row.name;
  const target = payload.target ?? row.target;
  const audience = payload.audience ?? row.audience;
  const enabled = payload.enabled ?? Boolean(row.enabled);
  const validationError = validateChannelTarget(row.kind as ChannelKind, target);
  if (validationError) throw new HttpError(400, validationError);
  // settings: undefined keeps, explicit value sets, null clears
  const settingsJson = payload.settings === undefined ? row.settings : payload.settings ? JSON.stringify(payload.settings) : null;
  // secret: undefined keeps, explicit value sets, null clears
  if (payload.secret === undefined && settingsJson === row.settings) {
    await db.$executeRaw`
      UPDATE NotificationChannel
      SET name = ${name}, target = ${target}, audience = ${audience}, enabled = ${enabled ? 1 : 0}
      WHERE id = ${id}
    `;
  } else if (payload.secret === undefined) {
    await db.$executeRaw`
      UPDATE NotificationChannel
      SET name = ${name}, target = ${target}, audience = ${audience}, enabled = ${enabled ? 1 : 0},
          settings = ${settingsJson}
      WHERE id = ${id}
    `;
  } else {
    await db.$executeRaw`
      UPDATE NotificationChannel
      SET name = ${name}, target = ${target}, audience = ${audience}, enabled = ${enabled ? 1 : 0},
          secret = ${payload.secret}, settings = ${settingsJson}
      WHERE id = ${id}
    `;
  }
  const updated = await getChannelRow(id);
  if (!updated) throw new HttpError(500, 'Channel update failed');
  return toChannelDTO(updated);
}

export async function setChannelEnabled(id: string, enabled: boolean): Promise<NotificationChannelDTO> {
  const updated = await db.$executeRaw`
    UPDATE NotificationChannel SET enabled = ${enabled ? 1 : 0} WHERE id = ${id}
  `;
  if (updated === 0) throw new HttpError(404, 'Channel not found');
  const row = await getChannelRow(id);
  if (!row) throw new HttpError(500, 'Channel update failed');
  return toChannelDTO(row);
}

export async function deleteChannel(id: string): Promise<void> {
  const deleted = await db.$executeRaw`DELETE FROM NotificationChannel WHERE id = ${id}`;
  if (deleted === 0) throw new HttpError(404, 'Channel not found');
}

/**
 * REAL test delivery: enqueue a test message that ONLY this channel
 * receives and let the outbox dispatcher carry it (simulate transport →
 * instant bookkeeping; real transport → the configured adapter). The outcome
 * lands in the delivery log + channel counters like any other message.
 */
export async function testChannelDelivery(id: string): Promise<NotificationChannelDTO> {
  const row = await getChannelRow(id);
  if (!row) throw new HttpError(404, 'Channel not found');
  const result = await sendTestMessage(id);
  if (result.error === 'channel-not-found') throw new HttpError(404, 'Channel not found');
  const updated = await getChannelRow(id);
  if (!updated) throw new HttpError(500, 'Channel test failed');
  return toChannelDTO(updated);
}

// ── on-call ──────────────────────────────────────────────────────────────────

function toOnCallDTO(row: OnCallRow, now = new Date()): OnCallEntryDTO {
  const day = now.getDay(); // 0=Sunday … 6=Saturday
  const minute = now.getHours() * 60 + now.getMinutes();
  const active =
    row.dayOfWeek === day &&
    (row.startMinute <= row.endMinute
      ? minute >= row.startMinute && minute < row.endMinute
      : minute >= row.startMinute || minute < row.endMinute); // wraps midnight
  return {
    id: row.id,
    engineerName: row.engineerName,
    role: row.role,
    handle: row.handle,
    dayOfWeek: row.dayOfWeek,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    active,
  };
}

export async function listOnCall(): Promise<OnCallEntryDTO[]> {
  const rows = (await db.$queryRaw`
    SELECT id, engineerName, role, handle, dayOfWeek, startMinute, endMinute
    FROM OnCallEntry
    ORDER BY dayOfWeek ASC, startMinute ASC
  `) as OnCallRow[];
  const now = new Date();
  return rows.map((r) => toOnCallDTO(r, now));
}

export async function createOnCallEntry(payload: CreateOnCallPayload): Promise<OnCallEntryDTO> {
  const id = newId();
  await db.$executeRaw`
    INSERT INTO OnCallEntry (id, engineerName, role, handle, dayOfWeek, startMinute, endMinute)
    VALUES (${id}, ${payload.engineerName}, ${payload.role}, ${payload.handle},
            ${payload.dayOfWeek}, ${payload.startMinute}, ${payload.endMinute})
  `;
  const rows = (await db.$queryRaw`
    SELECT id, engineerName, role, handle, dayOfWeek, startMinute, endMinute
    FROM OnCallEntry WHERE id = ${id} LIMIT 1
  `) as OnCallRow[];
  if (rows.length === 0) throw new HttpError(500, 'On-call entry creation failed');
  return toOnCallDTO(rows[0]);
}

export async function deleteOnCallEntry(id: string): Promise<void> {
  const deleted = await db.$executeRaw`DELETE FROM OnCallEntry WHERE id = ${id}`;
  if (deleted === 0) throw new HttpError(404, 'On-call entry not found');
}

// ── seeding (demo policy so the UI never renders empty) ─────────────────────

let seeded = false;

/**
 * Seed default governance rows once (idempotent — guarded by a SELECT).
 * These mirror the product's telegram-tech / webhook-exec channel pair.
 */
export async function ensureGovernanceSeeded(): Promise<void> {
  if (seeded) return;
  const existing = (await db.$queryRaw`
    SELECT COUNT(*) AS n FROM AlertRule
  `) as { n: number | unknown }[];
  if (Number(existing[0]?.n ?? 0) === 0) {
    const now = new Date(); // Date param → ORM-native storage
    await db.$executeRaw`
      INSERT INTO AlertRule (id, name, serviceId, metric, operator, threshold, severity, audience, cooldownMin, enabled, timesFired, lastFiredAt, createdAt)
      VALUES
        (${newId()}, 'Fleet uptime floor', NULL, 'uptime', 'lt', 0.999, 'critical', 'executive', 30, 1, 0, NULL, ${now}),
        (${newId()}, 'Error rate ceiling', NULL, 'errorRate', 'gt', 0.05, 'warning', 'technical', 15, 1, 0, NULL, ${now}),
        (${newId()}, 'Latency SLO ceiling', NULL, 'latencyMs', 'gt', 2500, 'warning', 'technical', 10, 1, 0, NULL, ${now})
    `;
  }
  const ch = (await db.$queryRaw`
    SELECT COUNT(*) AS n FROM NotificationChannel
  `) as { n: number | unknown }[];
  if (Number(ch[0]?.n ?? 0) === 0) {
    const now = new Date(); // Date param → ORM-native storage
    await db.$executeRaw`
      INSERT INTO NotificationChannel (id, name, kind, target, audience, enabled, deliveredCount, lastDeliveryAt, lastError, createdAt)
      VALUES
        (${newId()}, 'SRE War Room', 'telegram', '@sentinel_sre', 'technical', 1, 0, NULL, NULL, ${now}),
        (${newId()}, 'Executive Digest', 'webhook', 'https://hooks.example.ir/exec', 'executive', 1, 0, NULL, NULL, ${now})
    `;
  }
  const oc = (await db.$queryRaw`
    SELECT COUNT(*) AS n FROM OnCallEntry
  `) as { n: number | unknown }[];
  if (Number(oc[0]?.n ?? 0) === 0) {
    // Today + tomorrow coverage so the "active now" strip always shows someone.
    const today = new Date().getDay();
    const tomorrow = (today + 1) % 7;
    await db.$executeRaw`
      INSERT INTO OnCallEntry (id, engineerName, role, handle, dayOfWeek, startMinute, endMinute)
      VALUES
        (${newId()}, 'Arman Tehrani', 'Primary', '@arman_sre', ${today}, 0, 1440),
        (${newId()}, 'Sara Karimi', 'Secondary', '@sara_oncall', ${today}, 540, 1080),
        (${newId()}, 'Kaveh Rahimi', 'Primary', '@kaveh_sre', ${tomorrow}, 0, 1440),
        (${newId()}, 'Negar Moradi', 'Manager', '@negar_vp', ${today}, 540, 1200)
    `;
  }
  seeded = true;
}
