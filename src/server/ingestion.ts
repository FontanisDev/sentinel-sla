// ═══════════════════════════════════════════════════════════════════════════
// Sentinel-SLA — live-mode ingestion worker
//
// Polls the real Prometheus HTTP API for every service that carries a
// `probeSource`, feeds samples through the pure detection state machine
// (src/domain/detection.ts), opens/resolves incidents with stored evidence
// and treats Prometheus-unreachable as STALE — never healthy, never an
// outage (a "monitoring blind" alert is raised once per staleness episode).
//
// Demo mode never calls any of this: the simulation engine owns the process
// when SENTINEL_MODE=demo (gated in instrumentation + worker entrypoint).
// ═══════════════════════════════════════════════════════════════════════════

import type { Service } from '@prisma/client';
import { db } from '@/lib/db';
import {
  applySample,
  applyStale,
  blackboxOk,
  sliRatioOk,
  type DetectionConfig,
  type DetectionState,
  DEFAULT_DETECTION,
} from '@/domain/detection';
import { penaltyFixedPerMinute } from '@/domain/contract';
import { resolveServiceTps } from '@/server/shaparak-import';
import { getConfig } from '@/server/config';
import { HttpError } from '@/server/http';
import { finalizeLiveChaosExperiment } from '@/server/resilience/chaoshook';

// ── integration settings ───────────────────────────────────────────────────

export interface PrometheusSettings {
  baseUrl: string;
  auth: { kind: 'none' } | { kind: 'basic'; username: string; password: string } | { kind: 'bearer'; token: string };
}

const PROM_SETTINGS_KEY = 'prometheus';

export async function readPrometheusSettings(): Promise<PrometheusSettings | null> {
  const row = await db.integrationSetting.findUnique({ where: { key: PROM_SETTINGS_KEY } });
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as PrometheusSettings;
    if (typeof parsed?.baseUrl !== 'string' || parsed.baseUrl.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writePrometheusSettings(
  settings: PrometheusSettings,
  updatedBy: string,
): Promise<void> {
  await db.integrationSetting.upsert({
    where: { key: PROM_SETTINGS_KEY },
    update: { value: JSON.stringify(settings), updatedAt: new Date(), updatedBy },
    create: { key: PROM_SETTINGS_KEY, value: JSON.stringify(settings), updatedBy },
  });
}

// ── probe source config ────────────────────────────────────────────────────

/**
 * Placeholder settings for synthetic (product-controlled) probe sources —
 * never dereferenced (the synthetic branch does no HTTP); only satisfies the
 * shared fetchServiceSignal signature when no Prometheus is configured.
 */
const SYNTHETIC_STUB_SETTINGS: PrometheusSettings = {
  baseUrl: 'synthetic://internal',
  auth: { kind: 'none' },
};

export type ProbeSource =
  | { kind: 'blackbox'; job: string; instance?: string }
  | { kind: 'promql'; good: string; total: string }
  | { kind: 'alertmanager'; alert: string; matcher?: string }
  | { kind: 'synthetic' };

export function parseProbeSource(raw: string | null | undefined): ProbeSource | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as ProbeSource;
    if (p?.kind === 'blackbox' && typeof p.job === 'string' && p.job.length > 0) return p;
    if (p?.kind === 'promql' && typeof p.good === 'string' && typeof p.total === 'string') return p;
    if (p?.kind === 'alertmanager' && typeof p.alert === 'string') return p;
    if (p?.kind === 'synthetic') return p;
    return null;
  } catch {
    return null;
  }
}

// ── Prometheus HTTP API client ─────────────────────────────────────────────

interface PromQueryResult {
  value: number | null; // latest sample value (null = no series / empty)
}

function authHeaders(settings: PrometheusSettings): HeadersInit {
  if (settings.auth.kind === 'bearer') {
    return { Authorization: `Bearer ${settings.auth.token}` };
  }
  if (settings.auth.kind === 'basic') {
    const cred = Buffer.from(`${settings.auth.username}:${settings.auth.password}`).toString('base64');
    return { Authorization: `Basic ${cred}` };
  }
  return {};
}

