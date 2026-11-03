// Sentinel-SLA — Zabbix trigger import (integrations:
// "Grafana/Zabbix alert import"). This slice: Zabbix triggers exported as
// JSON (the response of the Zabbix API's trigger.get with expandDescription
// and selectHosts — the standard way operators pull trigger definitions)
// → Sentinel policy rules, through the SAME downstream pipeline as the
// Grafana import (same MappedRow report, same create-rule schema gate,
// same all-or-nothing commit in the route).
//
// HONESTY CONTRACT (identical to the Grafana importer): a trigger maps ONLY
// when its item key + expression is confidently one of Sentinel's four
// metric families. Host-resource triggers (CPU, memory, disk, interfaces —
// most of a stock Zabbix template) are refused with the exact reason:
// Sentinel monitors SERVICES, not hosts. Sentinel only has lt/gt
// comparisons, so equality on continuous items and fires-when-healthy
// shapes stay unmapped; `= 0` on a service-availability item is the one
// deliberate exception (mapped to uptime lt 1 — "any availability loss"),
// the same documented equivalence as Grafana's `up == 0`.
//
// Recognised expression syntax:
//   Zabbix 5.4+:  last(/host/item.key[,params])<10
//   Legacy ≤ 5.2: {host:item.key.func(0)}<10
// Everything here is PURE: no db, no engine, no clock.

import { createAlertRuleSchema } from '@/server/validation';
import type { MappedRow, MappedRule } from './grafana-import';

/** Import caps (same guard as the Grafana/CSV imports). */
export const IMPORT_MAX_RULES = 200;
export const IMPORT_MAX_BYTES = 512 * 1024;

// ── export shapes ────────────────────────────────────────────────────────

export type ParsedZabbixFile =
  | { ok: true; triggers: ZabbixTrigger[] }
  | { ok: false; error: string };

export interface ZabbixTrigger {
  triggerid?: unknown;
  description?: unknown;
  expression?: unknown;
  priority?: unknown;
  status?: unknown;
  hosts?: unknown;
}

/**
 * Parse the exported JSON text into the raw trigger list. Accepts a bare
 * array (trigger.get returns exactly that) or {triggers:[…]} wrappers.
 */
export function parseZabbixExport(text: string): ParsedZabbixFile {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: 'Not valid JSON — paste the trigger list from the Zabbix API (trigger.get returns a JSON array)',
    };
  }
  if (Array.isArray(doc)) return { ok: true, triggers: doc as ZabbixTrigger[] };
  if (doc !== null && typeof doc === 'object') {
    for (const key of ['triggers', 'data', 'result']) {
      const arr = (doc as Record<string, unknown>)[key];
      if (Array.isArray(arr)) return { ok: true, triggers: arr as ZabbixTrigger[] };
    }
  }
  return {
    ok: false,
    error:
      'Unrecognised export shape — expected a JSON array of triggers (trigger.get result) or {"triggers":[…]}',
  };
}

// ── expression parsing ───────────────────────────────────────────────────

interface ZabbixExpression {
  host: string;
  key: string;
  func: string;
  op: string;
  value: number;
}

/**
 * Parse both supported syntaxes into host/key/func/op/value. Returns null
 * for anything else (multi-term expressions, functions without an item,
 * macro-only triggers, calculated triggers) — those are honestly unmapped.
 */
