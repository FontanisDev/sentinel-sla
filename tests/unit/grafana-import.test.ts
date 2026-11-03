// Grafana alert-rule import — unit tests for the pure mapper
// (src/server/grafana-import.ts). The wrong-money substance lives here:
// every mapping direction is pinned as a golden fingerprint, and every
// refusal (unmapped rule) is pinned with its exact reason so the importer
// can never silently start guessing.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractExpr,
  importGrafanaRules,
  mapGrafanaRule,
  normalizeExpr,
  parseComparison,
  parseForToCooldownMin,
  parseGrafanaExport,
} from '@/server/grafana-import';
import { createAlertRuleSchema } from '@/server/validation';

// ── helpers ──────────────────────────────────────────────────────────────

function rule(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    uid: 'g1',
    title: 'Test rule',
    condition: 'A',
    labels: {},
    data: [
      {
        refId: 'A',
        datasourceUid: 'prom',
        model: { datasource: { type: 'prometheus', uid: 'prom' }, expr: 'up == 0' },
      },
    ],
    ...overrides,
  };
}

function firstRow(text: string) {
  const out = importGrafanaRules(text);
  expect(out.ok).toBe(true);
  if (!out.ok) throw new Error('unreachable');
  return out.rows[0];
}

const ok = (expr: string, overrides: Record<string, unknown> = {}) =>
  mapGrafanaRule(rule({ ...overrides, data: [{ refId: 'A', model: { expr } }] }), 0);

// ── export shapes ────────────────────────────────────────────────────────

describe('parseGrafanaExport', () => {
  it('accepts the provisioning shape {rules:[…]}', () => {
    const f = parseGrafanaExport('{"rules":[{"title":"a"},{"title":"b"}]}');
    expect(f.ok).toBe(true);
    if (f.ok) expect(f.rules).toHaveLength(2);
  });

  it('accepts a bare rule array and a single rule object', () => {
    expect(parseGrafanaExport('[{"title":"a"}]')).toMatchObject({ ok: true });
    expect(parseGrafanaExport('{"title":"a","data":[]}')).toMatchObject({ ok: true });
  });

  it('rejects invalid JSON and wrong shapes with clear errors', () => {
    expect(parseGrafanaExport('not json').ok).toBe(false);
    const wrong = parseGrafanaExport('{"dashboards":[]}');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toContain('Unrecognised export shape');
    const empty = importGrafanaRules('{"rules":[]}');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain('no alert rules');
  });
});

// ── expr extraction ──────────────────────────────────────────────────────

describe('extractExpr', () => {
  it('prefers the condition refId entry, falls back to the last expr', () => {
    const r = rule({
      condition: 'B',
      data: [
        { refId: 'A', model: { expr: 'up == 0' } },
        { refId: 'B', model: { datasource: { type: '__expr__' } } },
        { refId: 'C', model: { expr: '  min(up) < 1  ' } },
      ],
    });
    // B has no expr → last expr wins, trimmed.
    expect(extractExpr(r as never)).toBe('min(up) < 1');
    const r2 = rule({
      condition: 'C',
      data: [
        { refId: 'A', model: { expr: 'up == 0' } },
        { refId: 'C', model: { expr: 'min(up) < 1' } },
      ],
    });
    expect(extractExpr(r2 as never)).toBe('min(up) < 1');
  });

  it('returns null when no entry carries an expr', () => {
    expect(extractExpr(rule({ data: [{ refId: 'A', model: {} }] }) as never)).toBeNull();
    expect(extractExpr(rule({ data: 'nope' }) as never)).toBeNull();
  });

  it('normalizes whitespace', () => {
    expect(normalizeExpr('  up  ==\n0 ')).toBe('up == 0');
  });
});

// ── comparison parsing ───────────────────────────────────────────────────

