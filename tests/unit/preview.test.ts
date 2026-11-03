// Wizard preview — unit tests with a stubbed Prometheus HTTP API.
// Covers: range-query envelope parsing, blackbox ok-ratio, promql good/total
// alignment by timestamp, and the honest alertmanager "webhook-driven" note.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { previewProbeSource, promRangeQuery, type PrometheusSettings } from '@/server/ingestion';

const SETTINGS: PrometheusSettings = { baseUrl: 'http://prom.test:9090', auth: { kind: 'none' } };

/** Build a Prometheus /api/v1/query_range success envelope. */
function rangeEnvelope(series: Array<{ values: Array<[number, string]> }>) {
  return {
    status: 'success',
    data: { resultType: 'matrix', result: series },
  };
}

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // fixed epoch
const T0 = Math.floor((NOW - HOUR) / 1000);

function fetchMock(routes: Record<string, unknown>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const q = url.searchParams.get('query') ?? '';
    if (!(q in routes)) {
      return new Response(JSON.stringify({ status: 'error', error: 'bad query' }), { status: 400 });
    }
    return new Response(JSON.stringify(routes[q]), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('promRangeQuery', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock({}));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses the first series aligned to epoch-ms timestamps', async () => {
    vi.stubGlobal(
      'fetch',
      fetchMock({
        'up{job="x"}': rangeEnvelope([{ values: [
          [T0, '1'],
          [T0 + 60, '0'],
        ] }]),
      }),
    );
    const r = await promRangeQuery(SETTINGS, 'up{job="x"}', NOW - HOUR, NOW, 60);
    expect(r.tsMs).toEqual([T0 * 1000, (T0 + 60) * 1000]);
    expect(r.values).toEqual([1, 0]);
  });

  it('returns empty arrays when no series exist', async () => {
    vi.stubGlobal('fetch', fetchMock({ 'absent': rangeEnvelope([]) }));
    const r = await promRangeQuery(SETTINGS, 'absent', NOW - HOUR, NOW, 60);
    expect(r.tsMs).toEqual([]);
    expect(r.values).toEqual([]);
  });
});

describe('previewProbeSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('blackbox: computes ok ratio with the domain predicate (>=1 ok)', async () => {
    vi.stubGlobal(
      'fetch',
      fetchMock({
        'probe_success{job="blackbox.http", instance="https://api.example.ir/health"}': rangeEnvelope([
          { values: [[T0, '1'], [T0 + 60, '1'], [T0 + 120, '0.5'], [T0 + 180, '1']] },
        ]),
      }),
    );
    const p = await previewProbeSource(
      { kind: 'blackbox', job: 'blackbox.http' },
      { endpoint: 'https://api.example.ir/health', slaTarget: 0.999 },
      SETTINGS,
      NOW,
    );
    expect(p.kind).toBe('blackbox');
    expect(p.series).toHaveLength(4);
    expect(p.okRatio).toBe(3 / 4); // 0.5 is NOT ok (blackboxOk requires >= 1)
    expect(p.lastValue).toBe(1);
    expect(p.note).toBeNull();
  });

  it('promql: aligns good/total by timestamp and skips zero-total points', async () => {
    vi.stubGlobal(
      'fetch',
      fetchMock({
        'sum(good)': rangeEnvelope([{ values: [[T0, '99'], [T0 + 60, '100'], [T0 + 120, '50']] }]),
        'sum(total)': rangeEnvelope([{ values: [[T0, '100'], [T0 + 60, '100'], [T0 + 120, '0']] }]),
      }),
    );
    const p = await previewProbeSource(
      { kind: 'promql', good: 'sum(good)', total: 'sum(total)' },
      { endpoint: 'https://x.example.ir', slaTarget: 0.99 },
      SETTINGS,
      NOW,
    );
    expect(p.kind).toBe('promql');
    // T0: 0.99 → ok (>= 0.99 via sliRatioOk), T0+60: 1.0 → ok, T0+120: total=0 → skipped
    expect(p.series).toEqual([
      { tsMs: T0 * 1000, value: 0.99 },
      { tsMs: (T0 + 60) * 1000, value: 1 },
    ]);
    expect(p.okRatio).toBe(1);
    expect(p.lastValue).toBe(1);
  });

  it('promql: ratio below target counts as failure', async () => {
    vi.stubGlobal(
      'fetch',
      fetchMock({
        'sum(good)': rangeEnvelope([{ values: [[T0, '98']] }]),
        'sum(total)': rangeEnvelope([{ values: [[T0, '100']] }]),
      }),
    );
    const p = await previewProbeSource(
      { kind: 'promql', good: 'sum(good)', total: 'sum(total)' },
      { endpoint: 'https://x.example.ir', slaTarget: 0.999 },
      SETTINGS,
      NOW,
    );
    expect(p.okRatio).toBe(0);
    expect(p.lastValue).toBe(0.98);
  });

  it('alertmanager: never fabricates data — webhook note instead', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const p = await previewProbeSource(
      { kind: 'alertmanager', alert: 'ServiceDown', matcher: 'service="api"' },
      { endpoint: 'https://x.example.ir', slaTarget: 0.999 },
      SETTINGS,
      NOW,
    );
    expect(p.series).toEqual([]);
    expect(p.okRatio).toBeNull();
    expect(p.note).toBe('webhook-driven');
    expect(p.query).toContain('ServiceDown');
    expect(p.query).toContain('service="api"');
    expect(fetchSpy).not.toHaveBeenCalled(); // nothing polled
  });
});
