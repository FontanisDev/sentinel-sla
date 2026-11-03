// Characterisation tests for the simulation engine's money math.
// Locks current behaviour of the money arithmetic.
// These tests access private methods via bracket notation deliberately —
// the contract being locked is the arithmetic, not the visibility.

import { describe, expect, it } from 'vitest';
import { SentinelEngine } from '@/server/engine';

const TICK_MS = 2500;
const TICK_SEC = TICK_MS / 1000;

type AnyRecord = Record<string, unknown>;

/** Minimal Service-like fixture (only fields the money math reads). */
function makeService(overrides: Partial<AnyRecord> = {}): AnyRecord {
  return {
    id: 'svc-1',
    key: 'payment-gateway',
    name: 'Payment Gateway',
    tps: 40,
    avgTransactionValue: 25_000, // Tomans in the demo money model
    penaltyBase: 500_000,
    penaltyPerMinute: 100_000,
    ...overrides,
  };
}

function makeRuntime(service: AnyRecord, overrides: Partial<AnyRecord> = {}): AnyRecord {
  return {
    service,
    throughput: service.tps as number,
    windowLostTx: 0,
    windowRevenueLoss: 0,
    ...overrides,
  };
}

function newEngine(): SentinelEngine {
  // Constructor only sets fields; doInit()/timers are started by getEngine().
  return new SentinelEngine();
}

/** Access a private method without `any` at the call site. */
function callPrivate<T>(obj: object, name: string, ...args: unknown[]): T {
  const fn = (obj as AnyRecord)[name] as (...a: unknown[]) => T;
  expect(typeof fn).toBe('function');
  return fn.apply(obj, args);
}

describe('engine money math — accrueLoss (characterisation)', () => {
  it('down tick accrues tps × tick seconds lost transactions at full ticket value', () => {
    const eng = newEngine();
    const svc = makeService();
    const rt = makeRuntime(svc);

    callPrivate<void>(eng, 'accrueLoss', rt, 'down');

    expect(rt.windowLostTx).toBeCloseTo(40 * TICK_SEC, 10); // 100 tx per tick
    expect(rt.windowRevenueLoss).toBeCloseTo(40 * TICK_SEC * 25_000, 6);
  });

  it('degraded tick accrues only the shortfall fraction of tps', () => {
    const eng = newEngine();
    // throughput 27 of tps 40 → ratio 0.675 → lost factor 0.325 (per code comment)
    const svc = makeService();
    const rt = makeRuntime(svc, { throughput: 27 });

    callPrivate<void>(eng, 'accrueLoss', rt, 'degraded');

    const expectedLost = (1 - 27 / 40) * 40 * TICK_SEC;
    expect(rt.windowLostTx).toBeCloseTo(expectedLost, 10);
    expect(rt.windowRevenueLoss).toBeCloseTo(expectedLost * 25_000, 6);
  });

  it('degraded throughput above tps clamps to zero loss', () => {
    const eng = newEngine();
    const svc = makeService();
    const rt = makeRuntime(svc, { throughput: 55 });

    callPrivate<void>(eng, 'accrueLoss', rt, 'degraded');

    expect(rt.windowLostTx).toBe(0);
    expect(rt.windowRevenueLoss).toBe(0);
  });

  it('zero-tps service loses nothing when degraded (ratio defined as 0)', () => {
    const eng = newEngine();
    const svc = makeService({ tps: 0 });
    const rt = makeRuntime(svc);

    callPrivate<void>(eng, 'accrueLoss', rt, 'degraded');

    // svc.tps === 0 → ratio = 0 → lost = (1-0)*0*tick = 0
    expect(rt.windowLostTx).toBe(0);
  });

  it('up status accrues nothing', () => {
    const eng = newEngine();
    const rt = makeRuntime(makeService());

    callPrivate<void>(eng, 'accrueLoss', rt, 'up');

    expect(rt.windowLostTx).toBe(0);
    expect(rt.windowRevenueLoss).toBe(0);
  });
});

describe('engine money math — computePenalty (characterisation)', () => {
  const cases: Array<{ sec: number; note: string }> = [
    { sec: 0, note: '0s bills the 1-minute minimum' },
    { sec: 30, note: 'sub-minute bills 1 minute' },
    { sec: 60, note: 'exactly 60s bills 1 minute' },
    { sec: 61, note: '61s rounds up to 2 minutes' },
    { sec: 600, note: '10 minutes exactly' },
  ];

  for (const { sec, note } of cases) {
    it(`critical incident of ${sec}s — ${note}`, () => {
      const eng = newEngine();
      const svc = makeService();
      const penalty = callPrivate<number>(eng, 'computePenalty', svc, 'critical', sec);
      const minutes = Math.max(1, Math.ceil(sec / 60));
      expect(penalty).toBe(500_000 + 100_000 * minutes);
    });
  }

  it('warning incidents bill 30% of the full penalty', () => {
    const eng = newEngine();
    const svc = makeService();
    const full = callPrivate<number>(eng, 'computePenalty', svc, 'critical', 600);
    const warn = callPrivate<number>(eng, 'computePenalty', svc, 'warning', 600);
    expect(warn).toBeCloseTo(0.3 * full, 10);
  });
});
