// Zabbix trigger import — unit tests for the pure mapper
// (src/server/zabbix-import.ts). Same discipline as the Grafana tests:
// golden fingerprints for every mapping direction, exact refusal reasons,
// and property tests against the real create-rule schema.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  importZabbixTriggers,
  mapPriority,
  mapZabbixTrigger,
  parseZabbixExpression,
  parseZabbixExport,
} from '@/server/zabbix-import';
import { createAlertRuleSchema } from '@/server/validation';

function trigger(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    triggerid: '15100',
    description: 'Test trigger',
    expression: 'last(/payment-gateway/agent.ping)=0',
    priority: '4',
    status: '0',
    hosts: [{ host: 'payment-gateway', name: 'Payment Gateway' }],
    ...overrides,
  };
}

const ok = (expression: string, overrides: Record<string, unknown> = {}) =>
  mapZabbixTrigger(trigger({ ...overrides, expression }), 0);

// ── export shapes ────────────────────────────────────────────────────────

describe('parseZabbixExport', () => {
  it('accepts a bare array (trigger.get result) and wrapper objects', () => {
    expect(parseZabbixExport('[{"description":"a"}]')).toMatchObject({ ok: true });
    expect(parseZabbixExport('{"triggers":[{"description":"a"}]}')).toMatchObject({ ok: true });
    expect(parseZabbixExport('{"result":[{"description":"a"}]}')).toMatchObject({ ok: true });
  });

  it('rejects invalid JSON and wrong shapes with clear errors', () => {
    expect(parseZabbixExport('not json').ok).toBe(false);
    const wrong = parseZabbixExport('{"hosts":[]}');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toContain('Unrecognised export shape');
    const empty = importZabbixTriggers('[]');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain('no triggers');
  });
});

// ── expression parsing (both syntaxes) ───────────────────────────────────

describe('parseZabbixExpression', () => {
  it('parses modern 5.4+ syntax with item parameters', () => {
    expect(parseZabbixExpression('last(/host/agent.ping)=0')).toEqual({
      host: 'host', key: 'agent.ping', func: 'last', op: '=', value: 0,
    });
    expect(parseZabbixExpression('avg(/host/system.cpu.util[,idle])<10')).toEqual({
      host: 'host', key: 'system.cpu.util[,idle]', func: 'avg', op: '<', value: 10,
    });
    expect(parseZabbixExpression('last(/h/net.tcp.service.perf[tcp,,443])>0.5')).toEqual({
      host: 'h', key: 'net.tcp.service.perf[tcp,,443]', func: 'last', op: '>', value: 0.5,
    });
  });

  it('parses legacy ≤5.2 syntax', () => {
    expect(parseZabbixExpression('{host:agent.ping.last(0)}=0')).toEqual({
      host: 'host', key: 'agent.ping', func: 'last', op: '=', value: 0,
    });
    expect(parseZabbixExpression('{host:txn_requests_per_sec.avg(60)}<10')).toEqual({
      host: 'host', key: 'txn_requests_per_sec', func: 'avg', op: '<', value: 10,
    });
  });

  it('returns null for multi-term or macro expressions', () => {
    expect(parseZabbixExpression('last(/h/a)>1 or last(/h/b)>2')).toBeNull();
    expect(parseZabbixExpression('{$MACRO}>5')).toBeNull();
    expect(parseZabbixExpression('nodata(/h/agent.ping,3m)=1')).toMatchObject({ func: 'nodata' });
  });
});

// ── metric mapping golden fingerprints ───────────────────────────────────