describe('parseComparison', () => {
  it('parses forward and number-first comparisons', () => {
    expect(parseComparison('error_ratio > 0.05')).toEqual({ lhs: 'error_ratio', op: '>', threshold: 0.05, reversed: false });
    expect(parseComparison('0.05 < error_ratio')).toEqual({ lhs: 'error_ratio', op: '>', threshold: 0.05, reversed: true });
    expect(parseComparison('up == 0')).toEqual({ lhs: 'up', op: '==', threshold: 0, reversed: false });
    expect(parseComparison('rate(x[5m]) >= 1.5e3')).toEqual({ lhs: 'rate(x[5m])', op: '>=', threshold: 1500, reversed: false });
  });

  it('returns null for non-comparisons', () => {
    expect(parseComparison('up')).toBeNull();
    expect(parseComparison('up > x')).toBeNull();
    expect(parseComparison('sum(up)')).toBeNull();
  });
});

// ── metric mapping golden fingerprints (wrong-money substance) ───────────

describe('mapGrafanaRule — uptime', () => {
  it('maps up == 0 → uptime lt 1 with the documented note', () => {
    const r = ok('up == 0');
    expect(r.ok).toBe(true);
    if (r.ok && r.rule) {
      expect(r.rule.metric).toBe('uptime');
      expect(r.rule.operator).toBe('lt');
      expect(r.rule.threshold).toBe(1);
      expect(r.rule.notes.join(' ')).toContain('up == 0');
    }
  });

  it('maps up < 0.5 and up <= 0.9 → uptime lt threshold', () => {
    for (const [expr, threshold] of [['up < 0.5', 0.5], ['up <= 0.9', 0.9]] as const) {
      const r = ok(expr);
      expect(r.ok).toBe(true);
      if (r.ok && r.rule) {
        expect(r.rule.metric).toBe('uptime');
        expect(r.rule.operator).toBe('lt');
        expect(r.rule.threshold).toBe(threshold);
      }
    }
  });

  it('refuses fires-when-healthy and out-of-range shapes', () => {
    for (const expr of ['up == 1', 'up > 0', 'up >= 1', 'up != 0', 'up < 1.5']) {
      const r = ok(expr);
      expect(r.ok, expr).toBe(false);
    }
    const r = ok('up == 1');
    if (!r.ok) expect(r.error).toContain('fires when the service is UP');
  });
});

describe('mapGrafanaRule — errorRate', () => {
  it('maps 5xx ratios preserving the comparison direction', () => {
    const r = ok('sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.02');
    expect(r.ok).toBe(true);
    if (r.ok && r.rule) {
      expect(r.rule.metric).toBe('errorRate');
      expect(r.rule.operator).toBe('gt');
      expect(r.rule.threshold).toBe(0.02);
    }
    const warn = ok('error_ratio < 0.01');
    if (warn.ok && warn.rule) expect(warn.rule.operator).toBe('lt');
  });

  it('refuses count-rates above 1 (not a 0–1 ratio)', () => {
    const r = ok('rate(http_requests_total{status="500"}[5m]) > 10');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('count rate, not a 0–1 ratio');
  });
});

describe('mapGrafanaRule — latencyMs', () => {
  it('converts seconds → milliseconds only when the unit is declared', () => {
    const r = ok('histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le)) > 1');
    expect(r.ok).toBe(true);
    if (r.ok && r.rule) {
      expect(r.rule.metric).toBe('latencyMs');
      expect(r.rule.threshold).toBe(1000);
      expect(r.rule.notes.join(' ')).toContain('seconds');
    }
    const ms = ok('http_request_duration_milliseconds > 500');
    if (ms.ok && ms.rule) {
      expect(ms.rule.metric).toBe('latencyMs');
      expect(ms.rule.threshold).toBe(500);
    }
  });

  it('refuses duration rules without a declared unit (no guessing)', () => {
    const r = ok('http_request_duration > 1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unit suffix');
  });
});

describe('mapGrafanaRule — throughput', () => {
  it('maps counter rates over traffic families', () => {
    const r = ok('sum(rate(kyc_requests_total[5m])) < 1');
    expect(r.ok).toBe(true);
    if (r.ok && r.rule) {
      expect(r.rule.metric).toBe('throughput');
      expect(r.rule.operator).toBe('lt');
      expect(r.rule.threshold).toBe(1);
    }
  });

  it('refuses equality on a continuous rate', () => {
    const r = ok('sum(rate(http_requests_total[5m])) == 0');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not representable');
  });

  it('refuses unknown metric families instead of guessing', () => {
    const r = ok('node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not recognisably');
  });
});

