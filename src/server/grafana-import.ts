// Sentinel-SLA — Grafana alert-rule import (integrations:
// "Grafana/Zabbix alert import"). This slice: Grafana unified-alerting
// rules (the JSON that Grafana's alerting UI exports, also served by
// GET /api/v1/provisioning/alert-rules) → Sentinel policy rules.
//
// HONESTY CONTRACT (same as the CSV import, "truthful numbers" rule):
// a rule is mapped ONLY when its PromQL shape is confidently recognised as
// one of Sentinel's four metrics (uptime | errorRate | latencyMs |
// throughput). Everything else lands in the per-row report as "unmapped"
// with the exact reason — the importer never silently guesses a mapping,
// because a mis-mapped alert rule is wrong-money surveillance. Sentinel
// only has lt/gt comparisons, so `!=` and equality on continuous metrics
// stay unmapped too; `up == 0` is the one deliberate exception (mapped to
// uptime lt 1: "any availability loss"), documented below.
//
// Everything here is PURE: no db, no engine, no clock. The route composes
// these helpers with service resolution, authz and createAlertRule — a
// dry-run is literally the same pipeline with the write step removed.

import { createAlertRuleSchema } from '@/server/validation';

/** Import caps (same DoS guard + report readability as the CSV import). */
export const IMPORT_MAX_RULES = 200;
export const IMPORT_MAX_BYTES = 512 * 1024;

// ── Grafana export shapes ────────────────────────────────────────────────
// Accepted: { rules: [...] } (provisioning export), a bare rule array
// (multi-select export), or a single rule object (one-rule export).

export interface GrafanaQueryData {
  refId?: unknown;
  datasource?: unknown;
  model?: unknown;
}

export interface GrafanaRule {
  uid?: unknown;
  title?: unknown;
  ruleGroup?: unknown;
  condition?: unknown;
  for?: unknown;
  labels?: unknown;
  annotations?: unknown;
  data?: unknown;
}

export type ParsedGrafanaFile =
  | { ok: true; rules: GrafanaRule[] }
  | { ok: false; error: string };

/** Parse the exported JSON file text into the raw rule list. */
export function parseGrafanaExport(text: string): ParsedGrafanaFile {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Not valid JSON — paste the Grafana alert-rules export (JSON)' };
  }
  if (Array.isArray(doc)) return { ok: true, rules: doc as GrafanaRule[] };
  if (doc !== null && typeof doc === 'object') {
    const rules = (doc as { rules?: unknown }).rules;
    if (Array.isArray(rules)) return { ok: true, rules: rules as GrafanaRule[] };
    // A single rule object has the same fields (title/data/labels) — accept it.
    if ('data' in (doc as object) || 'title' in (doc as object)) {
      return { ok: true, rules: [doc as GrafanaRule] };
    }
  }
  return {
    ok: false,
    error:
      "Unrecognised export shape — expected {\"rules\":[…]}, a rule array, or a single rule object",
  };
}

// ── PromQL extraction ────────────────────────────────────────────────────

/** Pull the alert-condition expression out of a rule's query pipeline. */
export function extractExpr(rule: GrafanaRule): string | null {
  const data = rule.data;
  if (!Array.isArray(data)) return null;
  const entries = data as GrafanaQueryData[];

  // Prefer the entry the condition points at (refId === condition) when it
  // carries an expr; otherwise the last expr in the pipeline (Grafana's
  // typical A=query → B=threshold layout puts the alerting expr last).
  const modelExpr = (m: unknown): string | null => {
    if (m !== null && typeof m === 'object') {
      const expr = (m as { expr?: unknown }).expr;
      if (typeof expr === 'string' && expr.trim() !== '') return expr.trim();
    }
    return null;
  };

  if (typeof rule.condition === 'string' && rule.condition !== '') {
    const cond = entries.find((e) => e?.refId === rule.condition);
    const fromCond = cond ? modelExpr(cond.model) : null;
    if (fromCond) return fromCond;
  }
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const expr = modelExpr(entries[i]?.model);
    if (expr) return expr;
  }
  return null;
}

/** Collapse whitespace so recognition does not depend on formatting. */
export function normalizeExpr(expr: string): string {
  return expr.replace(/\s+/g, ' ').trim();
}

// ── Comparison recognition ───────────────────────────────────────────────
// Recognised: `<lhs> <op> <number>` or `<number> <op> <lhs>` with op in
// > < >= <= == != — the shape Grafana's own "threshold" expressions
// virtually always take for these four metric families.

interface Comparison {
  lhs: string;
  op: '>=' | '<=' | '>' | '<' | '==' | '!=';
  threshold: number;
  /** true when the number came first (`0.05 < ratio`) and was flipped. */
  reversed: boolean;
}

