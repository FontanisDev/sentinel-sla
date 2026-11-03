// Characterisation tests for analytics math — error budgets,
// trend aggregation and heatmap bucketing, run against a mocked Prisma db
// and a frozen clock so every expected number below is hand-computable.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── frozen clock ────────────────────────────────────────────────────────────
// 2026-10-08T12:07:30Z — minute not aligned to hour or heatmap bucket.
const NOW = Date.UTC(2026, 9, 8, 12, 7, 30);

const svc1 = {
  id: 'svc-1',
  key: 'payment-gateway',
  name: 'Payment Gateway',
  slaTarget: 0.999,
};
const svc2 = {
  id: 'svc-2',
  key: 'ledger-core',
  name: 'Ledger Core',
  slaTarget: 0.995,
};

const min = 60_000;

const incidents = [
  {
    id: 'i1',
    serviceId: 'svc-1',
    status: 'resolved',
    severity: 'critical',
    startedAt: new Date(NOW - 30 * min),
    resolvedAt: new Date(NOW - 20 * min), // 600 s
    mttdSec: 45.6,
    mttrSec: 600,
    mttaSec: null,
    penaltyTomans: 1_500_000,
  },
  {
    id: 'i2',
    serviceId: 'svc-1',
    status: 'resolved',
    severity: 'warning',
    startedAt: new Date(NOW - 120 * min),
    resolvedAt: new Date(NOW - 114 * min), // 360 s
    mttdSec: 12.3,
    mttrSec: 360,
    mttaSec: 8,
    penaltyTomans: 200_000,
  },
  {
    id: 'i3',
    serviceId: 'svc-2',
    status: 'ongoing',
    severity: 'critical',
    startedAt: new Date(NOW - 5 * min), // 300 s so far
    resolvedAt: null,
    mttdSec: null,
    mttrSec: null,
    mttaSec: 5,
    penaltyTomans: 0,
  },
];

const snapshots = [
  { serviceId: 'svc-1', ts: new Date(NOW - 7 * min), status: 'up' }, // bucket 12:00
  { serviceId: 'svc-1', ts: new Date(NOW - 2 * min), status: 'degraded' }, // bucket 12:00
  { serviceId: 'svc-2', ts: new Date(NOW - 4 * min), status: 'down' }, // bucket 12:00
];

vi.mock('@/lib/db', () => ({
  db: {
    service: { findMany: vi.fn(async () => [svc1, svc2]) },
    incident: { findMany: vi.fn(async () => incidents) },
    metricSnapshot: { findMany: vi.fn(async () => snapshots) },
  },
}));

vi.mock('@/server/tenants', () => ({
  serviceIdsForTenant: vi.fn(async (tenantId: string) =>
    tenantId === 't1' ? ['svc-1'] : [],
  ),
}));

import { computeAnalytics } from '@/server/analytics';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe('computeAnalytics — error budgets (characterisation)', () => {
  it('fleet-wide 24h window: consumed downtime, half-weight warnings, status thresholds', async () => {
    const result = await computeAnalytics(null, 24);

    const budgets = Object.fromEntries(
      result.errorBudgets.map((b) => [b.serviceKey, b]),
    );

    // payment-gateway: allowed = 0.001 × 24 × 3600 = 86.4 s
    // consumed = 600 (critical) + 0.5 × 360 (warning half-weight) = 780 s
    expect(budgets['payment-gateway'].allowedDowntimeSec).toBe(86.4);
    expect(budgets['payment-gateway'].consumedDowntimeSec).toBe(780);
    expect(budgets['payment-gateway'].remainingSec).toBeCloseTo(-693.6, 6);
    expect(budgets['payment-gateway'].status).toBe('exhausted');
    expect(budgets['payment-gateway'].burnRatePerHour).toBe(32.5);
    expect(budgets['payment-gateway'].projectedExhaustionSec).toBe(0);

    // ledger-core: allowed = 0.005 × 86400 = 432 s, consumed 300 s (ongoing counts to now)
    expect(budgets['ledger-core'].allowedDowntimeSec).toBe(432);
    expect(budgets['ledger-core'].consumedDowntimeSec).toBe(300);
    expect(budgets['ledger-core'].remainingSec).toBe(132);
    expect(budgets['ledger-core'].remainingRatio).toBe(0.3056); // round4(132/432)
    expect(budgets['ledger-core'].status).toBe('burning');
    // burn rate 12.5 < allowed-per-hour 18 → no projection
    expect(budgets['ledger-core'].projectedExhaustionSec).toBeNull();
  });

  it('tenant scoping narrows budgets to the tenant services', async () => {
    const result = await computeAnalytics('t1', 6);
    expect(result.errorBudgets).toHaveLength(1);
    expect(result.errorBudgets[0].serviceKey).toBe('payment-gateway');
  });
});

describe('computeAnalytics — trends (characterisation)', () => {
  it('hourly buckets: incidents grouped by start hour, averaged mttd/mttr/mtta, summed penalty', async () => {
    const result = await computeAnalytics(null, 24);

    // firstBucket = floor(now-24h / 1h) = 07 Oct 12:00; lastBucket = 08 Oct 12:00 → 25 buckets
    expect(result.trends).toHaveLength(25);

    const byTs = Object.fromEntries(result.trends.map((t) => [t.ts, t]));
    const b10 = byTs[new Date(Date.UTC(2026, 9, 8, 10, 0)).toISOString()];
    expect(b10.incidents).toBe(1);
    expect(b10.mttdSec).toBe(12.3);
    expect(b10.mttrSec).toBe(360);
    expect(b10.mttaSec).toBe(8);
    expect(b10.penaltyTomans).toBe(200_000);

    const b11 = byTs[new Date(Date.UTC(2026, 9, 8, 11, 0)).toISOString()];
    expect(b11.incidents).toBe(1);
    expect(b11.mttdSec).toBe(45.6);
    expect(b11.mttrSec).toBe(600);
    expect(b11.mttaSec).toBeNull();
    expect(b11.penaltyTomans).toBe(1_500_000);

    const b12 = byTs[new Date(Date.UTC(2026, 9, 8, 12, 0)).toISOString()];
    expect(b12.incidents).toBe(1); // ongoing incident
    expect(b12.mttdSec).toBeNull();
    expect(b12.mttrSec).toBeNull();
    expect(b12.mttaSec).toBe(5);
    expect(b12.penaltyTomans).toBe(0);
  });
});

describe('computeAnalytics — heatmap (characterisation)', () => {
  it('adapts bucket size to window and averages status scores per service', async () => {
    const result = await computeAnalytics(null, 24);

    expect(result.heatmap.bucketSizeMin).toBe(15); // >12h → 15 min buckets
    // 24 h of 15-min buckets ending at floor(now/15m) → 97 buckets inclusive
    expect(result.heatmap.buckets).toHaveLength(97);

    const last = result.heatmap.buckets[result.heatmap.buckets.length - 1];
    expect(last.services).toEqual({ 'payment-gateway': 0.75, 'ledger-core': 0 });

    const prev = result.heatmap.buckets[result.heatmap.buckets.length - 2];
    expect(prev.services).toEqual({ 'payment-gateway': null, 'ledger-core': null });
  });

  it('uses 5-minute buckets for windows up to 6h', async () => {
    const result = await computeAnalytics('t1', 6);
    expect(result.heatmap.bucketSizeMin).toBe(5);
  });
});
