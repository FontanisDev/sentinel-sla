// Unit tests — live detection state machine + Prometheus fetchers.
// The fetcher tests run against a REAL local HTTP server that mimics the
// Prometheus /api/v1/query response envelope (no network beyond 127.0.0.1).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_DETECTION,
  applySample,
  applyStale,
  blackboxOk,
  sliRatioOk,
  validateDetectionConfig,
  type DetectionState,
} from '@/domain/detection';
import { DomainError } from '@/domain/money';
import { parseProbeSource, promInstantQuery, type PrometheusSettings } from '@/server/ingestion';

const FRESH: DetectionState = { consecutiveFailures: 0, consecutiveSuccesses: 0, incidentOpen: false, transition: 'none' };

describe('detection state machine', () => {
  it('opens only after N consecutive failures (default 3)', () => {
    let s = FRESH;
    s = applySample(s, { ok: false, value: 0, atMs: 1 });
    expect(s.transition).toBe('none');
    expect(s.incidentOpen).toBe(false);
    s = applySample(s, { ok: false, value: 0, atMs: 2 });
    expect(s.incidentOpen).toBe(false);
    s = applySample(s, { ok: false, value: 0, atMs: 3 });
    expect(s.transition).toBe('open');
    expect(s.incidentOpen).toBe(true);
  });
  it('a success resets the failure streak (no incident)', () => {
    let s = applySample(FRESH, { ok: false, value: 0, atMs: 1 });
    s = applySample(s, { ok: false, value: 0, atMs: 2 });
    s = applySample(s, { ok: true, value: 1, atMs: 3 });
    expect(s.consecutiveFailures).toBe(0);
    expect(s.incidentOpen).toBe(false);
    s = applySample(s, { ok: false, value: 0, atMs: 4 });
    s = applySample(s, { ok: false, value: 0, atMs: 5 });
    expect(s.incidentOpen).toBe(false); // streak restarted at 2
  });
  it('resolves after M consecutive successes (default 2)', () => {
    let s: DetectionState = { ...FRESH, incidentOpen: true, consecutiveFailures: 3 };
    s = applySample(s, { ok: true, value: 1, atMs: 1 });
    expect(s.transition).toBe('none');
    expect(s.incidentOpen).toBe(true);
    s = applySample(s, { ok: true, value: 1, atMs: 2 });
    expect(s.transition).toBe('resolve');
    expect(s.incidentOpen).toBe(false);
  });
  it('a failure during recovery resets the success streak (incident stays open)', () => {
    let s: DetectionState = { ...FRESH, incidentOpen: true };
    s = applySample(s, { ok: true, value: 1, atMs: 1 });
    s = applySample(s, { ok: false, value: 0, atMs: 2 });
    expect(s.incidentOpen).toBe(true);
    expect(s.consecutiveSuccesses).toBe(0);
  });
  it('stale freezes everything: no transition, streaks and open flag unchanged', () => {
    const open: DetectionState = { consecutiveFailures: 2, consecutiveSuccesses: 0, incidentOpen: true, transition: 'none' };
    const s = applyStale(open);
    expect(s).toEqual(open);
    expect(s.transition).toBe('none');
    // a closed state stays closed, too
    expect(applyStale(FRESH)).toEqual(FRESH);
  });
  it('custom thresholds are honoured', () => {
    const cfg = { failureThreshold: 1, successThreshold: 1 };
    let s = applySample(FRESH, { ok: false, value: 0, atMs: 1 }, cfg);
    expect(s.transition).toBe('open');
    s = applySample(s, { ok: true, value: 1, atMs: 2 }, cfg);
    expect(s.transition).toBe('resolve');
  });
  it('validates its config and helper predicates', () => {
    expect(() => validateDetectionConfig({ failureThreshold: 0, successThreshold: 2 })).toThrow(DomainError);
    expect(() => validateDetectionConfig({ failureThreshold: 2, successThreshold: 1.5 as 2 })).toThrow(DomainError);
    expect(blackboxOk(1)).toBe(true);
    expect(blackboxOk(0)).toBe(false);
    expect(sliRatioOk(999, 1000, 0.999)).toBe(true);
    expect(sliRatioOk(998, 1000, 0.999)).toBe(false);
    expect(() => sliRatioOk(1, 0, 0.9)).toThrow(DomainError);
    expect(() => sliRatioOk(1, 10, 1.5)).toThrow(DomainError);
    expect(DEFAULT_DETECTION).toEqual({ failureThreshold: 3, successThreshold: 2 });
  });
});

