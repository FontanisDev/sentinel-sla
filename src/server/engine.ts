// ═══════════════════════════════════════════════════════════════════════════
// Sentinel-SLA — simulation / detection / financial-impact engine
//
// Emulates the production monitoring pipeline (collector → processor → alerting)
// that is assembled from Prometheus / Blackbox Exporter / Alertmanager in real
// deployments. Each tick (2.5s) probes every service, applies chaos or
// spontaneous faults, runs the detection logic (N consecutive probe failures →
// incident), accrues financial impact in Tomans, and writes DB rows only on
// events (incidents, alerts, chaos experiments, ~30s metric snapshots).
// ═══════════════════════════════════════════════════════════════════════════

import type { ChaosExperiment, Incident, Service } from '@prisma/client';
import { db } from '@/lib/db';
import { getConfig } from '@/server/config';
import { parseProbeSource } from '@/server/ingestion';
import type {
  AlertRuleDTO,
  ChaosType,
  DashboardDTO,
  EngineMode,
  EngineStateDTO,
  EscalationPolicyDTO,
  IncidentSeverity,
  KpiDTO,
  OnCallEntryDTO,
  ServiceDTO,
  ServiceStatus,
} from '@/lib/types';
import {
  ensureGovernanceSeeded,
  listAlertRules,
  listChannels,
  listEnabledRules,
  listOnCall,
  markRuleFired,
} from '@/server/alertgovernance';
import { emitNotification, outboxStats, startOutboxDispatcher, stopOutboxDispatcher } from '@/server/notify/outbox';
import { runDueDigests, startDigestScheduler, stopDigestScheduler } from '@/server/notify/digest';
import { startSelfTestScheduler, stopSelfTestScheduler, SELFTEST_SERVICE_KEY } from '@/server/resilience/selftest';
import { launchLiveChaos } from '@/server/resilience/chaoshook';
import { fireDetectionAlerts, fireEscalationAlerts, fireRecoveryAlerts } from '@/server/alerts';
import { toAlertDTO, toChaosDTO, toIncidentDTO, toReportDTO } from '@/server/dto';
import { HttpError } from '@/server/http';
import { penaltyFixedPerMinute } from '@/domain/contract';
import { getEscalationPolicy, markPolicyEscalated } from '@/server/escalation';
import {
  activeWindowsForService,
  expireDueWindows,
  incrementSuppressedAlerts,
  listMaintenanceWindows,
} from '@/server/maintenance';
import {
  ensureScheduleSeeded,
  listReportSchedules,
  listScheduleRuns,
  runDueReportSchedules,
} from '@/server/reportscheduling';
import { ensureSeeded } from '@/server/seed';
import {
  getTenantById,
  listTenantRows,
  serviceIdsForTenant,
  serviceTenantAssignments,
  toTenantDTO,
} from '@/server/tenants';

// ── Tunables ───────────────────────────────────────────────────────────────
const TICK_MS = 2500;
const TICK_SEC = TICK_MS / 1000;
const SERIES_CAP = 120; // ring-buffer length (~5 min of history)
const SNAPSHOT_EVERY_TICKS = 12; // ~30s
const SERVICE_RELOAD_EVERY_TICKS = 20;
const PRUNE_EVERY_MS = 10 * 60 * 1000;
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const P_DOWN = 0.0011; // per tick per service, "normal" mode
const P_DEGRADED = 0.0028;
const MODE_MULTIPLIER: Record<EngineMode, number> = { calm: 0.35, normal: 1, storm: 6 };
const DOWN_PROBE_THRESHOLD = 2; // consecutive failed probes → detect
const DEGRADED_PROBE_THRESHOLD = 3;
const DETECTION_DELAY_MIN_MS = 1500; // alert-pipeline latency
const DETECTION_DELAY_MAX_MS = 6000;
const MTTD_GATE_SEC = 60; // SLA target: detect a downed service in <60s
const AUTO_CHAOS_DURATION_SEC = 35;
/** v2.2: policy rules evaluated every N ticks (5s cadence keeps the hot path cheap). */
const RULE_EVAL_EVERY_TICKS = 2;
/** v2.6: escalation ladder checked every N ticks (~5s — same cadence as rules). */
const ESCALATION_CHECK_EVERY_TICKS = 2;
/** v2.4: report schedules checked every N ticks (~60s — cron precision is a minute). */
const SCHEDULE_CHECK_EVERY_TICKS = 24;
/** Bumped when the engine's public surface OR its captured module closure
 *  changes: getEngine() replaces any still-running instance built from an older
 *  code generation (dev HMR keeps the old class — and its captured imports —
 *  alive on globalThis between recompiles). Bump this whenever engine.ts or its
 *  server-module dependencies change shape. */
const ENGINE_VERSION = 12; // 12: (self-test scheduler, live chaos hooks, synthetic-target guards)

/** v2.1: alert deliveries suppressed per covering maintenance window when a
 * detection/recovery pair is withheld. Counted individually (+1 per alert):
 * a tech+exec pair therefore adds +2 per covering window. Both the detection
 * pair and the recovery pair are suppressed while a window covers the service
 * (contract: "alert delivery is suppressed"), so one fully covered incident
 * adds +2 (detection) and — if still covered at resolve time — +2 (recovery). */
const SUPPRESSED_PER_PAIR = 2;
/** v2.1: maintenance windows surfaced on the dashboard (active first). */
const MAINTENANCE_DASHBOARD_LIMIT = 15;

// ── Runtime state ──────────────────────────────────────────────────────────
interface RuntimeSeries {
  ts: number[];
  latencyMs: number[];
  errorRate: number[];
  throughput: number[];
  status: number[]; // 1 = up, 0.5 = degraded, 0 = down
}

interface ServiceRuntime {
  service: Service; // cached config row
  status: ServiceStatus;
  currentSince: number; // epoch ms — when the current status began
  probeFailStreak: number;
  probeDegradedStreak: number;
  // chaos forcing
  forcedUntil?: number;
  chaosType?: ChaosType;
  chaosExperimentId?: string;
  // active incident linkage
  faultSource?: 'chaos' | 'spontaneous';
  activeIncidentId?: string;
  detectedIncident?: { id: string; detectedAt: number } | null;
  pendingDetection?: ReturnType<typeof setTimeout> | null;
  // spontaneous fault window
  incidentUntil?: number;
  plannedStatus?: 'down' | 'degraded';
  // per-fault-window accrual (reset on resolve)
  windowLostTx: number;
  windowRevenueLoss: number;
  // aggregates since engine start (hydrated from resolved incidents)
  revenueLossTomans: number;
  lostTransactions: number;
  penaltyTomans: number;
  downtimeMs: number;
  uptimeMs: number;
  incidentsCount: number;
  // live metrics (last computed)
  latencyMs: number;
  errorRate: number;
  throughput: number;
  phase: number; // sinusoidal throughput-drift phase
  series: RuntimeSeries;
}

type IncidentWithService = Incident & { service: Service };
type ExperimentWithService = ChaosExperiment & { service: Service };

interface IncidentEvent {
  ts: string;
  event: string;
  detail?: string;
}

function parseEvents(raw: string): IncidentEvent[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as IncidentEvent[]) : [];
  } catch {
    return [];
  }
}

function jitter(): number {
  return Math.random() * 2 - 1;
}

function newRuntime(service: Service): ServiceRuntime {
  return {
    service,
    status: 'up',
    currentSince: Date.now(),
    probeFailStreak: 0,
    probeDegradedStreak: 0,
    windowLostTx: 0,
    windowRevenueLoss: 0,
    revenueLossTomans: 0,
    lostTransactions: 0,
    penaltyTomans: 0,
    downtimeMs: 0,
    uptimeMs: 0,
    incidentsCount: 0,
    latencyMs: service.baseLatencyMs,
    errorRate: 0.002,
    throughput: service.tps,
    phase: Math.random() * Math.PI * 2,
    series: { ts: [], latencyMs: [], errorRate: [], throughput: [], status: [] },
  };
}

// ── Engine ─────────────────────────────────────────────────────────────────
export class SentinelEngine {
  running = true;
  mode: EngineMode = 'normal';
  tickCount = 0;
  readonly startedAt = new Date();
  readonly tickIntervalMs = TICK_MS;
  readonly engineVersion = ENGINE_VERSION;
  autoChaos = false;
  autoChaosIntervalMin = 3;
  nextAutoChaosAt: number | null = null;
  lastChaosResult: string | null = null;