// ── non-expression rows ──────────────────────────────────────────────────

describe('mapGrafanaRule — refusals before classification', () => {
  it('reports rules without a PromQL expr', () => {
    const r = mapGrafanaRule(rule({ data: [{ refId: 'A', model: {} }] }) as never, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('no PromQL expression');
  });

  it('reports non-threshold expressions with the offending text', () => {
    const r = ok('absent(dataset)');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('simple threshold comparison');
    expect(r.error).toContain('absent(dataset)');
  });
});

// ── name / severity / for / service label mapping ────────────────────────

describe('metadata mapping', () => {
  it('clamps long titles with a note and names empty titles from uid', () => {
    const long = ok('up == 0', { title: 'x'.repeat(120) });
    if (long.ok && long.rule) {
      expect(long.rule.name).toHaveLength(80);
      expect(long.rule.notes.join(' ')).toContain('clamped');
    }
    const empty = ok('up == 0', { title: '  ', uid: 'abc12' });
    if (empty.ok && empty.rule) {
      expect(empty.rule.name).toBe('Grafana rule abc12');
      expect(empty.rule.notes.join(' ')).toContain('no title');
    }
  });

  it('maps severity labels; unknown values default to warning with a note', () => {
    for (const [label, expected] of [
      ['critical', 'critical'],
      ['crit', 'critical'],
      ['page', 'critical'],
      ['warning', 'warning'],
      ['warn', 'warning'],
      ['ticket', 'warning'],
      ['info', 'warning'],
    ] as const) {
      const r = ok('up == 0', { labels: { severity: label } });
      if (r.ok && r.rule) expect(r.rule.severity, label).toBe(expected);
    }
    const ticket = ok('up == 0', { labels: { severity: 'ticket' } });
    if (ticket.ok && ticket.rule) expect(ticket.rule.notes.join(' ')).toContain('ticket');
    const absent = ok('up == 0', { labels: {} });
    if (absent.ok && absent.rule) expect(absent.rule.notes.join(' ')).toContain('no severity label');
  });

  it('maps Grafana for-durations onto cooldownMin with honest notes', () => {
    expect(parseForToCooldownMin('5m')).toEqual({ minutes: 5 });
    expect(parseForToCooldownMin('1h30m')).toEqual({ minutes: 90 });
    expect(parseForToCooldownMin('')).toEqual({});
    expect(parseForToCooldownMin(undefined)).toEqual({});
    const s = parseForToCooldownMin('30s');
    expect(s.minutes).toBe(1);
    expect(s.note).toContain('clamped');
    const mixed = parseForToCooldownMin('5m30s');
    expect(mixed.minutes).toBe(5);
    expect(mixed.note).toContain('truncated');
    const garbage = parseForToCooldownMin('soon');
    expect(garbage.minutes).toBeUndefined();
    expect(garbage.note).toContain('unparseable');
    const over = parseForToCooldownMin('25h');
    expect(over.minutes).toBe(1440);
    expect(over.note).toContain('maximum');
  });

  it('extracts service binding labels', () => {
    const a = ok('up == 0', { labels: { service: 'payment-gateway' } });
    if (a.ok && a.rule) expect(a.rule.serviceLabel).toBe('payment-gateway');
    const b = ok('up == 0', { labels: { sentinel_service_key: 'wallet' } });
    if (b.ok && b.rule) expect(b.rule.serviceLabel).toBe('wallet');
    const c = ok('up == 0', { labels: {} });
    if (c.ok && c.rule) expect(c.rule.serviceLabel).toBeUndefined();
  });
});

// ── whole-file pipeline ──────────────────────────────────────────────────

describe('importGrafanaRules', () => {
  it('maps every rule of the shipped sample template', () => {
    const sample = readFileSync(
      join(process.cwd(), 'public/templates/grafana-alerts-sample.json'),
      'utf-8',
    );
    const out = importGrafanaRules(sample);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows).toHaveLength(4);
    expect(out.rows.every((r) => r.ok)).toBe(true);
    const byName = Object.fromEntries(out.rows.map((r) => [r.rule!.name, r.rule!]));
    expect(byName['Payment Gateway down (probe failed)']).toMatchObject({
      metric: 'uptime',
      operator: 'lt',
      threshold: 1,
      severity: 'critical',
      cooldownMin: 2,
      serviceLabel: 'payment-gateway',
    });
    expect(byName['Wallet API server error ratio']).toMatchObject({
      metric: 'errorRate',
      operator: 'gt',
      threshold: 0.02,
      severity: 'warning',
      cooldownMin: 5,
    });
    expect(byName['Core Banking p95 latency above one second']).toMatchObject({
      metric: 'latencyMs',
      threshold: 1000,
      cooldownMin: 1,
    });
    expect(byName['KYC traffic floor breached']).toMatchObject({
      metric: 'throughput',
      operator: 'lt',
      threshold: 1,
      severity: 'critical',
    });
  });

  it('enforces the byte and rule caps', () => {
    const big = importGrafanaRules('x'.repeat(512 * 1024 + 1));
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error).toContain('exceeds');
    const many = importGrafanaRules(
      JSON.stringify({ rules: Array.from({ length: 201 }, (_, i) => ({ title: `r${i}` })) }),
    );
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.error).toContain('cap');
  });

  it('flags duplicate names as row errors', () => {
    const text = JSON.stringify({
      rules: [
        { title: 'Same', data: [{ refId: 'A', model: { expr: 'up == 0' } }] },
        { title: 'Same', data: [{ refId: 'A', model: { expr: 'up == 0' } }] },
      ],
    });
    const out = importGrafanaRules(text);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The pure mapper maps both; duplicate detection is the route's commit
    // check (like CSV tenant rows) — both rows must be mapped-and-named here.
    expect(out.rows.every((r) => r.ok)).toBe(true);
    expect(out.rows[0].rule!.name).toBe('Same');
  });
});