export function parseComparison(expr: string): Comparison | null {
  const num = String.raw`(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)`;
  const ops = String.raw`(>=|<=|==|!=|>|<)`;
  const forward = new RegExp(`^(.+?)\\s*${ops}\\s*${num}$`);
  const reverse = new RegExp(`^${num}\\s*${ops}\\s*(.+)$`);

  const m = expr.match(forward);
  if (m) {
    const threshold = Number(m[3]);
    if (Number.isFinite(threshold))
      return { lhs: m[1].trim(), op: m[2] as Comparison['op'], threshold, reversed: false };
  }
  const r = expr.match(reverse);
  if (r) {
    const threshold = Number(r[1]);
    if (Number.isFinite(threshold)) {
      const flipped: Record<string, Comparison['op']> = {
        '>': '<', '<': '>', '>=': '<=', '<=': '>=', '==': '==', '!=': '!=',
      };
      return { lhs: r[3].trim(), op: flipped[r[2]], threshold, reversed: true };
    }
  }
  return null;
}

/** Sentinel only allows lt|gt (schema enum) — map the PromQL op or reject. */
function mapOperator(op: Comparison['op']): 'lt' | 'gt' | null {
  switch (op) {
    case '>':
    case '>=':
      return 'gt';
    case '<':
    case '<=':
      return 'lt';
    default:
      return null; // == / != on a continuous metric: not representable
  }
}

// ── Metric classification ────────────────────────────────────────────────
// Keyword families, in evaluation order. Documented in docs/USER-GUIDE.md
// and pinned by golden unit tests — extend the families, not ad-hoc cases.

const RE_UP = String.raw`(?:^|[\s(})])up\b`;
const RE_ERROR = /(?:error|fail|5xx|status\s*=~?\s*"5|code\s*=~?\s*"5)/i;
const RE_LATENCY = /(?:histogram_quantile|duration|latency|response_time|rtt)/i;
const RE_SECONDS = /_seconds\b|_duration_seconds\b|_bucket\b/;
const RE_MILLIS = /_milliseconds\b|_ms\b/;
const RE_COUNTER = /(?:rate|irate|increase)\s*\(/;
const RE_TRAFFIC =
  /(?:request|req\b|txn|transaction|tps|qps|queries?|call|operation|op\b|event|message|http)/i;

function classifyUptime(cmp: Comparison): { ok: true; threshold: number; note?: string } | { ok: false; reason: string } {
  const { op, threshold } = cmp;
  // `up == 0` (target down) → uptime lt 1: Sentinel's uptime ratio is
  // exactly 1.0 while fully available, so "below 100%" == "any loss".
  if (op === '==' && threshold === 0) return { ok: true, threshold: 1, note: 'up == 0 mapped to uptime < 1 (any availability loss)' };
  // Availability-floor comparisons (`up < 0.9`) — below a stated floor.
  if ((op === '<' || op === '<=') && threshold > 0 && threshold <= 1) {
    return { ok: true, threshold };
  }
  // Fires-when-healthy shapes (recovery / notifier rules) — never map.
  if ((op === '>' || op === '>=' || op === '==') && threshold >= 1) {
    return { ok: false, reason: `'up ${op} ${threshold}' fires when the service is UP — likely a recovery rule, not an alert; import manually if intended` };
  }
  if (op === '!=') {
    return { ok: false, reason: `!= is not representable (Sentinel compares < or > only)` };
  }
  if (threshold > 1) {
    return { ok: false, reason: `threshold ${threshold} is outside the uptime ratio range 0–1` };
  }
  return { ok: false, reason: `'up ${op} ${threshold}' is not a recognisable availability condition` };
}

export interface MappedRule {
  name: string;
  metric: 'uptime' | 'errorRate' | 'latencyMs' | 'throughput';
  operator: 'lt' | 'gt';
  threshold: number;
  severity: 'critical' | 'warning';
  cooldownMin?: number;
  serviceLabel?: string;
  notes: string[];
}

export interface MappedRow {
  index: number;
  title?: string;
  ok: boolean;
  error?: string;
  rule?: MappedRule;
}

/** Map Grafana's `for` (Go duration: "5m", "90s", "1h30m") → cooldownMin. */
export function parseForToCooldownMin(value: unknown): { minutes?: number; note?: string } {
  if (typeof value !== 'string' || value.trim() === '') return {};
  // Strict unit tokens (h/m/s/d) — matches Go duration strings exactly
  // ("5m", "90s", "1h30m", "2m3s"); spelled-out units never appear in the
  // export and are left unparseable on purpose (→ note, default cooldown).
  const FACTORS: Record<string, number> = { h: 3600, m: 60, s: 1, d: 86400 };
  let totalSeconds = 0;
  let matched = false;
  const tokenRe = /(\d+(?:\.\d+)?)\s*(h|m|s|d)/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(value)) !== null) {
    totalSeconds += Number(m[1]) * FACTORS[m[2]];
    matched = true;
  }
  if (!matched || !Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return { note: `unparseable pending duration '${value}' — cooldown left at the Sentinel default (15 min)` };
  }
  let minutes = Math.floor(totalSeconds / 60);
  if (minutes < 1) {
    return {
      minutes: 1,
      note: `pending ${value} is under a minute — cooldown clamped to the schema minimum (1 min)`,
    };
  }
  if (minutes > 1440) {
    return {
      minutes: 1440,
      note: `pending ${value} exceeds 24 h — cooldown clamped to the schema maximum (1440 min)`,
    };
  }
  if (totalSeconds % 60 !== 0) {
    return { minutes, note: `pending ${value} truncated to whole minutes for the cooldown` };
  }
  return { minutes };
}

