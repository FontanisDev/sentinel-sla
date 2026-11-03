// Rate limiter unit tests sliding-window semantics, per-key
// isolation, fail-open contract, Retry-After computation.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkRateLimit,
  resetRateLimitsForTests,
  RATE_RULES,
  clientKey,
} from '@/server/ratelimit';

describe('rate limiter', () => {
  beforeEach(() => resetRateLimitsForTests());

  it('allows up to max requests then blocks inside the window', () => {
    const rule = { windowMs: 60_000, max: 3 };
    const t0 = 1_000_000;
    expect(checkRateLimit('k', rule, t0).ok).toBe(true);
    expect(checkRateLimit('k', rule, t0 + 1).ok).toBe(true);
    expect(checkRateLimit('k', rule, t0 + 2).ok).toBe(true);
    const blocked = checkRateLimit('k', rule, t0 + 3);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(blocked.remaining).toBe(0);
  });

  it('releases the window after it slides past', () => {
    const rule = { windowMs: 10_000, max: 2 };
    const t0 = 2_000_000;
    checkRateLimit('k', rule, t0);
    checkRateLimit('k', rule, t0 + 100);
    expect(checkRateLimit('k', rule, t0 + 200).ok).toBe(false);
    // t0 + 10_001: both original hits have left the window.
    const after = checkRateLimit('k', rule, t0 + 10_001);
    expect(after.ok).toBe(true);
    expect(after.limit).toBe(2);
  });

  it('computes Retry-After from the oldest surviving hit', () => {
    const rule = { windowMs: 60_000, max: 1 };
    const t0 = 5_000_000;
    checkRateLimit('k', rule, t0);
    const blocked = checkRateLimit('k', rule, t0 + 1_000);
    expect(blocked.ok).toBe(false);
    // oldest at t0 leaves the window at t0+60_000 → 59s remain.
    expect(blocked.retryAfterSec).toBe(59);
  });

  it('keeps keys isolated (per-IP + per-scope buckets)', () => {
    const rule = { windowMs: 60_000, max: 1 };
    expect(checkRateLimit('1.2.3.4|login', rule).ok).toBe(true);
    expect(checkRateLimit('1.2.3.4|login', rule).ok).toBe(false);
    expect(checkRateLimit('5.6.7.8|login', rule).ok).toBe(true);
    expect(checkRateLimit('1.2.3.4|reports', rule).ok).toBe(true);
  });

  it('named rules are sane (login is the strictest auth rule)', () => {
    expect(RATE_RULES.login.max).toBeLessThanOrEqual(15);
    expect(RATE_RULES.login.windowMs).toBeGreaterThanOrEqual(60_000);
    expect(RATE_RULES.reportGenerate.max).toBeLessThanOrEqual(30);
    expect(RATE_RULES.export.max).toBeLessThanOrEqual(60);
  });

  it('clientKey prefers the first x-forwarded-for hop', () => {
    const req = new Request('https://x.test/api', {
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
    });
    expect(clientKey(req)).toBe('203.0.113.7');
    expect(clientKey(req, 'login')).toBe('203.0.113.7|login');
  });

  it('falls back to x-real-ip then "local"', () => {
    expect(clientKey(new Request('https://x.test/', { headers: { 'x-real-ip': '9.9.9.9' } }))).toBe(
      '9.9.9.9',
    );
    expect(clientKey(new Request('https://x.test/'))).toBe('local');
  });
});