export function parseZabbixExpression(expr: string): ZabbixExpression | null {
  const e = expr.replace(/\s+/g, ' ').trim();
  // Numbers in Zabbix expressions: plain integer/decimal constants.
  const num = String.raw`(-?\d+(?:\.\d+)?)`;
  const ops = String.raw`(>=|<=|=|!=|<>|>|<)`;

  // Modern (5.4+): func(/host/key[,params])<op><value>
  const modern = new RegExp(
    String.raw`^(last|min|max|avg|sum|count|nodata|strlen|change|diff)\(\/([^\/\[\]()]+)\/([^()]*?)\)\s*${ops}\s*${num}$`,
  );
  const m = e.match(modern);
  if (m) {
    const value = Number(m[5]);
    if (Number.isFinite(value)) {
      return { host: m[2].trim(), key: m[3].trim(), func: m[1], op: m[4], value };
    }
  }

  // Legacy (≤ 5.2): {host:key.func(param)}<op><value>
  const legacy = new RegExp(
    String.raw`^\{([^:{}\[\]()]+):([^:{}]+)\.([a-z_]+)\([^()]*\)\}\s*${ops}\s*${num}$`,
    'i',
  );
  const l = e.match(legacy);
  if (l) {
    const value = Number(l[5]);
    if (Number.isFinite(value)) {
      return { host: l[1].trim(), key: l[2].trim(), func: l[3].toLowerCase(), op: l[4], value };
    }
  }
  return null;
}

/** Sentinel only allows lt|gt — map the Zabbix operator or reject. */
function mapOperator(op: string): 'lt' | 'gt' | null {
  switch (op) {
    case '>':
    case '>=':
      return 'gt';
    case '<':
    case '<=':
      return 'lt';
    default:
      return null; // = / != / <> on a continuous item: not representable
  }
}

// ── metric classification by item key ────────────────────────────────────
// Zabbix has no metric "type" on a trigger — the family is recognised from
// the item key. Documented in docs/USER-GUIDE.md and pinned by golden
// unit tests; extend the families, not ad-hoc cases.

const AVAIL_KEYS = /^(agent\.ping|icmpping(\.|$)|icmppingsec|icmppingloss|net\.tcp\.service|net\.udp\.service|net\.tcp\.port|web\.page\.get)/;
const PERF_SECONDS = /(\.|^)(net\.tcp\.service\.perf|net\.udp\.service\.perf|web\.page\.perf)/;
const WEB_FAIL = /^web\.test\.fail/;
const RE_TRAFFIC =
  /(requests?|req_per|qps|tps|transactions?|queries|http|nginx|apache|hits)/i;
const HOST_RESOURCE =
  /^(system\.cpu|vm\.memory|vfs\.fs|net\.if\.|system\.swap|system\.uptime|proc\.num|system\.load|memory)/;

interface Classification {
  metric: MappedRule['metric'];
  operator: 'lt' | 'gt';
  threshold: number;
  note?: string;
}
type Classified = Classification | { unmapped: string };

