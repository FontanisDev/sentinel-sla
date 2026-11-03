// Sentinel-SLA — v2 analytics (richer executive reporting).
//
// GET /api/analytics?tenant=<id|all>&windowHours=<1-24> computes, over the
// requested rolling window and (optionally) a single tenant's services:
//   * errorBudgets  — per-service rolling SLA error budgets (SRE burn-down)
//   * trends        — hourly incident/MTTD/MTTR/penalty buckets
//   * heatmap       — per-service availability buckets over up to 24h of
//                     MetricSnapshot history (v2.3: bucket size adapts to the
//                     window — 5 min ≤6h, 10 min ≤12h, 15 min ≤24h — so the
//                     grid stays legible at every horizon)
//
// Financial figures are Tomans, matching the dashboard's executive language.
//
// v2.3: results are memo-cached for 30s per (tenant, window) — the dashboard
// polls analytics every 60s, so every second poll hits memory instead of
// re-running the snapshot scan. In-flight computes are deduplicated.

import { db } from '@/lib/db';
import type {
  AnalyticsDTO,
  ErrorBudgetDTO,
  ErrorBudgetStatus,
  HeatmapBucketDTO,
  TrendPointDTO,
} from '@/lib/types';
import { serviceIdsForTenant } from '@/server/tenants';

const HOUR_MS = 3_600_000;
/** v2.3: snapshot retention is 24h; bucket size adapts so cells stay readable. */
function heatmapBucketMin(windowHours: number): number {
  if (windowHours <= 6) return 5;
  if (windowHours <= 12) return 10;
  return 15;
}
const HEATMAP_MAX_HOURS = 24;
/** MetricSnapshot.status → availability score (matches the uptime 0.5 encoding). */
const STATUS_SCORE: Record<string, number> = { up: 1, degraded: 0.5, down: 0 };

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;
const round4 = (x: number) => Math.round(x * 10000) / 10000;

// ── v2.3 memo cache ─────────────────────────────────────────────────────────
const ANALYTICS_CACHE_TTL_MS = 30_000;
const analyticsCache = new Map<string, { at: number; value: AnalyticsDTO }>();
const analyticsInFlight = new Map<string, Promise<AnalyticsDTO>>();

/**
 * Compute the analytics payload (v2.3: memo-cached 30s per tenant+window).
 * `tenantId` null = fleet-wide; `windowHours` must already be clamped to 1–24
 * by the route.
 */
export async function computeAnalytics(
  tenantId: string | null,
  windowHours: number,
): Promise<AnalyticsDTO> {
  const key = `${tenantId ?? 'all'}:${windowHours}`;
  const cached = analyticsCache.get(key);
  if (cached && Date.now() - cached.at < ANALYTICS_CACHE_TTL_MS) {
    return cached.value;
  }
  const inFlight = analyticsInFlight.get(key);
  if (inFlight) return inFlight;
  const p = (async () => {
    try {
      const value = await computeAnalyticsUncached(tenantId, windowHours);
      analyticsCache.set(key, { at: Date.now(), value });
      return value;
    } finally {
      analyticsInFlight.delete(key);
    }
  })();
  analyticsInFlight.set(key, p);
  return p;
}

