// Dispatch policy — pure-function tests with an injected clock.
// Covers: retry backoff ladder, give-up→dead-letter,
// quiet-hours deferral (Tehran offset), de-dup keys, grouping keys and the
// signed-acknowledgement tokens (sign → verify → tamper → expire).

import { describe, expect, it } from 'vitest';
import {
  ackCallbackData,
  backoffTable,
  decideFailure,
  dedupKeyFor,
  groupKeyFor,
  inQuietHours,
  minutesUntilQuietEnd,
  parseAckCallbackData,
  quietAdjustedAvailableAt,
  signAckToken,
  verifyAckToken,
} from '@/server/notify/policy';

const NOW = 1_800_000_000_000; // fixed epoch — no real clock anywhere below

describe('retry backoff + dead-letter', () => {
  it('doubles 30s → 15m cap, never above', () => {
    expect(backoffTable(6)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
    expect(backoffTable(10)[8]).toBe(15 * 60_000); // capped at 15 minutes
  });

  it('retries while attempts < maxAttempts and shifts availableAt', () => {
    const d = decideFailure(1, 5, NOW);
    expect(d.status).toBe('pending');
    expect(d.availableAtMs).toBe(NOW + 30_000);
    const d3 = decideFailure(3, 5, NOW);
    expect(d3.availableAtMs).toBe(NOW + 120_000);
  });

  it('goes dead exactly at maxAttempts and never after', () => {
    expect(decideFailure(5, 5, NOW).status).toBe('dead');
    expect(decideFailure(6, 5, NOW).status).toBe('dead');
  });

  it('is robust against nonsense attempt counts', () => {
    expect(decideFailure(0, 5, NOW).availableAtMs).toBe(NOW + 30_000);
  });
});

describe('quiet hours', () => {
  it('half-open containment, wrap-safe', () => {
    expect(inQuietHours(600, { startMin: 540, endMin: 1080 })).toBe(true); // 10:00 inside 09:00-18:00
    expect(inQuietHours(539, { startMin: 540, endMin: 1080 })).toBe(false);
    expect(inQuietHours(1080, { startMin: 540, endMin: 1080 })).toBe(false); // half-open end
    // wrap: 22:00–06:00
    expect(inQuietHours(1320, { startMin: 1320, endMin: 360 })).toBe(true);
    expect(inQuietHours(120, { startMin: 1320, endMin: 360 })).toBe(true);
    expect(inQuietHours(361, { startMin: 1320, endMin: 360 })).toBe(false);
    expect(inQuietHours(300, { startMin: 600, endMin: 600 })).toBe(true); // start===end = always quiet
  });

  it('minutesUntilQuietEnd counts across midnight', () => {
    // inside 22:00-06:00 at 23:00 → 7h to 06:00
    expect(minutesUntilQuietEnd(1380, { startMin: 1320, endMin: 360 })).toBe(420);
    expect(minutesUntilQuietEnd(600, { startMin: 540, endMin: 1080 })).toBe(480);
    expect(minutesUntilQuietEnd(200, { startMin: 540, endMin: 1080 })).toBe(0); // outside → 0
  });

  it('critical pages ignore quiet hours entirely', () => {
    const w = { startMin: 0, endMin: 1440 };
    expect(quietAdjustedAvailableAt(NOW, 'critical', w, 210)).toBe(NOW);
  });

  it('warnings defer to window end (Tehran +210) and pass through outside', () => {
    // NOW → 2027-01-15T08:00:00Z → Tehran wall clock 11:30 (minute-of-day 690)
    const w = { startMin: 540, endMin: 1080 }; // 09:00–18:00
    const deferred = quietAdjustedAvailableAt(NOW, 'warning', w, 210);
    expect(deferred).toBe(NOW + 390 * 60_000); // 11:30 → 18:00 = 390 min
    const outside = quietAdjustedAvailableAt(NOW, 'warning', { startMin: 0, endMin: 300 }, 210);
    expect(outside).toBe(NOW); // Tehran 11:30 is outside 00:00–05:00
  });

  it('null window = never deferred', () => {
    expect(quietAdjustedAvailableAt(NOW, 'info', null, 210)).toBe(NOW);
  });
});

describe('de-duplication + grouping keys', () => {
  it('test and digest topics never dedup', () => {
    expect(dedupKeyFor({ topic: 'test', audience: 'technical', channelId: 'c1', nowMs: NOW })).toBeNull();
    expect(dedupKeyFor({ topic: 'digest', audience: 'executive', channelId: 'c1', nowMs: NOW })).toBeNull();
  });

  it('same stream within the bucket collapses; different channel does not', () => {
    const a = dedupKeyFor({ topic: 'detection', incidentId: 'i1', audience: 'technical', channelId: 'c1', nowMs: NOW });
    const b = dedupKeyFor({ topic: 'detection', incidentId: 'i1', audience: 'technical', channelId: 'c1', nowMs: NOW + 60_000 });
    expect(a).toBe(b); // 1 min apart, 10-min bucket
    const other = dedupKeyFor({ topic: 'detection', incidentId: 'i1', audience: 'technical', channelId: 'c2', nowMs: NOW });
    expect(other).not.toBe(a);
    const nextBucket = dedupKeyFor({ topic: 'detection', incidentId: 'i1', audience: 'technical', channelId: 'c1', nowMs: NOW + 600_000 });
    expect(nextBucket).not.toBe(a);
  });

  it('rule fires dedup per rule, not per service globally', () => {
    const r1 = dedupKeyFor({ topic: 'rule', ruleId: 'r1', audience: 'technical', channelId: 'c1', nowMs: NOW });
    const r2 = dedupKeyFor({ topic: 'rule', ruleId: 'r2', audience: 'technical', channelId: 'c1', nowMs: NOW });
    expect(r1).not.toBe(r2);
  });

  it('grouping: same channel+service merges, tests/digests/fleet never', () => {
    expect(groupKeyFor({ serviceId: 's1', channelId: 'c1', topic: 'detection' })).toBe('c1:s1');
    expect(groupKeyFor({ serviceId: null, channelId: 'c1', topic: 'detection' })).toBeNull();
    expect(groupKeyFor({ serviceId: 's1', channelId: 'c1', topic: 'test' })).toBeNull();
    expect(groupKeyFor({ serviceId: 's1', channelId: 'c1', topic: 'digest' })).toBeNull();
  });
});

describe('signed ack tokens', () => {
  const SECRET = 'unit-test-secret-0123456789abcdef';

  it('round-trips incidentId within TTL', () => {
    const token = signAckToken('incident-1', SECRET, NOW, 60_000);
    const v = verifyAckToken(token, SECRET, NOW + 30_000);
    expect(v).toEqual({ ok: true, incidentId: 'incident-1' });
  });

  it('expires honestly after the TTL', () => {
    const token = signAckToken('incident-1', SECRET, NOW, 60_000);
    expect(verifyAckToken(token, SECRET, NOW + 61_000)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects tampered payloads and wrong secrets (timing-safe compare)', () => {
    const token = signAckToken('incident-1', SECRET, NOW);
    const tampered = token.replace(/.$/, token.endsWith('a') ? 'b' : 'a');
    expect(verifyAckToken(tampered, SECRET, NOW).ok).toBe(false);
    expect(verifyAckToken(token, 'another-secret-0123456789abcdef', NOW).ok).toBe(false);
  });

  it('rejects malformed tokens without throwing', () => {
    expect(verifyAckToken('garbage', SECRET, NOW).ok).toBe(false);
    expect(verifyAckToken('a.b', SECRET, NOW).ok).toBe(false);
    expect(verifyAckToken('', SECRET, NOW).ok).toBe(false);
    const forged = Buffer.from('{"incidentId":"x","exp":99999999999999}').toString('base64url') + '.deadbeef';
    expect(verifyAckToken(forged, SECRET, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('callback data round-trips', () => {
    const token = signAckToken('incident-9', SECRET, NOW);
    expect(parseAckCallbackData(ackCallbackData(token))).toBe(token);
    expect(parseAckCallbackData('nope')).toBeNull();
    expect(parseAckCallbackData('ack:')).toBeNull();
  });
});