/** severity label → Sentinel severity; unknown values default to warning. */
export function mapSeverity(labels: unknown): { severity: 'critical' | 'warning'; note?: string } {
  const raw =
    labels !== null && typeof labels === 'object'
      ? (labels as Record<string, unknown>)['severity'] ??
        (labels as Record<string, unknown>)['priority']
      : undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { severity: 'warning', note: 'no severity label — defaulted to warning' };
  }
  const v = raw.trim().toLowerCase();
  if (v === 'critical' || v === 'crit' || v === 'critical-high' || v === 'page') {
    return { severity: 'critical' };
  }
  if (v === 'warning' || v === 'warn') return { severity: 'warning' };
  return { severity: 'warning', note: `severity label '${raw}' is not critical/warning — defaulted to warning` };
}

function mapName(rule: GrafanaRule, index: number): { name: string; notes: string[] } {
  const notes: string[] = [];
  const raw = typeof rule.title === 'string' ? rule.title.trim() : '';
  if (raw === '') {
    notes.push('rule has no title — named from its uid/position');
    const uid = typeof rule.uid === 'string' && rule.uid.trim() !== '' ? rule.uid : String(index + 1);
    return { name: `Grafana rule ${uid}`.slice(0, 80), notes };
  }
  if (raw.length > 80) {
    notes.push(`title clamped to 80 characters (Grafana titles can be longer; Sentinel names max 80)`);
    return { name: raw.slice(0, 80), notes };
  }
  return { name: raw, notes };
}