describe('mapZabbixTrigger — availability (uptime)', () => {
  it('maps DOWN = 0 → uptime lt 1 with the documented note', () => {
    const r = ok('last(/payment-gateway/agent.ping)=0');
    expect(r.ok).toBe(true);
    if (r.ok && r.rule) {
      expect(r.rule.metric).toBe('uptime');
      expect(r.rule.operator).toBe('lt');
      expect(r.rule.threshold).toBe(1);
      expect(r.rule.notes.join(' ')).toContain('DOWN');
    }
  });

  it('maps nodata = 1 (agent stopped reporting) → uptime lt 1', () => {
    const r = ok('nodata(/payment-gateway/agent.ping,3m)=1');
    expect(r.ok).toBe(true);
    if (r.ok && r.rule) {
      expect(r.rule.metric).toBe('uptime');
      expect(r.rule.threshold).toBe(1);
      expect(r.rule.notes.join(' ')).toContain('nodata');
    }
  });

  it('maps web-scenario failures > 0 → uptime lt 1', () => {
    const r = ok('last(/wallet/web.test.fail[wallet-checkout])>0');
    expect(r.ok).toBe(true);
    if (r.ok && r.rule) {
      expect(r.rule.metric).toBe('uptime');
      expect(r.rule.threshold).toBe(1);
      expect(r.rule.notes.join(' ')).toContain('web scenario');
    }
  });

  it('maps packet loss > percent → uptime lt 1', () => {
    const r = ok('last(/payment-gateway/icmppingloss[,200,50])>20');
    expect(r.ok).toBe(true);
    if (r.ok && r.rule) {
      expect(r.rule.metric).toBe('uptime');
      expect(r.rule.threshold).toBe(1);
    }
  });

  it('refuses fires-when-healthy availability shapes', () => {
    for (const expr of ['last(/payment-gateway/agent.ping)=1', 'last(/payment-gateway/net.tcp.service[tcp,,443])=1']) {
      const r = ok(expr);
      expect(r.ok, expr).toBe(false);
      if (!r.ok) expect(r.error).toContain('fires when the service is UP');
    }
  });
});

describe('mapZabbixTrigger — latencyMs', () => {
  it('converts service.perf seconds → milliseconds (declared units)', () => {
    const r = ok('last(/payment-gateway/net.tcp.service.perf[tcp,,8443])>1');
    expect(r.ok).toBe(true);
    if (r.ok && r.rule) {
      expect(r.rule.metric).toBe('latencyMs');
      expect(r.rule.operator).toBe('gt');
      expect(r.rule.threshold).toBe(1000);
      expect(r.rule.notes.join(' ')).toContain('seconds');
    }
  });

  it('refuses equality on a continuous perf item', () => {
    const r = ok('last(/payment-gateway/web.page.perf[host,/])=0.5');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not representable');
  });
});

describe('mapZabbixTrigger — throughput', () => {
  it('maps request/transaction item rates in both syntaxes', () => {
    const modern = ok('avg(/core-banking/txn_requests_per_sec[1m])<10');
    expect(modern.ok).toBe(true);
    if (modern.ok && modern.rule) {
      expect(modern.rule.metric).toBe('throughput');
      expect(modern.rule.operator).toBe('lt');
      expect(modern.rule.threshold).toBe(10);
    }
    const legacy = ok('{core-banking:txn_requests_per_sec.avg(60)}<10');
    expect(legacy.ok).toBe(true);
    if (legacy.ok && legacy.rule) expect(legacy.rule.threshold).toBe(10);
  });

  it('refuses equality on a continuous rate', () => {
    const r = ok('last(/app/nginx_requests)=0');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not representable');
  });
});