function classify(func: string, key: string, op: string, value: number): Classified {
  // 1. Availability items — service/host up-down probes.
  if (PERF_SECONDS.test(key)) {
    // Zabbix perf items are ALWAYS seconds (documented units) — the unit
    // is declared by the item itself, so conversion is not a guess.
    if (value < 0) return { unmapped: `negative latency threshold ${value}` };
    const operator = mapOperator(op);
    if (!operator) return { unmapped: `${op} on a continuous duration is not representable (Sentinel compares < or > only)` };
    return { metric: 'latencyMs', operator, threshold: value * 1000, note: `${value} s → ${(value * 1000).toFixed(0)} ms (Zabbix perf items report seconds)` };
  }
  if (AVAIL_KEYS.test(key)) {
    // Down/loss/unreachable shapes → "any availability loss".
    if (op === '=' && value === 0) {
      return { metric: 'uptime', operator: 'lt', threshold: 1, note: 'fires when the item reports DOWN — mapped to uptime < 1 (any availability loss)' };
    }
    if (func === 'nodata' && op === '=' && value === 1) {
      return { metric: 'uptime', operator: 'lt', threshold: 1, note: 'nodata fires when the agent stops reporting — mapped to uptime < 1 (any availability loss)' };
    }
    if ((op === '<' || op === '<=') && value > 0 && value <= 1) {
      return { metric: 'uptime', operator: 'lt', threshold: value };
    }
    // packet-loss style: icmppingloss > X (percent of lost packets)
    if (key.startsWith('icmppingloss') && (op === '>' || op === '>=') && value >= 0 && value <= 100) {
      return { metric: 'uptime', operator: 'lt', threshold: 1, note: `packet loss ${op} ${value}% mapped to uptime < 1 (any availability loss)` };
    }
    // Fires-when-healthy / up-values — never map.
    if ((op === '=' || op === '>' || op === '>=') && value >= 1 && !key.startsWith('icmppingloss')) {
      return { unmapped: `'${key} ${op} ${value}' fires when the service is UP — likely a recovery trigger, not an alert; import manually if intended` };
    }
    return { unmapped: `'${key} ${op} ${value}' is not a recognisable availability condition` };
  }
  if (WEB_FAIL.test(key)) {
    // Failed web-scenario steps — from the client's perspective the
    // service is degraded: any failure = availability loss.
    if ((op === '>' || op === '>=') && value >= 0) {
      return { metric: 'uptime', operator: 'lt', threshold: 1, note: `web scenario failures ${op} ${value} mapped to uptime < 1 (any availability loss)` };
    }
    return { unmapped: `'${key} ${op} ${value}' is not a recognisable availability condition` };
  }
  // 2. Host-resource triggers — Sentinel monitors services, not hosts.
  if (HOST_RESOURCE.test(key)) {
    return { unmapped: 'host-resource trigger (CPU/memory/disk/network interface/load) — Sentinel monitors services (uptime, errorRate, latencyMs, throughput), so import this as a custom rule only if the item is really a service signal' };
  }
  // 3. Traffic counters over request/transaction families.
  if (RE_TRAFFIC.test(key)) {
    if (value < 0) return { unmapped: `negative throughput threshold ${value}` };
    const operator = mapOperator(op);
    if (!operator) return { unmapped: `${op} on a continuous rate is not representable (Sentinel compares < or > only) — e.g. write last(...) < 1 instead of = 0` };
    return { metric: 'throughput', operator, threshold: value };
  }
  return { unmapped: 'item key is not recognisably one of uptime / errorRate / latencyMs / throughput — import it manually with a custom rule' };
}

// ── metadata mapping ─────────────────────────────────────────────────────

/** Zabbix severity (0=Not classified … 5=Disaster) → Sentinel severity. */
export function mapPriority(priority: unknown): { severity: 'critical' | 'warning'; note?: string } {
  const v = typeof priority === 'string' || typeof priority === 'number' ? String(priority) : '';
  if (v === '4' || v === '5') return { severity: 'critical', note: `Zabbix priority ${v} (${v === '4' ? 'High' : 'Disaster'}) mapped to critical` };
  if (v === '2' || v === '3') return { severity: 'warning', note: `Zabbix priority ${v} (${v === '2' ? 'Warning' : 'Average'}) mapped to warning` };
  if (v === '0' || v === '1') return { severity: 'warning', note: `Zabbix priority ${v} (${v === '0' ? 'Not classified' : 'Information'}) defaulted to warning` };
  return { severity: 'warning', note: 'no priority set — defaulted to warning' };
}

function mapTriggerName(t: ZabbixTrigger, index: number): { name: string; notes: string[] } {
  const notes: string[] = [];
  const raw = typeof t.description === 'string' ? t.description.trim() : '';
  if (raw === '') {
    notes.push('trigger has no description — named from its triggerid/position');
    const id = typeof t.triggerid === 'string' || typeof t.triggerid === 'number' ? String(t.triggerid) : String(index + 1);
    return { name: `Zabbix trigger ${id}`.slice(0, 80), notes };
  }
  if (raw.length > 80) {
    notes.push('description clamped to 80 characters (Zabbix descriptions can be longer; Sentinel names max 80)');
    return { name: raw.slice(0, 80), notes };
  }
  return { name: raw, notes };
}