  private readonly runtimes = new Map<string, ServiceRuntime>();
  /** v2: serviceId → tenantId (raw-SQL mirror, refreshed with the service cache). */
  private serviceTenantIds = new Map<string, string | null>();
  /** v2: tenantId → tenant name. */
  private tenantNameById = new Map<string, string>();
  private initPromise: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** web/worker split: false = load state for reads, never tick (worker owns loops). */
  readonly loopsEnabled: boolean;
  private ticking = false;
  private lastPruneAt = 0;
  private lastServiceReloadTick = 0;
  /** v2.3: live per-rule evaluation state (violatedNow + worst measurement). */
  private ruleState = new Map<
    string,
    { violated: boolean; measured: number | null; serviceId: string | null; serviceName: string | null; since: number }
  >();
  /** v2.6: cached escalation policy — refreshed on every ladder check (~5s). */
  private escalationPolicy: EscalationPolicyDTO | null = null;

  // ── lifecycle ────────────────────────────────────────────────────────────
  constructor(backgroundLoops = true) {
    this.loopsEnabled = backgroundLoops;
  }

  private async doInit(): Promise<void> {
    await ensureSeeded();
    await ensureGovernanceSeeded();
    await ensureScheduleSeeded();
    await getEscalationPolicy(); // v2.6: seed the fleet escalation policy row
    await this.reloadServices();
    await this.reconcileStaleState();
    await this.hydrateAggregates();
    this.lastPruneAt = Date.now();
    if (this.loopsEnabled) {
      this.timer = setInterval(() => {
        void this.tick();
      }, TICK_MS);
      startOutboxDispatcher(); // deliver notifications (retry/backoff/dead-letter)
      startDigestScheduler(); // executive digest schedule (advisory-locked)
      startSelfTestScheduler(); // weekly detection self-test (advisory-locked)
    }
    console.log(
      `[sentinel] engine started — ${this.runtimes.size} services, ${TICK_MS}ms tick, ` +
        `loops=${this.loopsEnabled ? 'on' : 'off (worker owns them)'}, mode=${this.mode}`,
    );
  }