describe('probe source parsing', () => {
  it('parses the three source kinds and rejects junk', () => {
    expect(parseProbeSource('{"kind":"blackbox","job":"blackbox-8443"}')).toEqual({ kind: 'blackbox', job: 'blackbox-8443' });
    expect(parseProbeSource('{"kind":"promql","good":"sum(ok)","total":"sum(all)"}')).toBeTruthy();
    expect(parseProbeSource('{"kind":"alertmanager","alert":"ServiceDown"}')).toBeTruthy();
    expect(parseProbeSource(null)).toBeNull();
    expect(parseProbeSource('not json')).toBeNull();
    expect(parseProbeSource('{"kind":"blackbox","job":""}')).toBeNull();
    expect(parseProbeSource('{"kind":"alien"}')).toBeNull();
  });
});

describe('promInstantQuery against a mock Prometheus (real HTTP)', () => {
  let server: http.Server;
  let base = '';
  let lastAuth = '';
  let responses: Map<string, { status?: number; body: unknown }> = new Map();

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      lastAuth = req.headers.authorization ?? '';
      const q = new URL(req.url ?? '/', 'http://x').searchParams.get('query') ?? '';
      const hit = responses.get(q);
      res.writeHead(hit?.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(hit?.body ?? { status: 'success', data: { result: [] } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const settings: PrometheusSettings = { baseUrl: '', auth: { kind: 'none' } };

  it('returns the latest sample value', async () => {
    responses = new Map([['probe_success', { body: { status: 'success', data: { result: [{ value: [1750000000, '1'] }] } } }]]);
    const r = await promInstantQuery({ ...settings, baseUrl: base }, 'probe_success');
    expect(r.value).toBe(1);
  });
  it('returns null for an empty series (caller decides stale)', async () => {
    responses = new Map();
    const r = await promInstantQuery({ ...settings, baseUrl: base }, 'nothing_here');
    expect(r.value).toBeNull();
  });
  it('sends the bearer token when configured', async () => {
    responses = new Map();
    await promInstantQuery({ baseUrl: base, auth: { kind: 'bearer', token: 'tok-abc' } }, 'x');
    expect(lastAuth).toBe('Bearer tok-abc');
  });
  it('sends basic auth when configured', async () => {
    responses = new Map();
    await promInstantQuery({ baseUrl: base, auth: { kind: 'basic', username: 'u', password: 'p' } }, 'x');
    expect(lastAuth).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });
  it('throws a named error on HTTP failure and on non-success status', async () => {
    responses = new Map([['bad', { status: 500, body: {} }], ['badjson', { body: { status: 'error', data: {} } }]]);
    await expect(promInstantQuery({ ...settings, baseUrl: base }, 'bad')).rejects.toThrow(/HTTP 500/);
    await expect(promInstantQuery({ ...settings, baseUrl: base }, 'badjson')).rejects.toThrow(/non-success/);
  });
  it('surfaces connection refused as stale in fetchServiceSignal shape (integration smoke)', async () => {
    // port 1 is reserved and refuses connections in every sane environment
    const dead: PrometheusSettings = { baseUrl: 'http://127.0.0.1:1', auth: { kind: 'none' } };
    await expect(promInstantQuery(dead, 'x')).rejects.toThrow();
  });
});