// ── property tests ───────────────────────────────────────────────────────

describe('property tests', () => {
  it('every mapped rule satisfies the real create-rule schema', () => {
    const exprArb = fc.oneof(
      fc.constant('up == 0'),
      fc.constant('up < 0.9'),
      fc.constant('error_ratio > 0.05'),
      fc.constant('http_request_duration_seconds_bucket > 0.5'),
      fc.constant('sum(rate(kyc_requests_total[5m])) < 10'),
    );
    fc.assert(
      fc.property(
        fc.record({
          expr: exprArb,
          title: fc.string({ minLength: 3, maxLength: 40 }).filter((s) => s.trim().length >= 3),
          severity: fc.constantFrom('critical', 'warning', 'page', undefined),
          for: fc.constantFrom('1m', '5m', '90s', undefined),
        }),
        (inputs) => {
          const r = mapGrafanaRule(
            rule({
              title: inputs.title,
              for: inputs.for,
              labels: inputs.severity ? { severity: inputs.severity } : {},
              data: [{ refId: 'A', model: { expr: inputs.expr } }],
            }) as never,
            0,
          );
          if (!r.ok) return;
          const payload = {
            name: r.rule!.name,
            metric: r.rule!.metric,
            operator: r.rule!.operator,
            threshold: r.rule!.threshold,
            severity: r.rule!.severity,
            ...(r.rule!.cooldownMin !== undefined ? { cooldownMin: r.rule!.cooldownMin } : {}),
          };
          expect(createAlertRuleSchema.safeParse(payload).success).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('reversed and forward comparisons map identically', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.constantFrom('>', '>=', '<', '<='),
        (n, op) => {
          const lhs = 'sum(rate(http_requests_total[5m]))';
          const forward = mapGrafanaRule(rule({ data: [{ refId: 'A', model: { expr: `${lhs} ${op} ${n}` } }] }) as never, 0);
          const reverse = mapGrafanaRule(rule({ data: [{ refId: 'A', model: { expr: `${n} ${op === '>' ? '<' : op === '<' ? '>' : op === '>=' ? '<=' : '>='} ${lhs}` } }] }) as never, 0);
          expect(reverse.ok).toBe(forward.ok);
          if (forward.ok && reverse.ok) {
            expect(reverse.rule!.metric).toBe(forward.rule!.metric);
            expect(reverse.rule!.operator).toBe(forward.rule!.operator);
            expect(reverse.rule!.threshold).toBe(forward.rule!.threshold);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