  /** Idempotent async construction (seed + load + start interval). */
  async ensureInit(): Promise<void> {
    if (!this.initPromise) {
      const p = this.doInit();
      p.catch(() => {
        if (this.initPromise === p) this.initPromise = null;
      });
      this.initPromise = p;
    }
    return this.initPromise;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.loopsEnabled) {
      stopOutboxDispatcher(); // engine started it
      stopDigestScheduler();
      stopSelfTestScheduler();
    }
  }

  // ── public control ───────────────────────────────────────────────────────
  pause(): void {
    this.running = false;
  }

  resume(): void {
    this.running = true;
  }

  setMode(mode: EngineMode): void {
    this.mode = mode;
  }

  setAutoChaos(enabled: boolean, intervalMin: number): void {
    this.autoChaos = enabled;
    this.autoChaosIntervalMin = intervalMin;
    this.nextAutoChaosAt = enabled ? Date.now() + intervalMin * 60_000 : null;
  }

  getEngineState(): EngineStateDTO {
    return {
      running: this.running,
      startedAt: this.startedAt.toISOString(),
      tickCount: this.tickCount,
      tickIntervalMs: this.tickIntervalMs,
      mode: this.mode,
      autoChaos: this.autoChaos,
      autoChaosIntervalMin: this.autoChaosIntervalMin,
      nextAutoChaosAt:
        this.nextAutoChaosAt !== null ? new Date(this.nextAutoChaosAt).toISOString() : null,
      lastChaosResult: this.lastChaosResult,
      // honest deployment mode for the UI badge (demo = simulation).
      deploymentMode: getConfig().mode,
    };
  }

  // ── service management ───────────────────────────────────────────────────
  /** Refresh cached service configs + v2 tenant assignments; preserves existing runtime state, drops deleted rows. */
  async reloadServices(): Promise<void> {
    const [services, assignments, tenants] = await Promise.all([
      db.service.findMany(),
      serviceTenantAssignments(),
      listTenantRows(),
    ]);
    this.serviceTenantIds = assignments;
    this.tenantNameById = new Map(tenants.map((t) => [t.id, t.name]));
    const seen = new Set<string>();
    for (const svc of services) {
      seen.add(svc.id);
      const existing = this.runtimes.get(svc.id);
      if (existing) {
        existing.service = svc;
      } else {
        this.runtimes.set(svc.id, newRuntime(svc));
      }
    }
    for (const id of [...this.runtimes.keys()]) {
      if (!seen.has(id)) this.runtimes.delete(id);
    }
  }

  async listServices(): Promise<ServiceDTO[]> {
    await this.ensureInit();
    await this.reloadServices();
    return [...this.runtimes.values()].map((rt) => this.toServiceDTO(rt));
  }

  async getServiceDTO(serviceId: string): Promise<ServiceDTO | null> {
    await this.ensureInit();
    const rt = this.runtimes.get(serviceId);
    return rt ? this.toServiceDTO(rt) : null;
  }

  // ── chaos ────────────────────────────────────────────────────────────────
  async launchChaos(payload: {
    serviceId: string;
    type: ChaosType;
    durationSec: number;
  }): Promise<ExperimentWithService> {
    await this.ensureInit();
    const svc = await db.service.findUnique({ where: { id: payload.serviceId } });
    if (!svc) throw new HttpError(404, 'Service not found');
    if (!svc.enabled) throw new HttpError(409, `Service ${svc.name} is disabled`);

    // live mode never simulates. Chaos acts on real targets only
    // through the customer's opt-in hook (staging maintenance flags and the
    // like) — never by touching this process's simulation state.
    if (getConfig().mode === 'live') {
      await launchLiveChaos(svc);
      return db.chaosExperiment.findFirstOrThrow({
        where: { serviceId: svc.id },
        orderBy: { startedAt: 'desc' },
        include: { service: true },
      });
    }

    let rt = this.runtimes.get(svc.id);
    if (!rt) {
      // The service may have been created out-of-band after this engine
      // hydrated (e.g. the self-test target on first run) — reload
      // once so the fault can actually be forced. Still unknown → refuse.
      await this.reloadServices();
      rt = this.runtimes.get(svc.id);
    }
    if (!rt) {
      throw new HttpError(409, `Service ${svc.name} is not loaded in the simulation engine`);
    }
    if (rt?.activeIncidentId) {
      throw new HttpError(409, `An active incident is already running for ${svc.name}`);
    }
    const runningExp = await db.chaosExperiment.findFirst({
      where: { serviceId: svc.id, status: 'running' },
    });
    if (runningExp) {
      throw new HttpError(409, `A chaos experiment is already running for ${svc.name}`);
    }

    const experiment = await db.chaosExperiment.create({
      data: {
        serviceId: svc.id,
        type: payload.type,
        status: 'running',
        plannedDurationSec: payload.durationSec,
      },
    });
    if (rt) {
      rt.forcedUntil = Date.now() + payload.durationSec * 1000;
      rt.chaosType = payload.type;
      rt.chaosExperimentId = experiment.id;
    }
    console.log(`[sentinel] chaos ${payload.type} started on ${svc.key} for ${payload.durationSec}s`);
    return db.chaosExperiment.findUniqueOrThrow({
      where: { id: experiment.id },
      include: { service: true },
    });
  }

  // ── incidents ────────────────────────────────────────────────────────────
  /** On-call manual intervention. 404 unknown, 409 already resolved. */
  async resolveManually(incidentId: string): Promise<IncidentWithService> {
    await this.ensureInit();
    const rt = this.findRuntimeByIncident(incidentId);
    const now = Date.now();
    if (rt) {
      const current = await db.incident.findUnique({ where: { id: incidentId } });
      if (!current) throw new HttpError(404, 'Incident not found');
      if (current.status !== 'ongoing') throw new HttpError(409, 'Incident already resolved');
      // Flush a still-pending detection so MTTD is anchored (set detectedAt = now).
      if (rt.pendingDetection) {
        clearTimeout(rt.pendingDetection);
        rt.pendingDetection = null;
      }
      if (!current.detectedAt) await this.completeDetection(rt, incidentId, now);
      // End the fault immediately.
      rt.status = 'up';
      rt.currentSince = now;
      rt.incidentUntil = undefined;
      rt.plannedStatus = undefined;
      return this.resolveIncident(rt, incidentId, now, 'manual');
    }
    // Fallback: incident not tracked in memory (e.g. from a previous engine life).
    const incident = await db.incident.findUnique({
      where: { id: incidentId },
      include: { service: true },
    });
    if (!incident) throw new HttpError(404, 'Incident not found');
    if (incident.status !== 'ongoing') throw new HttpError(409, 'Incident already resolved');
    return this.resolveIncidentDbOnly(incident, now, 'manual');
  }

  /**
   * v2.5 — on-call takes ownership of an ongoing incident. Stamps
   * acknowledgedAt/by, computes MTTA (ack − detectedAt, fallback startedAt)
   * and appends the `acknowledged` timeline event. 404 unknown / 409 resolved
   * or already acknowledged.
   */
  async acknowledgeIncident(incidentId: string, by?: string): Promise<IncidentWithService> {
    await this.ensureInit();
    const now = Date.now();
    const current = await db.incident.findUnique({ where: { id: incidentId }, include: { service: true } });
    if (!current) throw new HttpError(404, 'Incident not found');
    if (current.status !== 'ongoing') throw new HttpError(409, 'Incident already resolved');
    if (current.acknowledgedAt) throw new HttpError(409, 'Incident already acknowledged');

    const handle = (by ?? '').trim() || 'On-call';
    // Flush a still-pending detection so MTTA is anchored to a real detection
    // time (same semantics as manual resolve). completeDetection rewrites the
    // row (detectedAt + events), so re-fetch afterwards.
    const rt = this.findRuntimeByIncident(incidentId);
    if (rt?.pendingDetection) {
      clearTimeout(rt.pendingDetection);
      rt.pendingDetection = null;
      await this.completeDetection(rt, incidentId, now);
      const fresh = await db.incident.findUnique({ where: { id: incidentId }, include: { service: true } });
      if (fresh) Object.assign(current, fresh);
    }

    const anchorMs = (current.detectedAt ?? current.startedAt).getTime();
    const mttaSec = Math.round(((now - anchorMs) / 1000) * 10) / 10;
    const events = parseEvents(current.events);
    events.push({ ts: new Date(now).toISOString(), event: 'acknowledged', detail: handle });

    const updated = await db.incident.update({
      where: { id: incidentId },
      data: {
        acknowledgedAt: new Date(now),
        acknowledgedBy: handle,
        mttaSec,
        events: JSON.stringify(events),
      },
      include: { service: true },
    });
    console.log(
      `[sentinel] acknowledged ${current.service.key} by ${handle} after ${mttaSec.toFixed(1)}s (MTTA)`,
    );
    return updated;
  }

  // ── dashboard ─────────────────────────────────────────────────────────────
  /**
   * Full live snapshot. `tenantId` null/undefined = fleet-wide; a tenant id
   * scopes services, KPIs, incidents, alerts and chaos experiments to that
   * tenant's services (unknown ids → 404). The `tenants` list is always the
   * unfiltered fleet (for the switcher).
   */
  async getDashboardSnapshot(tenantId?: string | null): Promise<DashboardDTO> {
    await this.ensureInit();

    let scopeIds: string[] | null = null;
    if (tenantId) {
      const tenant = await getTenantById(tenantId);
      if (!tenant) throw new HttpError(404, `Tenant '${tenantId}' not found`);
      scopeIds = await serviceIdsForTenant(tenantId);
      const known = new Set(scopeIds);
      const covered = [...this.runtimes.keys()].filter((id) => known.has(id)).length;
      if (covered !== scopeIds.length) {
        // a just-assigned service is not in the runtime cache yet — pick it up
        await this.reloadServices();
      }
    }
    const incidentScope = scopeIds ? { serviceId: { in: scopeIds } } : {};

    const [incidents, alerts, experiments, reports, incidentsTotal, activeIncidents, mttdAgg, mttrAgg, mttaAgg, escalatedAgg, tenants, maintenanceWindows, alertRules, channels, onCall, escalationPolicy, reportSchedules, scheduleRuns, outboxCounts] =
      await Promise.all([
        db.incident.findMany({
          where: { ...incidentScope },
          orderBy: { startedAt: 'desc' },
          take: 20,
          include: { service: true },
        }),
        db.alert.findMany({
          where: { ...incidentScope },
          orderBy: { sentAt: 'desc' },
          take: 25,
          include: { service: true },
        }),
        db.chaosExperiment.findMany({
          where: { ...incidentScope },
          orderBy: { startedAt: 'desc' },
          take: 10,
          include: { service: true },
        }),
        db.slaReport.findMany({ orderBy: { generatedAt: 'desc' }, take: 10 }),
        db.incident.count({ where: { ...incidentScope } }),
        db.incident.count({ where: { ...incidentScope, status: 'ongoing' } }),
        db.incident.aggregate({
          _avg: { mttdSec: true },
          where: { status: 'resolved', mttdSec: { not: null }, ...incidentScope },
        }),
        db.incident.aggregate({
          _avg: { mttrSec: true },
          where: { status: 'resolved', mttrSec: { not: null }, ...incidentScope },
        }),
        // v2.5 MTTA: valid the moment on-call acknowledges — no status filter.
        db.incident.aggregate({
          _avg: { mttaSec: true },
          where: { mttaSec: { not: null }, ...incidentScope },
        }),
        // v2.6: ongoing incidents currently sitting on the escalation ladder.
        db.incident.count({
          where: { status: 'ongoing', escalatedAt: { not: null }, ...incidentScope },
        }),
        listTenantRows(),
        // v2.1: fleet-wide windows are always in scope; service-scoped windows
        // only when their service belongs to the active tenant scope.
        listMaintenanceWindows(MAINTENANCE_DASHBOARD_LIMIT, tenantId ?? null),
        // v2.2: alert governance (rules/channels/on-call are fleet-level);
        // v2.3: rules are merged with the engine's live evaluation state after.
        listAlertRules(),
        listChannels(),
        listOnCall(),
        // v2.6: fleet escalation policy (seeds itself on first read).
        getEscalationPolicy(),
        // v2.4: cron-style report schedules (fleet-level list, like governance).
        listReportSchedules(),
        // v2.5: schedule firing audit trail (newest 8).
        listScheduleRuns(8),
        // notification outbox backlog + dead-letter counts.
        outboxStats(),
      ]);

    const scopedRuntimes =
      scopeIds === null
        ? [...this.runtimes.values()]
        : [...this.runtimes.values()].filter((rt) => scopeIds !== null && scopeIds.includes(rt.service.id));
    const services = scopedRuntimes.map((rt) => this.toServiceDTO(rt));

    let upTotal = 0;
    let downTotal = 0;
    let lostRevenue = 0;
    let penaltyExposure = 0;
    let lostTx = 0;
    let compliant = 0;
    for (const rt of scopedRuntimes) {
      upTotal += rt.uptimeMs;
      downTotal += rt.downtimeMs;
      lostRevenue += rt.revenueLossTomans;
      penaltyExposure += rt.penaltyTomans;
      lostTx += rt.lostTransactions;
      const total = rt.uptimeMs + rt.downtimeMs;
      const uptime = total > 0 ? rt.uptimeMs / total : 1;
      if (uptime >= rt.service.slaTarget) compliant += 1;
    }

    const kpis: KpiDTO = {
      fleetUptime: upTotal + downTotal > 0 ? upTotal / (upTotal + downTotal) : 1,
      activeIncidents,
      incidentsTotal,
      lostRevenueTomans: Math.round(lostRevenue),
      penaltyExposureTomans: Math.round(penaltyExposure),
      transactionsLost: Math.round(lostTx),
      avgMttdSec: mttdAgg._avg.mttdSec !== null ? Math.round(mttdAgg._avg.mttdSec * 10) / 10 : null,
      avgMttrSec: mttrAgg._avg.mttrSec !== null ? Math.round(mttrAgg._avg.mttrSec * 10) / 10 : null,
      avgMttaSec: mttaAgg._avg.mttaSec !== null ? Math.round(mttaAgg._avg.mttaSec * 10) / 10 : null,
      escalatedIncidents: escalatedAgg,
      slaCompliantServices: compliant,
      totalServices: scopedRuntimes.length,
      lastIncidentAt: incidents.length > 0 ? incidents[0].startedAt.toISOString() : null,
      outboxDepth: outboxCounts.depth,
      outboxDead: outboxCounts.dead,
    };

    return {
      engine: this.getEngineState(),
      kpis,
      tenants: tenants.map(toTenantDTO),
      tenantScope: tenantId ?? null,
      services,
      incidents: incidents.map(toIncidentDTO),
      alerts: alerts.map(toAlertDTO),
      chaosExperiments: experiments.map(toChaosDTO),
      reports: reports.map(toReportDTO),
      maintenanceWindows,
      alertRules: this.mergeRuleState(alertRules),
      channels,
      onCall,
      escalationPolicy,
      reportSchedules,
      scheduleRuns,
      serverTime: new Date().toISOString(),
    };
  }

  /** Merge the engine's live rule-evaluation state into rule DTOs (v2.3). */
  private mergeRuleState(rules: Awaited<ReturnType<typeof listAlertRules>>): AlertRuleDTO[] {
    return rules.map((r) => {
      const st = this.ruleState.get(r.id);
      if (!st || !r.enabled) {
        return { ...r, violatedNow: false, measuredValue: null, violatedServiceName: null };
      }
      return {
        ...r,
        violatedNow: st.violated,
        measuredValue: st.measured,
        violatedServiceName: st.serviceName,
      };
    });
  }

  // ── private: v2.2 policy-rule evaluation ──────────────────────────────
  /**
   * Evaluate enabled alert rules against live service metrics. A firing rule
   * writes Alert rows for its audience (bilingual title), routes delivery
   * counters through matching channels, respects per-rule cooldown, and honors
   * active maintenance windows (policy pages are suppressed during planned
   * work — the SLA record itself is never touched by rules).
   */
  private async evaluateAlertRules(now: number): Promise<void> {
    let rules;
    try {
      rules = await listEnabledRules();
    } catch {
      return; // table may not exist yet on a fresh database (db push pending)
    }

    // v2.3: prune live state for rules that disappeared or were disabled.
    const liveIds = new Set(rules.map((r) => r.id));
    for (const id of this.ruleState.keys()) {
      if (!liveIds.has(id)) this.ruleState.delete(id);
    }
    if (rules.length === 0) return;

    for (const rule of rules) {
      const targets = rule.serviceId
        ? [this.runtimes.get(rule.serviceId)].filter((r): r is ServiceRuntime => !!r)
        : [...this.runtimes.values()];

      // v2.3: track the WORST violating measurement across targets (min for
      // 'lt', max for 'gt') — the live chip shows it even during cooldown.
      let worst: { value: number; rt: ServiceRuntime } | null = null;
      for (const rt of targets) {
        if (!rt.service.enabled) continue;
        const value = this.ruleMetricValue(rt, rule.metric);
        if (value === null) continue;
        const violated = rule.operator === 'lt' ? value < rule.threshold : value > rule.threshold;
        if (!violated) continue;
        if (
          !worst ||
          (rule.operator === 'lt' ? value < worst.value : value > worst.value)
        ) {
          worst = { value, rt };
        }
      }

      const prev = this.ruleState.get(rule.id);
      this.ruleState.set(rule.id, {
        violated: worst !== null,
        measured: worst ? worst.value : prev?.measured ?? null,
        serviceId: worst ? worst.rt.service.id : prev?.serviceId ?? null,
        serviceName: worst ? worst.rt.service.name : prev?.serviceName ?? null,
        since: worst ? (prev?.violated ? prev.since : now) : prev?.since ?? now,
      });

      if (!worst) continue;
      const rt = worst.rt;
      const value = worst.value;

      // per-rule cooldown: one page per window, not one per tick
      if (rule.lastFiredAt) {
        const since = now - new Date(rule.lastFiredAt).getTime();
        if (since < rule.cooldownMin * 60_000) continue;
      }

      // maintenance windows suppress policy pages for covered services
      const windows = await activeWindowsForService(rt.service.id);
      if (windows.length > 0) {
        await incrementSuppressedAlerts(windows.map((w) => w.id), 1);
        continue;
      }

      await this.fireRuleAlert(rt, rule, value);
      await markRuleFired(rule.id);
      // (channel counters are dispatcher-owned — outbox)
    }
  }

  /** Live metric value for rule evaluation (rolling mean over the series). */
  private ruleMetricValue(rt: ServiceRuntime, metric: string): number | null {
    const s = rt.series;
    const n = s.ts.length;
    if (n === 0) return null;
    const mean = (arr: number[]): number => arr.reduce((a, b) => a + b, 0) / arr.length;
    switch (metric) {
      case 'uptime':
        return mean(s.status);
      case 'errorRate':
        return mean(s.errorRate);
      case 'latencyMs':
        return mean(s.latencyMs);
      case 'throughput':
        return mean(s.throughput);
      default:
        return null;
    }
  }

  /** Write the Alert row(s) for a fired rule (one per audience channel). */
  private async fireRuleAlert(rt: ServiceRuntime, rule: AlertRuleDTO, value: number): Promise<void> {
    const svc = rt.service;
    const pretty =
      rule.metric === 'uptime'
        ? (value * 100).toFixed(3) + '%'
        : rule.metric === 'errorRate'
          ? (value * 100).toFixed(2) + '%'
          : Math.round(value).toLocaleString('en-US');
    const thresholdPretty =
      rule.metric === 'uptime'
        ? (rule.threshold * 100).toFixed(3) + '%'
        : rule.metric === 'errorRate'
          ? (rule.threshold * 100).toFixed(2) + '%'
          : Math.round(rule.threshold).toLocaleString('en-US');

    const audiences: Array<'technical' | 'executive'> =
      rule.audience === 'both' ? ['technical', 'executive'] : [rule.audience as 'technical' | 'executive'];
    await emitNotification({
      topic: 'rule',
      severity: rule.severity === 'critical' ? 'critical' : 'warning',
      audiences,
      vars: {
        ruleName: rule.name,
        metric: rule.metric,
        operator: rule.operator === 'lt' ? '<' : '>',
        threshold: thresholdPretty,
        measuredValue: pretty,
        serviceName: svc.name,
        serviceKey: svc.key,
        severity: rule.severity,
      },
      serviceId: svc.id,
      serviceName: svc.name,
      ruleId: rule.id,
      quiet:
        rule.quietStartMin !== null && rule.quietStartMin !== undefined && rule.quietEndMin !== null && rule.quietEndMin !== undefined
          ? { startMin: rule.quietStartMin, endMin: rule.quietEndMin }
          : null,
    });
  }

  // ── private: v2.6 escalation ladder ───────────────────────────────────
  /**
   * Page the secondary on-call for every DETECTED-but-unacknowledged
   * incident that outlived the policy timeout (Slack/PagerDuty-style ladder):
   * primary is paged at detection; if nobody acknowledges within timeoutMin,
   * the secondary gets an urgent page and management is informed. Escalation
   * fires ONCE per incident (escalatedAt guard) and is suppressed during
   * covering maintenance windows (planned work — humans already know), while
   * the SLA record itself is never altered. Acknowledging (v2.5) is the only
   * way to stop the ladder — that is the point of an MTTA discipline.
   */
  private async checkEscalations(now: number): Promise<void> {
    let policy: EscalationPolicyDTO;
    try {
      policy = await getEscalationPolicy(); // cheap SELECT; self-heals after PUT
    } catch {
      return; // table may not exist yet on a fresh database (db push pending)
    }
    this.escalationPolicy = policy;
    if (!policy.enabled) return;

    const candidates = await db.incident.findMany({
      where: {
        status: 'ongoing',
        detectedAt: { not: null },
        acknowledgedAt: null,
        escalatedAt: null,
        ...(policy.appliesTo === 'critical' ? { severity: 'critical' } : {}),
      },
      include: { service: true },
    });
    if (candidates.length === 0) return;

    const timeoutMs = policy.timeoutMin * 60_000;
    const onCall = await listOnCall();
    const active = onCall.filter((o) => o.active);

    for (const inc of candidates) {
      const detectedMs = (inc.detectedAt ?? inc.startedAt).getTime();
      const unackedSec = (now - detectedMs) / 1000;
      if (now - detectedMs < timeoutMs) continue;

      // maintenance windows suppress escalation pages for covered services
      const windows = await activeWindowsForService(inc.serviceId);
      if (windows.length > 0) {
        await incrementSuppressedAlerts(windows.map((w) => w.id), 1);
        continue;
      }

      // Ladder target: secondary → manager → any active non-primary → gap.
      const secondary =
        active.find((o) => /secondary|پشتیبان/i.test(o.role)) ??
        active.find((o) => /manager|مدیر/i.test(o.role)) ??
        active.find((o) => !/primary|اصلی/i.test(o.role)) ??
        null;
      const nobody = secondary === null;

      const events = parseEvents(inc.events);
      events.push({
        ts: new Date(now).toISOString(),
        event: 'escalated',
        detail: nobody
          ? 'escalation gap — nobody on duty'
          : `${secondary.engineerName} ${secondary.handle}`,
      });

      await db.incident.update({
        where: { id: inc.id },
        data: {
          escalatedAt: new Date(now),
          escalatedTo: nobody ? 'nobody on duty' : `${secondary.engineerName} (${secondary.handle})`,
          events: JSON.stringify(events),
        },
      });

      await fireEscalationAlerts(
        {
          incidentId: inc.id,
          serviceId: inc.serviceId,
          serviceName: inc.service.name,
          serviceKey: inc.service.key,
          endpoint: inc.service.endpoint,
          severity: inc.severity as IncidentSeverity,
          startedAt: inc.startedAt,
          tps: inc.service.tps,
          avgTransactionValue: inc.service.avgTransactionValue,
          penaltyBase: inc.service.penaltyBase,
          penaltyPerMinute: inc.service.penaltyPerMinute,
        },
        {
          unackedSec,
          timeoutMin: policy.timeoutMin,
          secondaryName: secondary?.engineerName ?? '—',
          secondaryHandle: secondary?.handle ?? '—',
          nobodyOnDuty: nobody,
        },
      );
      // Escalation touches both audiences: urgent page + management memo.
      // (Channel counters are now dispatcher-owned — outbox.)
      await markPolicyEscalated(policy.id);
      console.log(
        `[sentinel] escalated ${inc.service.key} after ${unackedSec.toFixed(0)}s unacknowledged → ${
          nobody ? 'NOBODY ON DUTY' : `${secondary.engineerName} ${secondary.handle}`
        }`,
      );
    }
  }

  // ── private: tick loop ───────────────────────────────────────────────────
  private async tick(): Promise<void> {
    if (this.ticking || !this.running) return;
    this.ticking = true;
    try {
      this.tickCount += 1;
      const now = Date.now();

      if (this.tickCount - this.lastServiceReloadTick >= SERVICE_RELOAD_EVERY_TICKS) {
        this.lastServiceReloadTick = this.tickCount;
        await this.reloadServices();
      }

      // v2.1: expire maintenance windows whose endAt has passed (cheap,
      // idempotent UPDATE — also runs lazily inside listMaintenanceWindows).
      await expireDueWindows();

      // v2.2: evaluate user-defined policy rules (uptime/error/latency/throughput
      // thresholds with per-rule cooldown) against live metrics.
      if (this.tickCount % RULE_EVAL_EVERY_TICKS === 0) {
        await this.evaluateAlertRules(now);
      }

      // v2.6: escalation ladder — page the secondary when detected incidents
      // outlive the policy timeout unacknowledged.
      if (this.tickCount % ESCALATION_CHECK_EVERY_TICKS === 0) {
        await this.checkEscalations(now);
      }

      // v2.4: fire cron-style report schedules whose due instant passed since
      // their last run (~60s cadence; missed slots catch up exactly once).
      if (this.tickCount % SCHEDULE_CHECK_EVERY_TICKS === 0) {
        await runDueReportSchedules(new Date(now));
        // executive digest fires from the same ~60s cadence, its own
        // advisory lock and catch-up-once semantics.
        await runDueDigests(new Date(now));
      }

      if (this.autoChaos && this.nextAutoChaosAt !== null && now >= this.nextAutoChaosAt) {
        await this.runAutoChaos(now);
      }

      for (const rt of this.runtimes.values()) {
        if (!rt.service.enabled) continue;
        await this.tickService(rt, now);
      }

      if (this.tickCount % SNAPSHOT_EVERY_TICKS === 0) await this.persistSnapshots(now);
      if (now - this.lastPruneAt > PRUNE_EVERY_MS) {
        this.lastPruneAt = now;
        await this.pruneSnapshots(now);
      }
    } catch (err) {
      console.error('[sentinel] tick error:', err);
    } finally {
      this.ticking = false;
    }
  }

  private async tickService(rt: ServiceRuntime, now: number): Promise<void> {
    const prevStatus = rt.status;
    const status = this.effectiveStatus(rt, now);

    if (status !== prevStatus) {
      rt.currentSince = now;
      if (prevStatus === 'up' && status !== 'up') {
        // fault begins here
        rt.faultSource = rt.forcedUntil !== undefined && now < rt.forcedUntil ? 'chaos' : 'spontaneous';
        rt.windowLostTx = 0;
        rt.windowRevenueLoss = 0;
      }
      rt.status = status;
    }

    // metrics for this tick
    const m = this.computeMetrics(rt, status, now);
    rt.latencyMs = m.latencyMs;
    rt.errorRate = m.errorRate;
    rt.throughput = m.throughput;
    this.pushSeries(rt, now, m);

    // uptime accounting (degraded counts half up / half down — matches 0.5 encoding)
    if (status === 'up') {
      rt.uptimeMs += TICK_MS;
    } else if (status === 'degraded') {
      rt.uptimeMs += TICK_MS / 2;
      rt.downtimeMs += TICK_MS / 2;
    } else {
      rt.downtimeMs += TICK_MS;
    }

    // financial accrual while the fault is active
    if (status !== 'up') this.accrueLoss(rt, status);

    // probe / detection pipeline
    if (status === 'down') {
      rt.probeFailStreak += 1;
      rt.probeDegradedStreak = 0;
      if (rt.probeFailStreak >= DOWN_PROBE_THRESHOLD && !rt.activeIncidentId) {
        await this.detectIncident(rt, now, 'critical');
      }
    } else if (status === 'degraded') {
      rt.probeDegradedStreak += 1;
      rt.probeFailStreak = 0;
      if (rt.probeDegradedStreak >= DEGRADED_PROBE_THRESHOLD && !rt.activeIncidentId) {
        await this.detectIncident(rt, now, 'warning');
      }
    } else {
      rt.probeFailStreak = 0;
      rt.probeDegradedStreak = 0;
      if (prevStatus !== 'up') await this.handleRecovery(rt, now);
    }
  }

  /** Chaos forcing > spontaneous window > probabilistic rolls. */
  private effectiveStatus(rt: ServiceRuntime, now: number): ServiceStatus {
    if (rt.forcedUntil !== undefined) {
      if (now < rt.forcedUntil) {
        return rt.chaosType === 'outage' ? 'down' : 'degraded';
      }
      rt.forcedUntil = undefined; // window elapsed → recovery this tick
      return 'up';
    }
    if (rt.incidentUntil !== undefined) {
      if (now < rt.incidentUntil) return rt.plannedStatus ?? 'up';
      rt.incidentUntil = undefined; // spontaneous window elapsed → recovery
      return 'up';
    }
    return this.rollSpontaneous(rt, now);
  }

  private rollSpontaneous(rt: ServiceRuntime, now: number): ServiceStatus {
    // The self-test synthetic target is never faulted by chance — the only
    // outages it ever sees are the self-test's own injections, so MTTD stays
    // a deterministic measurement of the detection pipeline.
    if (rt.service.key === SELFTEST_SERVICE_KEY) return 'up';
    const mult = MODE_MULTIPLIER[this.mode];
    if (Math.random() < P_DOWN * mult) {
      rt.incidentUntil = now + (35 + Math.random() * 60) * 1000; // 35–95s
      rt.plannedStatus = 'down';
      return 'down';
    }
    if (Math.random() < P_DEGRADED * mult) {
      rt.incidentUntil = now + (60 + Math.random() * 140) * 1000; // 60–200s
      rt.plannedStatus = 'degraded';
      return 'degraded';
    }
    return 'up';
  }

  private computeMetrics(
    rt: ServiceRuntime,
    status: ServiceStatus,
    now: number,
  ): { latencyMs: number; errorRate: number; throughput: number } {
    const svc = rt.service;
    if (status === 'down') {
      return { latencyMs: 3000, errorRate: 1, throughput: 0 };
    }
    const chaosActive = rt.forcedUntil !== undefined && now < rt.forcedUntil;
    if (status === 'degraded') {
      const latencyMult =
        chaosActive && rt.chaosType === 'latency' ? 10 : 4 + Math.random() * 4; // ×4–8, chaos-latency ×10
      const errorRate =
        chaosActive && rt.chaosType === 'error-spike' ? 0.65 : 0.05 + Math.random() * 0.2;
      return {
        latencyMs: svc.baseLatencyMs * (1 + jitter() * 0.15) * latencyMult,
        errorRate,
        throughput: this.baseThroughput(rt, now) * (0.6 + Math.random() * 0.15),
      };
    }
    return {
      latencyMs: svc.baseLatencyMs * (1 + jitter() * 0.15),
      errorRate: Math.max(0, 0.002 + jitter() * 0.0015),
      throughput: this.baseThroughput(rt, now),
    };
  }

  private baseThroughput(rt: ServiceRuntime, now: number): number {
    return (
      rt.service.tps *
      (0.9 + Math.random() * 0.2) * // ±10%
      (1 + 0.06 * Math.sin(now / 45000 + rt.phase)) // slow sinusoidal drift
    );
  }

  private pushSeries(
    rt: ServiceRuntime,
    ts: number,
    m: { latencyMs: number; errorRate: number; throughput: number },
  ): void {
    const s = rt.series;
    s.ts.push(ts);
    s.latencyMs.push(m.latencyMs);
    s.errorRate.push(m.errorRate);
    s.throughput.push(m.throughput);
    s.status.push(rt.status === 'up' ? 1 : rt.status === 'degraded' ? 0.5 : 0);
    if (s.ts.length > SERIES_CAP) {
      s.ts.shift();
      s.latencyMs.shift();
      s.errorRate.shift();
      s.throughput.shift();
      s.status.shift();
    }
  }

  private accrueLoss(rt: ServiceRuntime, status: ServiceStatus): void {
    const svc = rt.service;
    if (status === 'down') {
      const lost = svc.tps * TICK_SEC;
      rt.windowLostTx += lost;
      rt.windowRevenueLoss += lost * svc.avgTransactionValue;
    } else if (status === 'degraded') {
      // partial loss = (1 − throughput ratio) × tps; ratio ≈ 0.675 → factor ≈ 0.325
      const ratio = svc.tps > 0 ? Math.min(1, Math.max(0, rt.throughput / svc.tps)) : 0;
      const lost = (1 - ratio) * svc.tps * TICK_SEC;
      rt.windowLostTx += lost;
      rt.windowRevenueLoss += lost * svc.avgTransactionValue;
    }
  }

  // ── private: detection pipeline ─────────────────────────────────────────
  private async detectIncident(rt: ServiceRuntime, now: number, severity: IncidentSeverity): Promise<void> {
    const svc = rt.service;
    const source = rt.faultSource === 'chaos' ? 'chaos' : 'spontaneous';
    const events: IncidentEvent[] = [
      { ts: new Date(rt.currentSince).toISOString(), event: 'fault_started' },
      {
        ts: new Date(now).toISOString(),
        event: 'probe_failed',
        detail: severity === 'critical' ? `streak ${DOWN_PROBE_THRESHOLD}/${DOWN_PROBE_THRESHOLD}` : `streak ${DEGRADED_PROBE_THRESHOLD}/${DEGRADED_PROBE_THRESHOLD}`,
      },
    ];
    const incident = await db.incident.create({
      data: {
        serviceId: svc.id,
        status: 'ongoing',
        severity,
        source,
        startedAt: new Date(rt.currentSince),
        chaosExperimentId: rt.chaosExperimentId ?? null,
        events: JSON.stringify(events),
      },
    });
    rt.activeIncidentId = incident.id;
    rt.detectedIncident = null;

    // Alertmanager pipeline delay: 1.5–6s until detectedAt is stamped & alerts fire.
    const delayMs = DETECTION_DELAY_MIN_MS + Math.random() * (DETECTION_DELAY_MAX_MS - DETECTION_DELAY_MIN_MS);
    if (rt.pendingDetection) clearTimeout(rt.pendingDetection);
    rt.pendingDetection = setTimeout(() => {
      rt.pendingDetection = null;
      void this.completeDetection(rt, incident.id).catch((err) =>
        console.error('[sentinel] detection failed:', err),
      );
    }, delayMs);
  }

  /** Stamp detectedAt, fire the two detection alerts. `atMs` forces the timestamp (manual flush). */
  private async completeDetection(
    rt: ServiceRuntime | null,
    incidentId: string,
    atMs?: number,
  ): Promise<void> {
    const now = atMs ?? Date.now();
    const incident = await db.incident.findUnique({
      where: { id: incidentId },
      include: { service: true },
    });
    if (!incident || incident.status !== 'ongoing') return;
    const svc = incident.service;

    const events = parseEvents(incident.events);
    events.push({ ts: new Date(now).toISOString(), event: 'detected' });
    // v2.1 maintenance windows: if an active window covers the service, the
    // tech+exec detection pair is NOT delivered — the counter is bumped on
    // each covering window and the timeline records the suppression. The
    // incident itself is still recorded (SLA truth is never altered).
    const covering = await activeWindowsForService(svc.id);
    if (covering.length > 0) {
      events.push({
        ts: new Date(now).toISOString(),
        event: 'alerts_suppressed',
        detail: `maintenance window: ${covering.map((w) => w.reason).join('; ')}`,
      });
    }
    await db.incident.update({
      where: { id: incidentId },
      data: { detectedAt: new Date(now), events: JSON.stringify(events) },
    });
    if (rt && rt.activeIncidentId === incidentId) {
      rt.detectedIncident = { id: incidentId, detectedAt: now };
    }

    if (covering.length > 0) {
      await incrementSuppressedAlerts(
        covering.map((w) => w.id),
        SUPPRESSED_PER_PAIR,
      );
      console.log(
        `[sentinel] detection alerts suppressed for ${svc.key} — ${covering.length} active maintenance window(s)`,
      );
    } else {
      await fireDetectionAlerts(
        {
          incidentId,
          serviceId: svc.id,
          serviceName: svc.name,
          serviceKey: svc.key,
          endpoint: svc.endpoint,
          severity: incident.severity === 'warning' ? 'warning' : 'critical',
          startedAt: incident.startedAt,
          tps: svc.tps,
          avgTransactionValue: svc.avgTransactionValue,
          penaltyBase: svc.penaltyBase,
          penaltyPerMinute: svc.penaltyPerMinute,
        },
        { latencyMs: rt?.latencyMs, errorRate: rt?.errorRate },
      );
    }

    const mttd = (now - incident.startedAt.getTime()) / 1000;
    console.log(
      `[sentinel] detected ${svc.key} ${incident.severity} after ${mttd.toFixed(1)}s (source ${incident.source})`,
    );
  }

  // ── private: recovery / resolution ───────────────────────────────────────
  private async handleRecovery(rt: ServiceRuntime, now: number): Promise<void> {
    rt.probeFailStreak = 0;
    rt.probeDegradedStreak = 0;
    rt.incidentUntil = undefined;
    rt.plannedStatus = undefined;
    const incidentId = rt.activeIncidentId;
    if (!incidentId) {
      rt.faultSource = undefined;
      return;
    }
    if (rt.pendingDetection) {
      // Fault ended within the alert-pipeline delay — flush detection first.
      clearTimeout(rt.pendingDetection);
      rt.pendingDetection = null;
      await this.completeDetection(rt, incidentId, now);
    }
    await this.resolveIncident(rt, incidentId, now, 'auto');
  }

  /**
   * Penalty for one resolved incident.
   * Delegates to the pure domain rule (`penaltyFixedPerMinute`, see
   * docs/DOMAIN.md §3): ceil-to-minute with a 1-minute minimum, one
   * half-even rounding, warning severity weighted 30 %. The legacy float
   * fallback stays only for demo services authored with fractional amounts;
   * the schema migration to integer Rials removes it.
   */
  private computePenalty(svc: Service, severity: string, durationSec: number): number {
    const { penaltyBase, penaltyPerMinute } = svc;
    if (
      Number.isSafeInteger(penaltyBase) && penaltyBase >= 0 &&
      Number.isSafeInteger(penaltyPerMinute) && penaltyPerMinute >= 0
    ) {
      const seconds = Math.max(0, Math.round(durationSec));
      return penaltyFixedPerMinute(penaltyBase, penaltyPerMinute, seconds, severity === 'warning' ? 30 : 100);
    }
    const minutes = Math.max(1, Math.ceil(durationSec / 60));
    const full = penaltyBase + penaltyPerMinute * minutes;
    return severity === 'warning' ? 0.3 * full : full;
  }

  private async resolveIncident(
    rt: ServiceRuntime,
    incidentId: string,
    now: number,
    method: 'auto' | 'manual',
  ): Promise<IncidentWithService> {
    const incident = await db.incident.findUnique({
      where: { id: incidentId },
      include: { service: true },
    });
    if (!incident) throw new HttpError(404, 'Incident not found');

    if (incident.status === 'ongoing') {
      const startedAtMs = incident.startedAt.getTime();
      const detectedMs = incident.detectedAt ? incident.detectedAt.getTime() : null;
      const mttdSec = detectedMs !== null ? Math.round(((detectedMs - startedAtMs) / 1000) * 10) / 10 : null;
      const mttrSec = Math.round(((now - startedAtMs) / 1000) * 10) / 10;
      const durationSec = mttrSec;
      const svc = rt.service;
      const penalty = this.computePenalty(svc, incident.severity, durationSec);
      const lostTx = Math.round(rt.windowLostTx);
      const revenueLoss = Math.round(rt.windowRevenueLoss);

      const events = parseEvents(incident.events);
      events.push({ ts: new Date(now).toISOString(), event: 'resolved', detail: method });
      // v2.1: recovery alerts are suppressed too while a maintenance window
      // covers the service ("alert delivery is suppressed") — the pair's
      // deliveries are counted on each covering window and the timeline
      // records the suppression.
      const covering = await activeWindowsForService(svc.id);
      if (covering.length > 0) {
        events.push({
          ts: new Date(now).toISOString(),
          event: 'alerts_suppressed',
          detail: `maintenance window: ${covering.map((w) => w.reason).join('; ')}`,
        });
      }

      // updateMany with status guard → atomic resolve (no double-count on races)
      const res = await db.incident.updateMany({
        where: { id: incidentId, status: 'ongoing' },
        data: {
          status: 'resolved',
          resolvedAt: new Date(now),
          mttdSec,
          mttrSec,
          durationSec,
          lostTransactions: lostTx,
          revenueLossTomans: revenueLoss,
          penaltyTomans: penalty,
          events: JSON.stringify(events),
        },
      });

      if (res.count > 0) {
        rt.revenueLossTomans += revenueLoss;
        rt.lostTransactions += lostTx;
        rt.penaltyTomans += penalty;
        rt.incidentsCount += 1;

        if (covering.length > 0) {
          await incrementSuppressedAlerts(
            covering.map((w) => w.id),
            SUPPRESSED_PER_PAIR,
          );
          console.log(
            `[sentinel] recovery alerts suppressed for ${svc.key} — ${covering.length} active maintenance window(s)`,
          );
        } else {
          await fireRecoveryAlerts(
            {
              incidentId,
              serviceId: svc.id,
              serviceName: svc.name,
              serviceKey: svc.key,
              endpoint: svc.endpoint,
              severity: incident.severity === 'warning' ? 'warning' : 'critical',
              startedAt: incident.startedAt,
              tps: svc.tps,
              avgTransactionValue: svc.avgTransactionValue,
              penaltyBase: svc.penaltyBase,
              penaltyPerMinute: svc.penaltyPerMinute,
            },
            {
              mttdSec,
              mttrSec,
              lostTransactions: lostTx,
              revenueLossTomans: revenueLoss,
              penaltyTomans: penalty,
            },
          );
        }

        if (rt.chaosExperimentId) {
          await this.finalizeExperiment(rt.chaosExperimentId, mttdSec, mttrSec, now);
        }

        console.log(
          `[sentinel] resolved ${svc.key} (${method}) after ${mttrSec}s — lost ${lostTx} tx, penalty ${Math.round(penalty).toLocaleString('en-US')} T`,
        );
      }
    }

    // runtime cleanup (runs even if another path won the resolve race)
    rt.activeIncidentId = undefined;
    rt.detectedIncident = null;
    rt.pendingDetection = null;
    rt.windowLostTx = 0;
    rt.windowRevenueLoss = 0;
    rt.faultSource = undefined;
    rt.chaosExperimentId = undefined;
    rt.chaosType = undefined;
    rt.forcedUntil = undefined;

    return db.incident.findUniqueOrThrow({
      where: { id: incidentId },
      include: { service: true },
    });
  }

  /** DB-only resolution for incidents with no live runtime (manual fallback / restart reconcile). */
  private async resolveIncidentDbOnly(
    incident: IncidentWithService,
    now: number,
    method: 'manual' | 'reconciled',
  ): Promise<IncidentWithService> {
    const startedAtMs = incident.startedAt.getTime();
    const detectedMs = incident.detectedAt ? incident.detectedAt.getTime() : now;
    const mttdSec = Math.round(((detectedMs - startedAtMs) / 1000) * 10) / 10;
    const mttrSec = Math.round(((now - startedAtMs) / 1000) * 10) / 10;
    const factor = incident.severity === 'warning' ? 0.325 : 1;
    const lostTx = Math.round(incident.service.tps * mttrSec * factor);
    const revenueLoss = Math.round(lostTx * incident.service.avgTransactionValue);
    const penalty = this.computePenalty(incident.service, incident.severity, mttrSec);

    const events = parseEvents(incident.events);
    events.push({ ts: new Date(now).toISOString(), event: 'resolved', detail: method });
    // v2.1: recovery alerts suppressed while a maintenance window covers the
    // service (same rule as the detection pair — see resolveIncident).
    const covering = await activeWindowsForService(incident.service.id);
    if (covering.length > 0) {
      events.push({
        ts: new Date(now).toISOString(),
        event: 'alerts_suppressed',
        detail: `maintenance window: ${covering.map((w) => w.reason).join('; ')}`,
      });
    }

    await db.incident.updateMany({
      where: { id: incident.id, status: 'ongoing' },
      data: {
        status: 'resolved',
        resolvedAt: new Date(now),
        detectedAt: incident.detectedAt ?? new Date(detectedMs),
        mttdSec,
        mttrSec,
        durationSec: mttrSec,
        lostTransactions: lostTx,
        revenueLossTomans: revenueLoss,
        penaltyTomans: penalty,
        events: JSON.stringify(events),
      },
    });

    if (covering.length > 0) {
      await incrementSuppressedAlerts(
        covering.map((w) => w.id),
        SUPPRESSED_PER_PAIR,
      );
      console.log(
        `[sentinel] recovery alerts suppressed for ${incident.service.key} — ${covering.length} active maintenance window(s)`,
      );
    } else {
      await fireRecoveryAlerts(
        {
          incidentId: incident.id,
          serviceId: incident.service.id,
          serviceName: incident.service.name,
          serviceKey: incident.service.key,
          endpoint: incident.service.endpoint,
          severity: incident.severity === 'warning' ? 'warning' : 'critical',
          startedAt: incident.startedAt,
          tps: incident.service.tps,
          avgTransactionValue: incident.service.avgTransactionValue,
          penaltyBase: incident.service.penaltyBase,
          penaltyPerMinute: incident.service.penaltyPerMinute,
        },
        {
          mttdSec,
          mttrSec,
          lostTransactions: lostTx,
          revenueLossTomans: revenueLoss,
          penaltyTomans: penalty,
        },
      );
    }

    if (incident.chaosExperimentId) {
      await this.finalizeExperiment(incident.chaosExperimentId, mttdSec, mttrSec, now);
    }

    return db.incident.findUniqueOrThrow({
      where: { id: incident.id },
      include: { service: true },
    });
  }

  private async finalizeExperiment(
    experimentId: string,
    mttdSec: number | null,
    mttrSec: number | null,
    now: number,
  ): Promise<void> {
    const experiment = await db.chaosExperiment.findUnique({
      where: { id: experimentId },
      include: { service: true },
    });
    if (!experiment || experiment.status !== 'running') return;
    const passed = mttdSec !== null && mttdSec < MTTD_GATE_SEC;
    await db.chaosExperiment.update({
      where: { id: experimentId },
      data: {
        status: passed ? 'passed' : 'failed',
        gatePassed: passed,
        mttdSec,
        mttrSec,
        endedAt: new Date(now),
      },
    });
    this.lastChaosResult = `${experiment.type} on ${experiment.service.key} — MTTD ${
      mttdSec === null ? 'n/a' : `${mttdSec.toFixed(1)}s`
    }, gate ${passed ? 'PASSED' : 'FAILED'}`;
    console.log(
      `[sentinel] chaos ${experiment.type} on ${experiment.service.key} finished — ${
        passed ? 'passed' : 'failed'
      } (MTTD ${mttdSec === null ? 'n/a' : `${mttdSec.toFixed(1)}s`}, MTTR ${mttrSec === null ? 'n/a' : `${mttrSec.toFixed(1)}s`})`,
    );
  }

  // ── private: maintenance ─────────────────────────────────────────────────
  private async runAutoChaos(now: number): Promise<void> {
    // automatic chaos exists to exercise the SIMULATION. In live
    // mode it would page customers' staging hooks at random — never allowed.
    if (getConfig().mode === 'live') {
      this.nextAutoChaosAt = null;
      return;
    }
    this.nextAutoChaosAt = now + this.autoChaosIntervalMin * 60_000;
    const candidates = [...this.runtimes.values()].filter(
      (rt) =>
        rt.service.enabled &&
        !rt.activeIncidentId &&
        !rt.chaosExperimentId &&
        // the self-test target is only ever faulted by the self-test
        rt.service.key !== SELFTEST_SERVICE_KEY,
    );
    if (candidates.length === 0) return;
    const rt = candidates[Math.floor(Math.random() * candidates.length)];
    try {
      await this.launchChaos({
        serviceId: rt.service.id,
        type: 'outage',
        durationSec: AUTO_CHAOS_DURATION_SEC,
      });
    } catch (err) {
      console.warn('[sentinel] auto-chaos skipped:', err instanceof Error ? err.message : err);
    }
  }

  private async persistSnapshots(now: number): Promise<void> {
    const buildRows = () =>
      [...this.runtimes.values()]
        .filter((rt) => rt.service.enabled)
        .map((rt) => ({
          serviceId: rt.service.id,
          ts: new Date(now),
          status: rt.status,
          latencyMs: rt.latencyMs,
          errorRate: rt.errorRate,
          throughput: rt.throughput,
        }));
    let rows = buildRows();
    if (rows.length === 0) return;
    try {
      await db.metricSnapshot.createMany({ data: rows });
    } catch {
      // A cached service may have been removed out-of-band (FK violation) —
      // refresh the config cache and retry once with the surviving services.
      await this.reloadServices();
      rows = buildRows();
      if (rows.length > 0) {
        await db.metricSnapshot.createMany({ data: rows }).catch((err) =>
          console.error('[sentinel] snapshot persist failed:', err),
        );
      }
    }
  }

  private async pruneSnapshots(now: number): Promise<void> {
    await db.metricSnapshot.deleteMany({
      where: { ts: { lt: new Date(now - SNAPSHOT_TTL_MS) } },
    });
  }

  /** Resolve ongoing incidents / running experiments orphaned by a previous engine life. */
  private async reconcileStaleState(): Promise<void> {
    const ongoing = await db.incident.findMany({
      where: { status: 'ongoing' },
      include: { service: true },
    });
    let reconciled = 0;
    for (const inc of ongoing) {
      if (this.findRuntimeByIncident(inc.id)) continue; // live
      try {
        await this.resolveIncidentDbOnly(inc, Date.now(), 'reconciled');
        reconciled += 1;
      } catch (err) {
        console.error('[sentinel] reconcile failed for incident', inc.id, err);
      }
    }
    const aborted = await db.chaosExperiment.updateMany({
      where: { status: 'running' },
      data: { status: 'aborted', endedAt: new Date() },
    });
    if (reconciled > 0 || aborted.count > 0) {
      console.log(
        `[sentinel] reconciled ${reconciled} stale incidents, aborted ${aborted.count} stale experiments`,
      );
    }
  }

  private async hydrateAggregates(): Promise<void> {
    const groups = await db.incident.groupBy({
      by: ['serviceId'],
      where: { status: 'resolved' },
      _sum: { lostTransactions: true, revenueLossTomans: true, penaltyTomans: true },
      _count: { _all: true },
    });
    for (const g of groups) {
      const rt = this.runtimes.get(g.serviceId);
      if (!rt) continue;
      rt.lostTransactions = g._sum.lostTransactions ?? 0;
      rt.revenueLossTomans = g._sum.revenueLossTomans ?? 0;
      rt.penaltyTomans = g._sum.penaltyTomans ?? 0;
      rt.incidentsCount = g._count._all ?? 0;
    }
  }

  private findRuntimeByIncident(incidentId: string): ServiceRuntime | undefined {
    for (const rt of this.runtimes.values()) {
      if (rt.activeIncidentId === incidentId) return rt;
    }
    return undefined;
  }

  // ── private: DTO mapping ─────────────────────────────────────────────────
  private toServiceDTO(rt: ServiceRuntime): ServiceDTO {
    const svc = rt.service;
    const total = rt.uptimeMs + rt.downtimeMs;
    const round1 = (x: number) => Math.round(x * 10) / 10;
    const tenantId = this.serviceTenantIds.get(svc.id) ?? null;
    return {
      id: svc.id,
      key: svc.key,
      name: svc.name,
      nameFa: svc.nameFa,
      tier: svc.tier,
      endpoint: svc.endpoint,
      criticality: svc.criticality,
      tenantId,
      tenantName: tenantId !== null ? (this.tenantNameById.get(tenantId) ?? null) : null,
      liveStatus: (svc.liveStatus as ServiceDTO['liveStatus']) ?? null,
      probeSource: parseProbeSource(svc.probeSource),
      status: rt.status,
      latencyMs: round1(rt.latencyMs),
      errorRate: Math.round(rt.errorRate * 10000) / 10000,
      throughput: Math.round(rt.throughput * 100) / 100,
      tps: svc.tps,
      avgTransactionValue: svc.avgTransactionValue,
      slaTarget: svc.slaTarget,
      penaltyBase: svc.penaltyBase,
      penaltyPerMinute: svc.penaltyPerMinute,
      uptime: total > 0 ? rt.uptimeMs / total : 1,
      incidentsCount: rt.incidentsCount,
      lostTransactions: Math.round(rt.lostTransactions),
      revenueLossTomans: Math.round(rt.revenueLossTomans),
      penaltyTomans: Math.round(rt.penaltyTomans),
      series: {
        ts: [...rt.series.ts],
        latencyMs: rt.series.latencyMs.map(round1),
        errorRate: rt.series.errorRate.map((x) => Math.round(x * 10000) / 10000),
        throughput: rt.series.throughput.map((x) => Math.round(x * 100) / 100),
        status: [...rt.series.status],
      },
    };
  }
}