async function computeAnalyticsUncached(
  tenantId: string | null,
  windowHours: number,
): Promise<AnalyticsDTO> {
  const now = Date.now();
  const windowMs = windowHours * HOUR_MS;
  const windowStart = new Date(now - windowMs);

  // Scope: tenant's services, or the whole fleet.
  const scopeIds = tenantId ? await serviceIdsForTenant(tenantId) : null;
  const services = await db.service.findMany({ orderBy: { key: 'asc' } });
  const scoped = scopeIds === null ? services : services.filter((s) => scopeIds.includes(s.id));
  const serviceIds = scoped.map((s) => s.id);

  // Incidents that started inside the window for the scoped services.
  const incidents =
    serviceIds.length > 0
      ? await db.incident.findMany({
          where: { serviceId: { in: serviceIds }, startedAt: { gte: windowStart } },
        })
      : [];

  // ── error budgets ───────────────────────────────────────────────────────────
  const errorBudgets: ErrorBudgetDTO[] = scoped.map((svc) => {
    const allowedDowntimeSec = (1 - svc.slaTarget) * windowHours * 3600;
    let consumed = 0;
    for (const inc of incidents) {
      if (inc.serviceId !== svc.id) continue;
      // critical consumes the full downtime; warning half (uptime 0.5 encoding)
      const endMs = inc.resolvedAt ? inc.resolvedAt.getTime() : now;
      const durSec = Math.max(0, (endMs - inc.startedAt.getTime()) / 1000);
      consumed += inc.severity === 'warning' ? 0.5 * durSec : durSec;
    }
    const remainingSec = allowedDowntimeSec - consumed;
    const remainingRatio = allowedDowntimeSec > 0 ? remainingSec / allowedDowntimeSec : 1;
    const status: ErrorBudgetStatus =
      remainingRatio > 0.5 ? 'healthy' : remainingRatio > 0 ? 'burning' : 'exhausted';
    const burnRatePerHour = consumed / windowHours;
    let projectedExhaustionSec: number | null = null;
    if (remainingSec <= 0) {
      projectedExhaustionSec = 0;
    } else if (burnRatePerHour > allowedDowntimeSec / windowHours) {
      projectedExhaustionSec = Math.round((remainingSec / burnRatePerHour) * 3600);
    }
    return {
      serviceId: svc.id,
      serviceKey: svc.key,
      serviceName: svc.name,
      slaTarget: svc.slaTarget,
      windowHours,
      allowedDowntimeSec: round2(allowedDowntimeSec),
      consumedDowntimeSec: round2(consumed),
      remainingSec: round2(remainingSec),
      remainingRatio: round4(remainingRatio),
      status,
      burnRatePerHour: round4(burnRatePerHour),
      projectedExhaustionSec,
    };
  });

  // ── trends: hourly buckets, oldest first, partial current hour included ─────
  const trends: TrendPointDTO[] = [];
  const firstBucket = Math.floor((now - windowMs) / HOUR_MS) * HOUR_MS;
  const lastBucket = Math.floor(now / HOUR_MS) * HOUR_MS;
  for (let b = firstBucket; b <= lastBucket; b += HOUR_MS) {
    const next = b + HOUR_MS;
    const inBucket = incidents.filter((i) => {
      const t = i.startedAt.getTime();
      return t >= b && t < next;
    });
    const mttds = inBucket
      .filter((i) => i.status === 'resolved' && i.mttdSec !== null)
      .map((i) => i.mttdSec as number);
    const mttrs = inBucket
      .filter((i) => i.status === 'resolved' && i.mttrSec !== null)
      .map((i) => i.mttrSec as number);
    // v2.5 MTTA: valid the moment an incident is acknowledged (no status filter).
    const mttas = inBucket
      .filter((i) => i.mttaSec !== null)
      .map((i) => i.mttaSec as number);
    const penaltyTomans = inBucket.reduce((sum, i) => sum + i.penaltyTomans, 0);
    trends.push({
      ts: new Date(b).toISOString(),
      incidents: inBucket.length,
      mttdSec: mttds.length > 0 ? round1(mttds.reduce((a, x) => a + x, 0) / mttds.length) : null,
      mttrSec: mttrs.length > 0 ? round1(mttrs.reduce((a, x) => a + x, 0) / mttrs.length) : null,
      mttaSec: mttas.length > 0 ? round1(mttas.reduce((a, x) => a + x, 0) / mttas.length) : null,
      penaltyTomans: Math.round(penaltyTomans),
    });
  }

  // ── heatmap: adaptive buckets over min(windowHours, 24)h of snapshots ──
  const heatmapHours = Math.min(windowHours, HEATMAP_MAX_HOURS);
  const bucketMs = heatmapBucketMin(windowHours) * 60_000;
  const heatStart = now - heatmapHours * HOUR_MS;
  const snapshots =
    serviceIds.length > 0
      ? await db.metricSnapshot.findMany({
          where: { serviceId: { in: serviceIds }, ts: { gte: new Date(heatStart) } },
          orderBy: { ts: 'asc' },
        })
      : [];

  // accumulate per (bucketStart, serviceId): sum of status scores + count
  const acc = new Map<number, Map<string, { sum: number; n: number }>>();
  for (const snap of snapshots) {
    const score = STATUS_SCORE[snap.status];
    if (score === undefined) continue;
    const bucketStart = Math.floor(snap.ts.getTime() / bucketMs) * bucketMs;
    let byService = acc.get(bucketStart);
    if (!byService) {
      byService = new Map<string, { sum: number; n: number }>();
      acc.set(bucketStart, byService);
    }
    const cur = byService.get(snap.serviceId);
    if (cur) {
      cur.sum += score;
      cur.n += 1;
    } else {
      byService.set(snap.serviceId, { sum: score, n: 1 });
    }
  }

  const buckets: HeatmapBucketDTO[] = [];
  const heatFirst = Math.floor(heatStart / bucketMs) * bucketMs;
  const heatLast = Math.floor(now / bucketMs) * bucketMs;
  for (let b = heatFirst; b <= heatLast; b += bucketMs) {
    const byService = acc.get(b);
    const servicesRecord: Record<string, number | null> = {};
    for (const s of scoped) {
      const cur = byService?.get(s.id);
      servicesRecord[s.key] = cur ? round2(cur.sum / cur.n) : null;
    }
    buckets.push({ ts: b, services: servicesRecord });
  }

  return {
    windowHours,
    errorBudgets,
    trends,
    heatmap: { bucketSizeMin: heatmapBucketMin(windowHours), buckets },
  };
}