describe('mapZabbixTrigger — honest refusals', () => {
  it('refuses host-resource triggers with the services-not-hosts reason', () => {
    for (const expr of [
      'last(/host/system.cpu.util[,idle])<10',
      'last(/host/vfs.fs.size[/,pfree])<5',
      'last(/host/vm.memory.size[pavailable])>90',
      'last(/host/net.if.in[eth0])>1000000',
    ]) {
      const r = ok(expr);
      expect(r.ok, expr).toBe(false);
      if (!r.ok) expect(r.error).toContain('host-resource trigger');
    }
  });

  it('refuses disabled triggers without mapping them', () => {
    const r = ok('last(/payment-gateway/agent.ping)=0', { status: '1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('disabled in Zabbix');
  });

  it('refuses multi-term and macro-only expressions', () => {
    const multi = ok('last(/h/agent.ping)=0 or last(/h/agent.ping.nodata(3m))=1');
    expect(multi.ok).toBe(false);
    if (!multi.ok) expect(multi.error).toContain('single-term');
    const macro = ok('{$CPU_THRESHOLD}>90');
    expect(macro.ok).toBe(false);
  });
});

// ── metadata mapping ─────────────────────────────────────────────────────

describe('metadata mapping', () => {
  it('maps the Zabbix severity scale with transparent notes', () => {
    expect(mapPriority('5')).toMatchObject({ severity: 'critical' });
    expect(mapPriority('4')).toMatchObject({ severity: 'critical' });
    expect(mapPriority('3')).toMatchObject({ severity: 'warning' });
    expect(mapPriority('0')).toMatchObject({ severity: 'warning' });
    const p5 = mapPriority('5');
    expect(p5.note).toContain('Disaster');
  });

  it('clamps long descriptions and names empty ones from triggerid', () => {
    const long = ok('last(/payment-gateway/agent.ping)=0', { description: 'x'.repeat(120) });
    if (long.ok && long.rule) {
      expect(long.rule.name).toHaveLength(80);
      expect(long.rule.notes.join(' ')).toContain('clamped');
    }
    const empty = ok('last(/payment-gateway/agent.ping)=0', { description: '  ', triggerid: '999' });
    if (empty.ok && empty.rule) {
      expect(empty.rule.name).toBe('Zabbix trigger 999');
    }
  });

  it('binds hosts[0] as the service label; missing host stays a fleet rule', () => {
    const bound = ok('last(/payment-gateway/agent.ping)=0');
    if (bound.ok && bound.rule) expect(bound.rule.serviceLabel).toBe('payment-gateway');
    const fleet = ok('last(/payment-gateway/agent.ping)=0', { hosts: [] });
    if (fleet.ok && fleet.rule) expect(fleet.rule.serviceLabel).toBeUndefined();
    const multi = ok('last(/payment-gateway/agent.ping)=0', {
      hosts: [{ host: 'payment-gateway' }, { host: 'wallet' }],
    });
    if (multi.ok && multi.rule) expect(multi.rule.notes.join(' ')).toContain('first');
  });
});

// ── whole-file pipeline ──────────────────────────────────────────────────

describe('importZabbixTriggers', () => {
  it('maps every trigger of the shipped sample (golden)', () => {
    const sample = readFileSync(
      join(process.cwd(), 'public/templates/zabbix-triggers-sample.json'),
      'utf-8',
    );
    const out = importZabbixTriggers(sample);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows).toHaveLength(4);
    expect(out.rows.every((r) => r.ok)).toBe(true);
    const byName = Object.fromEntries(out.rows.map((r) => [r.rule!.name, r.rule!]));
    expect(byName['Payment gateway agent unreachable']).toMatchObject({
      metric: 'uptime', operator: 'lt', threshold: 1, severity: 'critical', serviceLabel: 'payment-gateway',
    });
    expect(byName['Payment gateway TCP service responds slower than 1s']).toMatchObject({
      metric: 'latencyMs', threshold: 1000, severity: 'critical',
    });
    expect(byName['Wallet checkout web scenario has failing steps']).toMatchObject({
      metric: 'uptime', threshold: 1, severity: 'warning', serviceLabel: 'wallet',
    });
    expect(byName['Core banking transaction rate below floor']).toMatchObject({
      metric: 'throughput', operator: 'lt', threshold: 10, severity: 'critical', serviceLabel: 'core-banking',
    });
  });

  it('enforces the byte and trigger caps', () => {
    expect(importZabbixTriggers('x'.repeat(512 * 1024 + 1)).ok).toBe(false);
    const many = importZabbixTriggers(
      JSON.stringify(Array.from({ length: 201 }, (_, i) => ({ description: `t${i}`, expression: 'last(/h/agent.ping)=0' }))),
    );
    expect(many.ok).toBe(false);
    if (!many.ok) expect(many.error).toContain('cap');
  });
});

// ── property tests ───────────────────────────────────────────────────────

describe('property tests', () => {
  it('every mapped trigger satisfies the real create-rule schema', () => {
    fc.assert(
      fc.property(
        fc.record({
          expr: fc.constantFrom(
            'last(/payment-gateway/agent.ping)=0',
            'last(/payment-gateway/net.tcp.service.perf[tcp,,8443])>0.8',
            'last(/wallet/web.test.fail[checkout])>0',
            'avg(/core-banking/txn_requests_per_sec[1m])<10',
          ),
          priority: fc.constantFrom('0', '1', '2', '3', '4', '5'),
        }),
        (inputs) => {
          const r = mapZabbixTrigger(
            trigger({ expression: inputs.expr, priority: inputs.priority }) as never,
            0,
          );
          if (!r.ok) return;
          const payload = {
            name: r.rule!.name,
            metric: r.rule!.metric,
            operator: r.rule!.operator,
            threshold: r.rule!.threshold,
            severity: r.rule!.severity,
          };
          expect(createAlertRuleSchema.safeParse(payload).success).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});