// ── singleton (survives Next.js dev hot-reload) ─────────────────────────────
const globalForEngine = globalThis as unknown as {
  __sentinelEngine?: SentinelEngine;
  __sentinelEngineOptions?: EngineOptions;
};

export interface EngineOptions {
  /**
   * false = this process only reads engine state (web role); the tick loop,
   * schedulers and escalation timers belong to the worker entrypoint
   * (src/worker/index.ts) or to a role=all single process. Default true.
   */
  backgroundLoops?: boolean;
}

export function getEngine(opts?: EngineOptions): SentinelEngine {
  let backgroundLoops = opts?.backgroundLoops ?? true;
  // hard gate: the simulation NEVER ticks in live mode, no matter
  // who asks. A read-only boot (state cache for reads) stays allowed; the
  // banner states the mode and the ingestion loop owns the live tick.
  if (getConfig().mode === 'live') backgroundLoops = false;
  const existing = globalForEngine.__sentinelEngine;
  const existingOpts = globalForEngine.__sentinelEngineOptions;
  if (existing && existingOpts) {
    if (
      existing.engineVersion === ENGINE_VERSION &&
      existingOpts.backgroundLoops === backgroundLoops
    ) {
      return existing;
    }
    // Stale engine instance built from an older code generation (HMR keeps the
    // old class alive on globalThis between recompiles), or a loop-ownership
    // change (role reconfigured). Stop its timers and rebuild on the current
    // code. ensureInit() re-runs the seed (idempotent) and reconciles any
    // in-flight incidents.
    existing.stop();
    console.log(
      `[sentinel] rebuilding engine (v${String(existing.engineVersion)}→v${ENGINE_VERSION}, ` +
        `loops ${existingOpts.backgroundLoops ? 'on' : 'off'}→${backgroundLoops ? 'on' : 'off'})`,
    );
  }
  const engine = new SentinelEngine(backgroundLoops);
  globalForEngine.__sentinelEngine = engine;
  globalForEngine.__sentinelEngineOptions = { backgroundLoops };
  void engine.ensureInit().catch((err) => {
    console.error('[sentinel] engine init failed:', err);
  });
  return engine;
}
