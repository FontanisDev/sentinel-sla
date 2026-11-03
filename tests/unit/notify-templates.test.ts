// Notification templates — pure rendering tests.
// Locks: audience→language mapping (technical=EN, executive=FA), variable
// interpolation, money/duration formatting per locale, ack-link embedding,
// control-char stripping, and the preview catalog integrity.

import { describe, expect, it } from 'vitest';
import {
  escalationWhoEn,
  escalationWhoFa,
  renderNotification,
  sampleVars,
  TEMPLATE_CATALOG,
  type NotifyVars,
} from '@/server/notify/templates';

const BASE: NotifyVars = {
  serviceName: 'Payment Gateway',
  serviceKey: 'payment-gateway',
  endpoint: 'https://pay.example.ir/health',
  probeLabel: 'sentinel/blackbox',
  startedAt: new Date('2026-10-08T09:30:00Z').toISOString(),
  tps: 10,
  avgTransactionValue: 250_000,
  penaltyBase: 5_000_000,
  penaltyPerMinute: 1_000_000,
};

describe('technical (EN) templates', () => {
  it('critical detection carries the honest per-minute arithmetic', () => {
    const { title, body } = renderNotification('detection', 'critical', 'technical', BASE);
    expect(title).toBe('[CRITICAL] Payment Gateway is DOWN');
    expect(body).toContain('600 tx'); // 10 tps × 60 s
    expect(body).toContain('150,000,000 Tomans'); // 600 tx × 250 000 ticket
    expect(body).toContain('6,000,000 Tomans'); // penalty exposure = base + perMin
    expect(body).toContain('https://pay.example.ir/health');
  });

  it('warning detection states the 32.5% partial-loss model and 30% weight', () => {
    const { title, body } = renderNotification('detection', 'warning', 'technical', {
      ...BASE,
      latencyMs: 1840,
      errorRate: '12.4',
    });
    expect(title).toBe('[WARNING] Payment Gateway is DEGRADED');
    expect(body).toContain('32.5%');
    expect(body).toContain('30%');
    expect(body).toContain('1840ms');
    expect(body).toContain('12.4%');
  });

  it('recovery reports impact with formula-consistent numbers', () => {
    const { title, body } = renderNotification('recovery', 'info', 'technical', {
      ...BASE,
      mttdSec: 7.7,
      mttrSec: 95.2,
      lostTransactions: 997,
      revenueLossTomans: 75_000_000,
      penaltyTomans: 29_700_000,
    });
    expect(title).toContain('[RECOVERY]');
    expect(body).toContain('1m 35s'); // 95.2 s
    expect(body).toContain('MTTD 7.7s');
    expect(body).toContain('997 transactions');
    expect(body).toContain('75,000,000 Tomans');
    expect(body).toContain('29,700,000 Tomans');
  });

  it('escalation names who was paged and the policy window', () => {
    const { title, body } = renderNotification('escalation', 'critical', 'technical', {
      ...BASE,
      unackedSec: 180,
      timeoutMin: 5,
      who: 'Sara Karimi (@sara_oncall)',
    });
    expect(title).toContain('[ESCALATION]');
    expect(title).toContain('3m');
    expect(body).toContain('5-minute policy window');
    expect(body).toContain('Sara Karimi (@sara_oncall)');
  });

  it('embeds the ack link when provided, dashboard path when not', () => {
    const withLink = renderNotification('detection', 'critical', 'technical', {
      ...BASE,
      ackUrl: 'https://s.example.ir/ack?token=abc',
    });
    expect(withLink.body).toContain('Acknowledge: https://s.example.ir/ack?token=abc');
    const without = renderNotification('detection', 'critical', 'technical', { ...BASE, ackUrl: undefined });
    expect(without.body).toContain('Acknowledge in the Sentinel dashboard');
  });
});

describe('executive (FA) templates', () => {
  it('critical detection is formal Persian with Persian digits and Tomans', () => {
    const { title, body } = renderNotification('detection', 'critical', 'executive', BASE);
    expect(title).toContain('اختلال بحرانی');
    expect(title).toContain('Payment Gateway');
    // 10 tps × 60 s = 600 → ۶۰۰ ; 600 × 250 000 = 150 000 000 تومان
    expect(body).toContain('۶۰۰');
    expect(body).toContain('۱۵۰٬۰۰۰٬۰۰۰ تومان');
    expect(body).toContain('در هر دقیقه');
  });

  it('recovery states final loss and contractual penalty in Persian', () => {
    const { body } = renderNotification('recovery', 'info', 'executive', {
      ...BASE,
      mttrSec: 95.2,
      lostTransactions: 997,
      revenueLossTomans: 75_000_000,
      penaltyTomans: 29_700_000,
    });
    expect(body).toContain('۹۹۷');
    expect(body).toContain('۷۵٬۰۰۰٬۰۰۰ تومان');
    expect(body).toContain('۲۹٬۷۰۰٬۰۰۰ تومان');
  });

  it(' Jalali clock appears (Tehran tz) for executive messages', () => {
    const { body } = renderNotification('detection', 'critical', 'executive', BASE);
    // 2026-10-08 09:30Z = 13:00 Tehran = ۱۴۰۵/۰۷/۱۶ — the month name مهر is stable
    expect(body).toContain('مهر');
  });

  it('warning keeps the 30% contractual weight honest', () => {
    const { body } = renderNotification('detection', 'warning', 'executive', {
      ...BASE,
      latencyMs: 1840,
      errorRate: '12.4',
    });
    expect(body).toContain('وزن ۳۰ درصد');
    expect(body).toContain('۱٬۸۰۰٬۰۰۰ تومان'); // 0.3 × (5 000 000 + 1 000 000)
  });
});

describe('helpers + catalog', () => {
  it('escalation who-lines degrade honestly when nobody is on duty', () => {
    expect(escalationWhoEn('Sara', '@sara', true)).toContain('NOBODY IS ON DUTY');
    expect(escalationWhoEn('Sara', '@sara', false)).toBe('Sara (@sara)');
    expect(escalationWhoFa('سارا', '@sara', true)).toContain('در دسترس نیست');
  });

  it('unknown placeholders never leak into the rendered page', () => {
    const { body } = renderNotification('detection', 'critical', 'technical', { ...BASE, nonexistentVar: undefined });
    expect(body).not.toMatch(/\{[a-zA-Z_]+\}/);
  });

  it('control characters are stripped from titles and bodies', () => {
    const { title } = renderNotification('detection', 'critical', 'technical', {
      ...BASE,
      serviceName: 'Bad\x00\x08Name',
    });
    expect(title).not.toMatch(/[\u0000-\u0008]/);
    expect(title).toContain('BadName');
  });

  it('every catalog entry renders in both audiences with sample vars', () => {
    expect(TEMPLATE_CATALOG.length).toBeGreaterThanOrEqual(7);
    for (const { topic, severity } of TEMPLATE_CATALOG) {
      const vars = sampleVars(topic, severity);
      for (const audience of ['technical', 'executive'] as const) {
        const out = renderNotification(topic, severity, audience, vars);
        expect(out.title.length, `${topic}/${severity}/${audience} title`).toBeGreaterThan(0);
        expect(out.body.length, `${topic}/${severity}/${audience} body`).toBeGreaterThan(10);
      }
    }
  });

  it('digest sample vars swap in digest-specific data', () => {
    const vars = sampleVars('digest', 'info');
    expect(vars.worstServiceFa).toBe('درگاه پرداخت');
    const { body } = renderNotification('digest', 'info', 'executive', vars);
    expect(body).toContain('۲۱۰٬۰۰۰٬۰۰۰ تومان');
  });
});