function hostLabelOf(t: ZabbixTrigger): { label?: string; note?: string } {
  if (!Array.isArray(t.hosts) || t.hosts.length === 0) return {};
  const h = t.hosts[0] as { host?: unknown; name?: unknown };
  const label = typeof h?.host === 'string' && h.host.trim() !== '' ? h.host.trim() : typeof h?.name === 'string' && h.name.trim() !== '' ? h.name.trim() : undefined;
  if (!label) return {};
  if (t.hosts && (t.hosts as unknown[]).length > 1) {
    return { label, note: `trigger spans ${(t.hosts as unknown[]).length} hosts — bound to the first ('${label}'); review the others manually` };
  }
  return { label };
}

/** Map one raw Zabbix trigger to a row of the import report. */
export function mapZabbixTrigger(t: ZabbixTrigger, index: number): MappedRow {
  const title = typeof t.description === 'string' ? t.description : undefined;
  const row: MappedRow = { index, title, ok: false };

  if (t === null || typeof t !== 'object') {
    row.error = 'entry is not a trigger object';
    return row;
  }
  // Disabled triggers must not become enabled Sentinel rules silently.
  if (String(t.status ?? '0') !== '0') {
    row.error = 'trigger is disabled in Zabbix (status=1) — enable it there or import manually as a custom rule';
    return row;
  }
  if (typeof t.expression !== 'string' || t.expression.trim() === '') {
    row.error = 'trigger has no expression (calculated/macro-only triggers cannot be mapped)';
    return row;
  }
  const parsed = parseZabbixExpression(t.expression);
  if (!parsed) {
    row.error = `expression is not a single-term function threshold (last/min/max/avg(/host/key) <op> <value>): '${t.expression.replace(/\s+/g, ' ').slice(0, 120)}'`;
    return row;
  }
  const classified = classify(parsed.func, parsed.key, parsed.op, parsed.value);
  if ('unmapped' in classified) {
    row.error = `${classified.unmapped} — expression: '${t.expression.replace(/\s+/g, ' ').slice(0, 120)}'`;
    return row;
  }

  const { name, notes } = mapTriggerName(t, index);
  if (classified.note) notes.push(classified.note);
  const priority = mapPriority(t.priority);
  if (priority.note) notes.push(priority.note);
  const host = hostLabelOf(t);
  if (host.note) notes.push(host.note);
  if (host.label) {
    notes.push(`host '${host.label}' — resolved against the Sentinel registry on commit (unknown name aborts the import)`);
  }

  // Final gate: the payload MUST satisfy the real create-rule schema.
  const payload = {
    name,
    metric: classified.metric,
    operator: classified.operator,
    threshold: classified.threshold,
    severity: priority.severity,
  };
  const checked = createAlertRuleSchema.safeParse(payload);
  if (!checked.success) {
    row.error = `mapped payload rejected by the create-rule schema: ${checked.error.issues[0]?.message ?? 'validation failed'}`;
    return row;
  }

  row.ok = true;
  row.rule = { ...payload, serviceLabel: host.label, notes };
  return row;
}

/** Whole-file pipeline: parse + per-trigger mapping (pure, zero side effects). */
export function importZabbixTriggers(text: string): { ok: false; error: string } | { ok: true; rows: MappedRow[] } {
  if (text.length > IMPORT_MAX_BYTES) {
    return { ok: false, error: `export exceeds ${IMPORT_MAX_BYTES} bytes` };
  }
  const file = parseZabbixExport(text);
  if (!file.ok) return file;
  if (file.triggers.length === 0) return { ok: false, error: 'the export contains no triggers' };
  if (file.triggers.length > IMPORT_MAX_RULES) {
    return { ok: false, error: `export contains ${file.triggers.length} triggers — the cap is ${IMPORT_MAX_RULES} per import` };
  }
  return { ok: true, rows: file.triggers.map((t, i) => mapZabbixTrigger(t, i)) };
}