/** GET <base>/api/v1/query — returns the latest sample value or null. */
export async function promInstantQuery(
  settings: PrometheusSettings,
  query: string,
  timeoutMs = 5000,
): Promise<PromQueryResult> {
  const url = `${settings.baseUrl.replace(/\/+$/, '')}/api/v1/query?${new URLSearchParams({ query })}`;
  const res = await fetch(url, {
    headers: authHeaders(settings),
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new HttpError(502, `Prometheus query failed with HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    status: string;
    data?: { result?: Array<{ value?: [number, string] }> };
  };
  if (body.status !== 'success') {
    throw new HttpError(502, 'Prometheus query returned a non-success status');
  }
  const series = body.data?.result ?? [];
  if (series.length === 0) return { value: null };
  const v = series[0]?.value?.[1];
  return { value: v === undefined ? null : Number(v) };
}

export interface FetchOutcome {
  kind: 'sample';
  ok: boolean;
  value: number;
  query: string;
  atMs: number;
}

export interface FetchStale {
  kind: 'stale';
  reason: string;
  atMs: number;
}

// ── signal preview ──────────────────────────────

export interface RangePoint {
  tsMs: number;
  value: number;
}

interface PromRangeResult {
  tsMs: number[];
  values: number[];
}

/** GET <base>/api/v1/query_range — first series aligned to the requested step. */
export async function promRangeQuery(
  settings: PrometheusSettings,
  query: string,
  startMs: number,
  endMs: number,
  stepSec = 60,
  timeoutMs = 8000,
): Promise<PromRangeResult> {
  const params = new URLSearchParams({
    query,
    start: String(Math.floor(startMs / 1000)),
    end: String(Math.floor(endMs / 1000)),
    step: String(stepSec),
  });
  const url = `${settings.baseUrl.replace(/\/+$/, '')}/api/v1/query_range?${params.toString()}`;
  const res = await fetch(url, {
    headers: authHeaders(settings),
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new HttpError(502, `Prometheus range query failed with HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    status: string;
    data?: { result?: Array<{ values?: Array<[number, string]> }> };
  };
  if (body.status !== 'success') {
    throw new HttpError(502, 'Prometheus range query returned a non-success status');
  }
  const series = body.data?.result ?? [];
  if (series.length === 0) return { tsMs: [], values: [] };
  const values = series[0]?.values ?? [];
  return {
    tsMs: values.map(([ts]) => ts * 1000),
    values: values.map(([, v]) => Number(v)),
  };
}

export interface ProbePreview {
  kind: ProbeSource['kind'];
  /** executed query (or matcher summary for alertmanager) — shown in the wizard */
  query: string;
  windowMinutes: number;
  series: RangePoint[];
  /** fraction of samples satisfying the probe rule (null: no samples / not applicable) */
  okRatio: number | null;
  lastValue: number | null;
  /** extra explanation (e.g. alertmanager is webhook-driven) */
  note: string | null;
}

/**
 * One-hour lookback of a candidate signal — item 2: "Preview the last
 * hour of the signal before saving". Alertmanager sources are webhook-driven
 * and cannot be polled, so the preview returns an explanatory note instead of
 * fabricated data.
 */
export async function previewProbeSource(
  source: ProbeSource,
  hints: { endpoint: string; slaTarget: number },
  settings: PrometheusSettings,
  nowMs = Date.now(),
): Promise<ProbePreview> {
  const windowMinutes = 60;
  const startMs = nowMs - windowMinutes * 60 * 1000;
  const stepSec = 60;

  if (source.kind === 'alertmanager') {
    return {
      kind: 'alertmanager',
      query: source.matcher
        ? `alertname="${source.alert}", ${source.matcher}`
        : `alertname="${source.alert}"`,
      windowMinutes,
      series: [],
      okRatio: null,
      lastValue: null,
      note: 'webhook-driven',
    };
  }

  if (source.kind === 'synthetic') {
    // product-controlled self-test target — never offered by the wizard;
    // the honest preview just names what it is.
    return {
      kind: 'synthetic',
      query: 'sentinel:selftest-synthetic',
      windowMinutes,
      series: [],
      okRatio: null,
      lastValue: null,
      note: 'product-controlled self-test target (no external probe)',
    };
  }

  if (source.kind === 'blackbox') {
    const instance = source.instance ?? hints.endpoint;
    const query = `probe_success{job="${source.job}", instance="${instance}"}`;
    const r = await promRangeQuery(settings, query, startMs, nowMs, stepSec);
    const points: RangePoint[] = r.tsMs.map((tsMs, i) => ({ tsMs, value: r.values[i] ?? 0 }));
    const oks = r.values.filter((v) => blackboxOk(v)).length;
    return {
      kind: 'blackbox',
      query,
      windowMinutes,
      series: points,
      okRatio: r.values.length > 0 ? oks / r.values.length : null,
      lastValue: r.values.length > 0 ? (r.values[r.values.length - 1] ?? null) : null,
      note: null,
    };
  }

  // promql ratio — good & total aligned by timestamp (same start/end/step)
  const [good, total] = await Promise.all([
    promRangeQuery(settings, source.good, startMs, nowMs, stepSec),
    promRangeQuery(settings, source.total, startMs, nowMs, stepSec),
  ]);
  const totalByTs = new Map<number, number>();
  total.tsMs.forEach((ts, i) => totalByTs.set(ts, total.values[i] ?? 0));
  const points: RangePoint[] = [];
  let lastRatio: number | null = null;
  let okCount = 0;
  let sampleCount = 0;
  good.tsMs.forEach((ts, i) => {
    const t = totalByTs.get(ts);
    if (t === undefined || t <= 0) return;
    const g = good.values[i] ?? 0;
    const ratio = g / t;
    points.push({ tsMs: ts, value: Math.round(ratio * 10000) / 10000 });
    lastRatio = ratio;
    sampleCount++;
    if (sliRatioOk(g, t, hints.slaTarget)) okCount++;
  });
  return {
    kind: 'promql',
    query: `(${source.good}) / (${source.total})`,
    windowMinutes,
    series: points,
    okRatio: sampleCount > 0 ? okCount / sampleCount : null,
    lastValue: lastRatio,
    note: null,
  };
}

/** Resolve one service's probe source to a sample or a stale marker. */
export async function fetchServiceSignal(
  service: Service,
  source: ProbeSource,
  settings: PrometheusSettings,
  nowMs: number,
): Promise<FetchOutcome | FetchStale> {
  try {
    if (source.kind === 'blackbox') {
      const instance = source.instance ?? service.endpoint;
      const query = `probe_success{job="${source.job}", instance="${instance}"}`;
      const r = await promInstantQuery(settings, query);
      if (r.value === null) return { kind: 'stale', reason: `no series for ${query}`, atMs: nowMs };
      return { kind: 'sample', ok: blackboxOk(r.value), value: r.value, query, atMs: nowMs };
    }
    if (source.kind === 'promql') {
      const [good, total] = await Promise.all([
        promInstantQuery(settings, source.good),
        promInstantQuery(settings, source.total),
      ]);
      if (good.value === null || total.value === null) {
        return { kind: 'stale', reason: 'promql SLI series missing', atMs: nowMs };
      }
      if (total.value <= 0) return { kind: 'stale', reason: 'promql total is 0', atMs: nowMs };
      const ratio = good.value / total.value;
      return {
        kind: 'sample',
        ok: sliRatioOk(good.value, total.value, service.slaTarget),
        value: ratio,
        query: `(${source.good}) / (${source.total})`,
        atMs: nowMs,
      };
    }
    // alertmanager sources are driven by the webhook, not by polling
    if (source.kind === 'alertmanager') {
      return { kind: 'stale', reason: 'alertmanager source: waiting for webhook', atMs: nowMs };
    }
    // self-test: a target the product fully controls. The probe
    // result is synthesized from the RUNNING live-mode SelfTestRun fault
    // window — down while the window is active, up otherwise. Everything
    // downstream (streaks → openLiveIncident → evidence → alerts → resolve)
    // is the exact live detection pipeline, so MTTD/MTTR measure the real thing.
    const activeFault = await db.selfTestRun.findFirst({
      where: { mode: 'live', status: 'running', faultUntil: { gt: new Date(nowMs) } },
      orderBy: { startedAt: 'desc' },
    });
    const query = 'sentinel:selftest-synthetic';
    if (activeFault) {
      return { kind: 'sample', ok: false, value: 0, query, atMs: nowMs };
    }
    return { kind: 'sample', ok: true, value: 1, query, atMs: nowMs };
  } catch (err) {
    const reason = err instanceof HttpError ? err.message : err instanceof Error ? err.message : 'unknown fetch error';
    return { kind: 'stale', reason, atMs: nowMs };
  }
}

// ── incident lifecycle ─────────────────────────────────────────────────────

function detectionConfigFor(): DetectionConfig {
  const config = getConfig();
  return { failureThreshold: config.liveFailureThreshold, successThreshold: config.liveSuccessThreshold };
}

function parseDetectionState(service: Service): DetectionState {
  return {
    consecutiveFailures: service.liveFailures,
    consecutiveSuccesses: service.liveSuccesses,
    incidentOpen: service.liveIncidentOpen,
    transition: 'none',
  };
}

async function openLiveIncident(service: Service, outcome: Extract<FetchOutcome, { kind: 'sample' }>, config: DetectionConfig): Promise<string> {
  const evidence = {
    rule: {
      kind: 'consecutive-failures',
      failureThreshold: config.failureThreshold,
      successThreshold: config.successThreshold,
      probe: parseProbeSource(service.probeSource),
    },
    samples: [{ ok: outcome.ok, value: outcome.value, atMs: outcome.atMs, query: outcome.query }],
    contractVersion: null, // pinned when contract tables land
    moneyModelVersion: null,
    breakdown: null,
  };
  const incident = await db.incident.create({
    data: {
      serviceId: service.id,
      status: 'ongoing',
      severity: 'critical',
      source: 'live',
      startedAt: new Date(outcome.atMs),
      events: JSON.stringify([
        { ts: new Date(outcome.atMs).toISOString(), event: 'fault_started', detail: 'live ingestion' },
        { ts: new Date(outcome.atMs).toISOString(), event: 'probe_failed', detail: `streak ${config.failureThreshold}/${config.failureThreshold}` },
      ]),
      evidence: JSON.stringify(evidence),
    },
  });
  await db.alert.create({
    data: {
      serviceId: service.id,
      incidentId: incident.id,
      channel: 'dashboard',
      audience: 'technical',
      severity: 'critical',
      title: `LIVE down: ${service.name}`,
      message: `Incident opened by live ingestion after ${config.failureThreshold} consecutive failed probes (${outcome.query} = ${outcome.value}).`,
      status: 'delivered',
    },
  });
  return incident.id;
}

async function resolveLiveIncident(incidentId: string, service: Service, atMs: number, value: number, query: string): Promise<void> {
  const incident = await db.incident.findUnique({ where: { id: incidentId } });
  if (!incident || incident.status !== 'ongoing') return;
  const startedAtMs = incident.startedAt.getTime();
  const durationSec = Math.round(((atMs - startedAtMs) / 1000) * 10) / 10;
  // Live money: penalty via the pure domain rule (half-even, integer path);
  // revenue loss from the tps in effect at the incident START × duration ×
  // ticket. With a Shaparak/PSP transaction profile stored, tps is resolved
  // from the incident's own wall-clock hour-of-week bucket  —
  // a peak-hour outage costs peak-hour money. The resolution (source,
  // bucket, value, any corrupt-profile fallback) is recorded in the events
  // so the figure stays auditable (truthful-numbers rule).
  const tpsAt = resolveServiceTps(service, new Date(startedAtMs));
  const penalty =
    Number.isSafeInteger(service.penaltyBase) && Number.isSafeInteger(service.penaltyPerMinute)
      ? penaltyFixedPerMinute(service.penaltyBase, service.penaltyPerMinute, Math.max(0, Math.round(durationSec)))
      : service.penaltyBase + service.penaltyPerMinute * Math.max(1, Math.ceil(durationSec / 60));
  const lostTx = Math.round(tpsAt.tps * durationSec);
  const revenueLoss = Math.round(tpsAt.tps * durationSec * service.avgTransactionValue);

  const events = JSON.parse(incident.events || '[]') as Array<{ ts: string; event: string; detail?: string }>;
  const tpsDetail =
    tpsAt.source === 'profile'
      ? `tps ${tpsAt.tps.toFixed(4)}/s from the transaction profile (bucket ${tpsAt.bucket}, Tehran wall clock)`
      : tpsAt.profileError
        ? `tps fell back to the flat rate ${tpsAt.tps}/s — profile unusable (${tpsAt.profileError})`
        : `flat tps ${tpsAt.tps}/s`;
  events.push({ ts: new Date(atMs).toISOString(), event: 'resolved', detail: `probe recovered (${query} = ${value}); money at ${tpsDetail}` });

  // Fold the resolution into the stored evidence samples.
  let evidence = incident.evidence;
  if (evidence) {
    try {
      const parsed = JSON.parse(evidence) as { samples?: unknown[] };
      parsed.samples = [
        ...(parsed.samples ?? []),
        { ok: true, value, atMs, query },
      ];
      evidence = JSON.stringify(parsed);
    } catch {
      // keep original evidence unparseable-safe
    }
  }

  await db.incident.update({
    where: { id: incidentId },
    data: {
      status: 'resolved',
      resolvedAt: new Date(atMs),
      durationSec,
      mttrSec: durationSec,
      lostTransactions: lostTx,
      revenueLossTomans: revenueLoss,
      penaltyTomans: penalty,
      events: JSON.stringify(events),
      evidence,
    },
  });

  // if this service has a running (hook-launched) chaos experiment,
  // the real live pipeline just measured it — finalize with the honest MTTD.
  await finalizeLiveChaosExperiment(service.id, {
    id: incidentId,
    startedAt: incident.startedAt,
    resolvedAt: new Date(atMs),
    mttrSec: durationSec,
  }).catch((err: unknown) =>
    console.error('[sentinel:chaos] live experiment finalize failed:', err instanceof Error ? err.message : err),
  );
}

// ── the tick ───────────────────────────────────────────────────────────────

export interface TickReport {
  polled: number;
  opened: string[]; // service keys
  resolved: string[];
  stale: string[];
}

/**
 * One ingestion pass over every live-enabled service. Throws only on
 * unexpected internal errors; per-service errors are contained and reported
 * as stale (the show must go on for the other services).
 */
export async function runIngestionTick(nowMs = Date.now()): Promise<TickReport> {
  const report: TickReport = { polled: 0, opened: [], resolved: [], stale: [] };
  const settings = await readPrometheusSettings();

  const services = await db.service.findMany({ where: { enabled: true, NOT: { probeSource: null } } });
  for (const service of services) {
    const source = parseProbeSource(service.probeSource);
    if (!source || source.kind === 'alertmanager') continue; // webhook-driven
    // Synthetic targets are product-controlled and poll
    // even without a configured Prometheus — every other source needs one.
    if (!settings && source.kind !== 'synthetic') continue;
    report.polled++;
    const config = detectionConfigFor();
    const outcome = await fetchServiceSignal(service, source, settings ?? SYNTHETIC_STUB_SETTINGS, nowMs);
    const prev = parseDetectionState(service);

    if (outcome.kind === 'stale') {
      const alreadyStale = service.liveStatus === 'stale';
      // applyStale freezes streaks AND the open-incident flag: persist status
      // only, streaks + liveIncidentOpen unchanged.
      await db.service.update({
        where: { id: service.id },
        data: { liveStatus: 'stale', lastPolledAt: new Date(nowMs) },
      });
      if (!alreadyStale) {
        // "monitoring blind" — raised ONCE per staleness episode
        await db.alert.create({
          data: {
            serviceId: service.id,
            channel: 'dashboard',
            audience: 'technical',
            severity: 'warning',
            title: `Monitoring blind: ${service.name}`,
            message: `Prometheus signal unavailable (${outcome.reason}). The service is NOT marked up or down until data returns.`,
            status: 'delivered',
          },
        });
      }
      report.stale.push(service.key);
      continue;
    }

    const next = applySample(prev, { ok: outcome.ok, value: outcome.value, atMs: outcome.atMs }, config);
    if (next.transition === 'open') {
      await openLiveIncident(service, outcome, config);
    }
    await db.service.update({
      where: { id: service.id },
      data: {
        liveFailures: next.consecutiveFailures,
        liveSuccesses: next.consecutiveSuccesses,
        liveStatus: outcome.ok ? 'up' : 'down',
        liveIncidentOpen: next.incidentOpen,
        lastPolledAt: new Date(nowMs),
      },
    });
    if (next.transition === 'open') report.opened.push(service.key);
    if (next.transition === 'resolve') {
      // find the ongoing live incident for this service
      const ongoing = await db.incident.findFirst({
        where: { serviceId: service.id, status: 'ongoing', source: 'live' },
        orderBy: { startedAt: 'desc' },
      });
      if (ongoing) {
        await resolveLiveIncident(ongoing.id, service, outcome.atMs, outcome.value, outcome.query);
        report.resolved.push(service.key);
      }
    }
  }
  return report;
}

// ── loop ownership (instrumentation / worker entrypoint) ───────────────────

const LOOP_GUARD = Symbol.for('sentinel.ingestion.loop');

interface LoopHolder {
  timer?: ReturnType<typeof setInterval>;
  running?: boolean;
}

function loopHolder(): LoopHolder {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[LOOP_GUARD]) g[LOOP_GUARD] = {} as LoopHolder;
  return g[LOOP_GUARD] as LoopHolder;
}

/** Start the periodic ingestion tick (idempotent). Returns the interval ms. */
export function startIngestionLoop(intervalSec?: number): number {
  const holder = loopHolder();
  if (holder.timer) return intervalSec ?? getConfig().pollIntervalSec; // already running
  const sec = intervalSec ?? getConfig().pollIntervalSec;
  // first tick promptly, then every interval; overlapping runs are guarded
  const tick = async (): Promise<void> => {
    if (holder.running) return;
    holder.running = true;
    try {
      const report = await runIngestionTick();
      if (report.polled > 0 || report.stale.length > 0) {
        console.log(
          `[sentinel:ingest] polled=${report.polled} opened=${report.opened.length} ` +
            `resolved=${report.resolved.length} stale=${report.stale.length}`,
        );
      }
    } catch (err) {
      console.error('[sentinel:ingest] tick failed:', err instanceof Error ? err.message : err);
    } finally {
      holder.running = false;
    }
  };
  void tick();
  holder.timer = setInterval(() => void tick(), sec * 1000);
  return sec;
}

export function stopIngestionLoop(): void {
  const holder = loopHolder();
  if (holder.timer) {
    clearInterval(holder.timer);
    holder.timer = undefined;
  }
}