function serviceLabelOf(labels: unknown): string | undefined {
  if (labels === null || typeof labels !== 'object') return undefined;
  const rec = labels as Record<string, unknown>;
  for (const key of ['service', 'sentinel_service', 'sentinel_service_key']) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

/** Classify one normalised comparison into a Sentinel metric mapping. */
export function mapComparisonToRule(cmp: Comparison): { metric: MappedRule['metric']; operator: 'lt' | 'gt'; threshold: number; note?: string } | { unmapped: string } {
  const { lhs, op, threshold } = cmp;

  // 1. uptime — the `up` vector selector (incl. min/max/avg/sum wrappers).
  if (new RegExp(RE_UP).test(lhs)) return finish('uptime', classifyUptime(cmp));

  // 2. errorRate — error/fail/5xx families; Sentinel's errorRate is a 0–1
  //    ratio, so a threshold above 1 cannot be one (it is a per-second
  //    count — honest refusal beats a silently wrong rule).
  if (RE_ERROR.test(lhs)) {
    if (threshold < 0 || threshold > 1) {
      return { unmapped: `error-family rule with threshold ${threshold}: above 1 this is a count rate, not a 0–1 ratio — Sentinel errorRate is a ratio; write the expr as a ratio (numerator/denominator)` };
    }
    const operator = mapOperator(op);
    if (!operator) return { unmapped: `${op} on a continuous ratio is not representable (Sentinel compares < or > only)` };
    return { metric: 'errorRate', operator, threshold };
  }

  // 3. latencyMs — duration/latency families; unit conversion only when the
  //    metric name states the unit, never guessed.
  if (RE_LATENCY.test(lhs)) {
    if (threshold < 0) return { unmapped: `negative latency threshold ${threshold}` };
    const operator = mapOperator(op);
    if (!operator) return { unmapped: `${op} on a continuous duration is not representable (Sentinel compares < or > only)` };
    if (RE_SECONDS.test(lhs)) {
      return { metric: 'latencyMs', operator, threshold: threshold * 1000, note: `${threshold} s → ${(threshold * 1000).toFixed(0)} ms (metric name says seconds)` };
    }
    if (RE_MILLIS.test(lhs)) {
      return { metric: 'latencyMs', operator, threshold };
    }
    return { unmapped: 'duration rule without a unit suffix (_seconds/_ms) — Sentinel latency is milliseconds; add the unit to the metric name so the threshold is converted correctly' };
  }

  // 4. throughput — counter rates over traffic families.
  if (RE_COUNTER.test(lhs) && RE_TRAFFIC.test(lhs)) {
    if (threshold < 0) return { unmapped: `negative throughput threshold ${threshold}` };
    const operator = mapOperator(op);
    if (!operator) return { unmapped: `${op} on a continuous rate is not representable (Sentinel compares < or > only) — e.g. write rate(...) < 1 instead of rate(...) == 0` };
    return { metric: 'throughput', operator, threshold };
  }

  return { unmapped: 'expression is not recognisably one of uptime / errorRate / latencyMs / throughput — import it manually with a custom rule' };
}

function finish(
  metric: 'uptime',
  result: { ok: true; threshold: number; note?: string } | { ok: false; reason: string },
): { metric: 'uptime'; operator: 'lt'; threshold: number; note?: string } | { unmapped: string } {
  if (result.ok) return { metric, operator: 'lt', threshold: result.threshold, note: result.note };
  return { unmapped: result.reason };
}

/** Map one raw Grafana rule to a row of the import report. */
export function mapGrafanaRule(rule: GrafanaRule, index: number): MappedRow {
  const title = typeof rule.title === 'string' ? rule.title : undefined;
  const row: MappedRow = { index, title, ok: false };

  if (rule === null || typeof rule !== 'object') {
    row.error = 'entry is not a rule object';
    return row;
  }

  const raw = extractExpr(rule);
  if (!raw) {
    row.error = 'no PromQL expression found in the rule\'s query pipeline (Sentinel imports Prometheus-datasource rules)';
    return row;
  }
  const expr = normalizeExpr(raw);
  const cmp = parseComparison(expr);
  if (!cmp) {
    row.error = `expression is not a simple threshold comparison (<lhs> <op> <number>): '${expr.slice(0, 120)}'`;
    return row;
  }
  const mapped = mapComparisonToRule(cmp);
  if ('unmapped' in mapped) {
    row.error = `${mapped.unmapped} — expression: '${expr.slice(0, 120)}'`;
    return row;
  }

  const { name, notes } = mapName(rule, index);
  if (cmp.reversed) notes.push(`reversed comparison '${expr.slice(0, 60)}' read as '${cmp.lhs.slice(0, 40)} ${cmp.op} ${cmp.threshold}'`);
  if (mapped.note) notes.push(mapped.note);
  const severity = mapSeverity(rule.labels);
  if (severity.note) notes.push(severity.note);
  const cooldown = parseForToCooldownMin(rule.for);
  if (cooldown.note) notes.push(cooldown.note);

  const serviceLabel = serviceLabelOf(rule.labels);
  if (serviceLabel) notes.push(`label service='${serviceLabel}' — resolved against the Sentinel registry on commit (unknown name aborts the import)`);

  // Final gate: the payload MUST satisfy the real create-rule schema, so an
  // imported rule can never be something POST /api/rules would reject.
  const payload = {
    name,
    metric: mapped.metric,
    operator: mapped.operator,
    threshold: mapped.threshold,
    severity: severity.severity,
    ...(cooldown.minutes !== undefined ? { cooldownMin: cooldown.minutes } : {}),
  };
  const checked = createAlertRuleSchema.safeParse(payload);
  if (!checked.success) {
    row.error = `mapped payload rejected by the create-rule schema: ${checked.error.issues[0]?.message ?? 'validation failed'}`;
    return row;
  }

  row.ok = true;
  row.rule = { ...payload, serviceLabel, notes };
  return row;
}

/** Whole-file pipeline: parse + per-rule mapping (pure, zero side effects). */
export function importGrafanaRules(text: string): { ok: false; error: string } | { ok: true; rows: MappedRow[] } {
  if (text.length > IMPORT_MAX_BYTES) {
    return { ok: false, error: `export exceeds ${IMPORT_MAX_BYTES} bytes` };
  }
  const file = parseGrafanaExport(text);
  if (!file.ok) return file;
  if (file.rules.length === 0) return { ok: false, error: 'the export contains no alert rules' };
  if (file.rules.length > IMPORT_MAX_RULES) {
    return { ok: false, error: `export contains ${file.rules.length} rules — the cap is ${IMPORT_MAX_RULES} per import` };
  }
  return { ok: true, rows: file.rules.map((r, i) => mapGrafanaRule(r, i)) };
}
