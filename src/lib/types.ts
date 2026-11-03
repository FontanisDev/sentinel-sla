// ═══════════════════════════════════════════════════════════════════════════
// Sentinel-SLA — API Contract (v2)
// Single source of truth shared by backend (src/app/api) and frontend.
// DO NOT break these shapes; extend only additively.
// v2 additions (post-MVP focus — multi-tenancy + richer reporting):
//   TenantDTO, tenant scoping on /api/dashboard, IncidentEventDTO (timelines),
//   AnalyticsDTO (error budgets, MTTD/MTTR trends, status heatmap).
// ═══════════════════════════════════════════════════════════════════════════

export type ServiceStatus = 'up' | 'degraded' | 'down';
export type IncidentSeverity = 'critical' | 'warning';
export type IncidentStatus = 'ongoing' | 'resolved';
export type IncidentSource = 'spontaneous' | 'chaos' | 'manual';
export type ChaosType = 'outage' | 'latency' | 'error-spike';
export type ChaosStatus = 'running' | 'passed' | 'failed' | 'aborted';
export type EngineMode = 'calm' | 'normal' | 'storm';
export type AlertAudience = 'technical' | 'executive';
export type AlertSeverity = 'critical' | 'warning' | 'info';

/** Live metric ring-buffer (epoch ms) — last N ticks, oldest first. */
export interface MetricSeries {
  ts: number[];
  latencyMs: number[];
  errorRate: number[];
  throughput: number[];
  /** 1 = up, 0.5 = degraded, 0 = down */
  status: number[];
}

/** Tenant (client company) — v2 multi-tenancy. */
export interface TenantDTO {
  id: string;
  key: string;
  name: string;
  nameFa: string | null;
  /** number of services currently assigned to this tenant */
  servicesCount: number;
}

/**
 * Where a service's live signal comes from. Mirrors the JSON stored
 * in `Service.probeSource` — the ingestion worker and the onboarding wizard
 * both speak this shape (discriminated union, validated by probeSourceSchema).
 */
export type ProbeSourceDTO =
  | { kind: 'blackbox'; job: string; instance?: string }
  | { kind: 'promql'; good: string; total: string }
  | { kind: 'alertmanager'; alert: string; matcher?: string }
  | { kind: 'synthetic' };

export interface ServiceDTO {
  id: string;
  key: string;
  name: string;
  nameFa: string | null;
  tier: string;
  endpoint: string;
  criticality: string;
  /** owning tenant (v2) */
  tenantId: string | null;
  tenantName: string | null;
  /** live-mode ingestion state: null = no live probe configured */
  liveStatus: 'up' | 'down' | 'stale' | null;
  /** parsed probe source; null = simulation-only service */
  probeSource: ProbeSourceDTO | null;
  /** live values */
  status: ServiceStatus;
  latencyMs: number;
  errorRate: number; // 0..1
  throughput: number; // tx/s
  /** config for executive math */
  tps: number;
  avgTransactionValue: number; // Tomans
  slaTarget: number; // 0.999
  penaltyBase: number; // Tomans / incident
  penaltyPerMinute: number; // Tomans / min
  /** aggregates since engine start */
  uptime: number; // 0..1
  incidentsCount: number;
  /** cumulative lost transactions behind revenueLossTomans (v2.7, additive —
   *  powers the exact FormulaPopover evidence: loss = lostTx × avg tx value) */
  lostTransactions: number;
  revenueLossTomans: number;
  penaltyTomans: number;
  series: MetricSeries;
}

/** One entry of an incident's forensic timeline (engine `events` JSON, parsed). */
export interface IncidentEventDTO {
  ts: string; // ISO
  event: string; // fault_started | probe_failed | detected | resolved | ...
  detail?: string;
}

export interface IncidentDTO {
  id: string;
  serviceId: string;
  serviceName: string;
  serviceKey: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  source: IncidentSource;
  startedAt: string; // ISO
  detectedAt: string | null;
  resolvedAt: string | null;
  mttdSec: number | null;
  mttrSec: number | null;
  /** mean time to acknowledge — acknowledgedAt − detectedAt (v2.5, additive) */
  mttaSec: number | null;
  durationSec: number | null;
  lostTransactions: number;
  revenueLossTomans: number;
  penaltyTomans: number;
  /** when on-call took ownership of the incident (v2.5, additive) */
  acknowledgedAt: string | null;
  /** display handle of the acknowledger (v2.5, additive) */
  acknowledgedBy: string | null;
  /** when the escalation page fired — secondary paged after the policy timeout (v2.6, additive) */
  escalatedAt: string | null;
  /** who the escalation page reached — "Name (@handle)" (v2.6, additive) */
  escalatedTo: string | null;
  aiSummary: string | null;
  /** how the summary was produced — 'llm' | 'heuristic' (rule-based fallback) | null (v2.2, additive) */
  aiSource: 'llm' | 'heuristic' | null;
  chaosExperimentId: string | null;
  /** owning service's money model — powers FormulaPopover evidence on every
   *  incident money figure (v2.7, additive; null when no service row) */
  moneyModel: {
    tps: number;
    avgTransactionValue: number; // Tomans
    penaltyBase: number; // Tomans
    penaltyPerMinute: number; // Tomans
  } | null;
  /** forensic timeline, oldest first (v2; [] when absent) */
  events: IncidentEventDTO[];
}

/**
 * GET /api/incidents/[id] — the /incidents/[id] detail page payload :
 * the incident itself, the notifications sent about it (evidence panel) and
 * the other incidents of the same service (context panel).
 */
export interface IncidentDetailDTO {
  incident: IncidentDTO;
  /** newest first, capped — evidence panel */
  alerts: AlertDTO[];
  /** same service, newest first, excluding this incident — context panel */
  related: IncidentDTO[];
}

/**
 * GET /api/services/[key] — the /services/[key] detail page payload :
 * the live health DTO, the current-Jalali-window contract row (same math as
 * /contracts), recent incidents, and the evidence trail (notifications +
 * chaos experiments).
 */
export interface ServiceDetailDTO {
  service: ServiceDTO;
  contract: ContractServiceRow;
  /** Shaparak/PSP transaction profile summary — null when the row carries none. */
  tpsProfile: TpsProfileSummary | null;
  /** newest first, capped */
  incidents: IncidentDTO[];
  /** newest first, capped — evidence panel */
  alerts: AlertDTO[];
  /** newest first, capped — evidence panel */
  chaos: ChaosExperimentDTO[];
}

/** Which money source drives the service's tps (flat column vs imported profile). */
export interface TpsProfileSummary {
  active: boolean;
  /** The flat tps column (fallback / comparison figure). */
  tps: number;
  meanTps: number | null;
  peak: { bucket: number; tps: number } | null;
  coveredBuckets: number | null;
  importedAt: string | null;
  importedBy: string | null;
}

export interface AlertDTO {
  id: string;
  incidentId: string | null;
  serviceName: string;
  channel: string;
  audience: AlertAudience;
  severity: AlertSeverity;
  title: string;
  message: string;
  status: string;
  sentAt: string; // ISO
}

export interface ChaosExperimentDTO {
  id: string;
  serviceId: string;
  serviceName: string;
  type: ChaosType;
  status: ChaosStatus;
  startedAt: string;
  endedAt: string | null;
  plannedDurationSec: number;
  mttdSec: number | null;
  mttrSec: number | null;
  gatePassed: boolean | null;
}

export interface ReportDTO {
  id: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  fileName: string;
  fileSize: number;
  generatedBy: string;
  /** report template kind (executive | statement | incident) */
  kind: string;
  /** output language (en | fa) — same data either way */
  language: string;
  /** incident id (incident) / tenant id (statement) / null (fleet executive) */
  subjectId: string | null;
  /** SHA-256 of the canonical data snapshot (printed in the title block) */
  snapshotHash: string;
}

// ── Report schedules (v2.4) ─────────────────────────────────────────────────

export type ReportFrequency = 'weekly' | 'monthly';

/**
 * A cron-style executive report schedule. The engine evaluates schedules
 * every tick: when a schedule's due time passes (and it has not run since),
 * the same PDF pipeline as the manual button fires with generatedBy
 * 'scheduled'. `nextRunAt` is computed server-side for display.
 */
export interface ReportScheduleDTO {
  id: string;
  label: string;
  frequency: ReportFrequency;
  /** 0=Sunday … 6=Saturday (weekly only; null for monthly) */
  dayOfWeek: number | null;
  /** 1-28, month-day (monthly only; null for weekly) */
  dayOfMonth: number | null;
  /** hour of day, UTC (0-23) */
  hour: number;
  /** report period: 1 | 6 | 24 hours (legacy rows; report templates use the Jalali month) */
  periodHours: number;
  /** report template: executive | statement */
  kind: string;
  /** output language: en | fa */
  language: string;
  /** null = fleet-wide scope */
  tenantId: string | null;
  /** resolved tenant display name; null for fleet-wide */
  tenantName: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  /** computed next due time (ISO); null when disabled */
  nextRunAt: string | null;
  createdAt: string;
}

/** One recorded firing of a report schedule (v2.5 audit trail). */
export interface ScheduleRunDTO {
  id: string;
  scheduleId: string;
  /** schedule label snapshotted at run time — survives renames/deletes */
  label: string;
  /** what fired it: engine due-check or the UI Run-now button */
  trigger: 'due' | 'manual';
  startedAt: string; // ISO
  durationMs: number;
  success: boolean;
  /** produced SlaReport id + file (success only) */
  reportId: string | null;
  fileName: string | null;
  fileSize: number | null;
  /** first line of the failure reason (failure only) */
  error: string | null;
}

export interface KpiDTO {
  fleetUptime: number; // 0..1
  activeIncidents: number;
  incidentsTotal: number;
  lostRevenueTomans: number;
  penaltyExposureTomans: number;
  transactionsLost: number;
  avgMttdSec: number | null;
  avgMttrSec: number | null;
  /** fleet avg time-to-acknowledge over acknowledged incidents (v2.5, additive) */
  avgMttaSec: number | null;
  /** ongoing incidents currently escalated to the secondary (v2.6, additive) */
  escalatedIncidents: number;
  slaCompliantServices: number;
  totalServices: number;
  lastIncidentAt: string | null;
  /** outbox: pending+delivering backlog (depth) + dead-letter count. */
  outboxDepth: number;
  outboxDead: number;
}

export interface EngineStateDTO {
  running: boolean;
  startedAt: string;
  tickCount: number;
  tickIntervalMs: number;
  mode: EngineMode;
  autoChaos: boolean;
  autoChaosIntervalMin: number;
  nextAutoChaosAt: string | null;
  lastChaosResult: string | null;
  /** Deployment mode: demo = simulation, live = real ingestion. */
  deploymentMode: 'demo' | 'live';
}

export interface DashboardDTO {
  engine: EngineStateDTO;
  kpis: KpiDTO;
  /** all tenants (unfiltered — for the switcher) */
  tenants: TenantDTO[];
  /** active tenant scope: null = all tenants (fleet-wide) */
  tenantScope: string | null;
  services: ServiceDTO[];
  incidents: IncidentDTO[]; // recent, newest first (limit 20)
  alerts: AlertDTO[]; // recent (limit 25)
  chaosExperiments: ChaosExperimentDTO[]; // recent (limit 10)
  reports: ReportDTO[]; // recent (limit 10)
  /** maintenance windows: active first, then recently ended (limit 15) — v2.1 */
  maintenanceWindows: MaintenanceWindowDTO[];
  /** alert governance: user-defined policy rules evaluated by the engine (v2.2) */
  alertRules: AlertRuleDTO[];
  /** notification channels + delivery health (v2.2) */
  channels: NotificationChannelDTO[];
  /** on-call rotation (v2.2) */
  onCall: OnCallEntryDTO[];
  /** fleet escalation policy — unacked incidents page the secondary (v2.6) */
  escalationPolicy: EscalationPolicyDTO;
  /** cron-style executive report schedules (v2.4) */
  reportSchedules: ReportScheduleDTO[];
  /** v2.5: latest schedule firings (audit trail, newest first) */
  scheduleRuns: ScheduleRunDTO[];
  serverTime: string;
}

// ── Request payloads ────────────────────────────────────────────────────────

export interface CreateServicePayload {
  key: string;
  name: string;
  nameFa?: string;
  tenantId?: string;
  tier?: string;
  endpoint?: string;
  baseLatencyMs?: number;
  tps?: number;
  avgTransactionValue?: number;
  slaTarget?: number;
  penaltyBase?: number;
  penaltyPerMinute?: number;
  criticality?: string;
}

export interface ChaosPayload {
  serviceId: string;
  type: ChaosType;
  durationSec?: number;
}

export interface AutoChaosPayload {
  enabled: boolean;
  intervalMin?: number;
}

export interface EngineActionPayload {
  action: 'pause' | 'resume' | 'set-mode';
  mode?: EngineMode;
}

export interface GenerateReportPayload {
  /** report template (default 'executive') */
  kind?: 'executive' | 'statement' | 'incident';
  /** output language (default 'en') — same data either way */
  language?: 'en' | 'fa';
  /** scope the report to a single tenant; omit = fleet-wide executive */
  tenantId?: string;
  /** the incident to report on (kind=incident only) */
  incidentId?: string;
}

export interface CreateReportSchedulePayload {
  label: string;
  frequency: ReportFrequency;
  /** 0-6, required for weekly */
  dayOfWeek?: number;
  /** 1-28, required for monthly */
  dayOfMonth?: number;
  /** hour of day UTC (0-23) */
  hour: number;
  /** legacy report window (template-era rows); the report templates use the Jalali month */
  periodHours?: number;
  /** report template (default 'executive'; incident reports are not schedulable) */
  kind?: 'executive' | 'statement';
  /** output language (default 'en') */
  language?: 'en' | 'fa';
  /** scope to a tenant; omit = fleet-wide (required for kind=statement) */
  tenantId?: string;
  enabled?: boolean;
}

/** Analytics display window (v2.4 UI selector) — hours. */
export type AnalyticsWindow = 6 | 12 | 24;

export interface CreateTenantPayload {
  key: string;
  name: string;
  nameFa?: string;
}

export interface PostMortemPayload {
  incidentId: string;
}

export interface AcknowledgeIncidentPayload {
  /** display handle of the acknowledger; 2–40 chars; optional (defaults on the server) */
  by?: string;
}

// ── Analytics (v2) ─────────────────────────────────────────────────────────

export type ErrorBudgetStatus = 'healthy' | 'burning' | 'exhausted';

/** Rolling-window SLA error budget for one service. */
export interface ErrorBudgetDTO {
  serviceId: string;
  serviceKey: string;
  serviceName: string;
  slaTarget: number; // 0.999
  windowHours: number; // rolling window actually used
  allowedDowntimeSec: number; // (1 - target) × window
  consumedDowntimeSec: number; // critical = full duration; warning = ½ duration (uptime 0.5 encoding)
  remainingSec: number; // allowed - consumed (negative on overrun)
  remainingRatio: number; // remaining / allowed (≤ 0 when exhausted)
  status: ErrorBudgetStatus; // healthy > 0.5 | burning 0–0.5 | exhausted ≤ 0
  burnRatePerHour: number; // consumed downtime per hour
  projectedExhaustionSec: number | null; // seconds to exhaustion at current burn; null = not burning
}

/** One hourly bucket of incident trend data. */
export interface TrendPointDTO {
  ts: string; // ISO bucket start
  incidents: number;
  mttdSec: number | null; // avg over bucket
  mttrSec: number | null; // avg over bucket
  /** avg time-to-acknowledge over bucket (v2.5, additive; null = no acks) */
  mttaSec: number | null;
  penaltyTomans: number; // sum over bucket
}

/** Status heatmap bucket — per-service availability score keyed by service key. */
export interface HeatmapBucketDTO {
  ts: number; // epoch ms, bucket start
  /** 1 = up, 0.5 = degraded, 0 = down; null = no snapshots in bucket */
  services: Record<string, number | null>;
}

export interface AnalyticsDTO {
  windowHours: number; // requested window actually used
  errorBudgets: ErrorBudgetDTO[];
  trends: TrendPointDTO[]; // hourly buckets, oldest first
  heatmap: {
    bucketSizeMin: number;
    buckets: HeatmapBucketDTO[]; // oldest first
  };
}

export interface ApiError {
  error: string;
  details?: unknown;
}

// ── Maintenance windows (v2.1) ─────────────────────────────────────────────

export type MaintenanceStatus = 'active' | 'expired' | 'cancelled';

/**
 * A planned maintenance window. While ACTIVE, alert delivery is suppressed
 * for the covered service (or the whole fleet when serviceId is null);
 * incidents are still detected and recorded — SLA truth is never altered.
 */
export interface MaintenanceWindowDTO {
  id: string;
  /** null = fleet-wide window */
  serviceId: string | null;
  /** resolved service name; null for fleet-wide */
  serviceName: string | null;
  tenantId: string | null;
  reason: string;
  status: MaintenanceStatus;
  startAt: string; // ISO
  endAt: string; // ISO
  createdAt: string; // ISO
  createdBy: string;
  /** number of alert deliveries suppressed while this window was active */
  suppressedAlerts: number;
}

export interface CreateMaintenanceWindowPayload {
  /** omit or null = fleet-wide window */
  serviceId?: string | null;
  /** 3–200 chars, shown in the UI and audit trail */
  reason: string;
  /** window starts immediately and lasts this long: 5–720 */
  durationMin: number;
}

// ── Data export (v2.1) ─────────────────────────────────────────────────────

export type ExportFormat = 'csv' | 'json';

/** One row of the incidents CSV/JSON export. */
export interface IncidentExportRow {
  id: string;
  service: string;
  severity: string;
  status: string;
  source: string;
  detected: string; // ISO or ''
  resolved: string; // ISO or ''
  mttdSec: number | null;
  mttrSec: number | null;
  durationSec: number | null;
  transactionsLost: number;
  revenueLossTomans: number;
  penaltyTomans: number;
}

// ── Alert governance (v2.2) ─────────────────────────────────────────────────

/** Metric a policy rule can evaluate. */
export type AlertMetric = 'uptime' | 'errorRate' | 'latencyMs' | 'throughput';
export type AlertOperator = 'lt' | 'gt';
export type RuleAudience = 'technical' | 'executive' | 'both';

/**
 * A user-defined policy rule evaluated every engine tick against live service
 * metrics (distinct from probe-based detection). Rules fire alerts to the
 * selected audience with a per-rule cooldown so a storming metric produces
 * one page per cooldown window, not one per tick.
 */
export interface AlertRuleDTO {
  id: string;
  name: string;
  /** null = fleet rule, evaluated against every service individually */
  serviceId: string | null;
  /** resolved service name; null for fleet rules */
  serviceName: string | null;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  severity: IncidentSeverity;
  audience: RuleAudience;
  /** minutes between two firings of the same rule; 1–1440 */
  cooldownMin: number;
  /** quiet hours on this rule; null = disabled */
  quietStartMin: number | null;
  quietEndMin: number | null;
  enabled: boolean;
  timesFired: number;
  lastFiredAt: string | null; // ISO
  createdAt: string; // ISO
  /** live state from the engine's last evaluation pass (v2.3) */
  violatedNow: boolean;
  /** worst measured value across the rule's targets in the last pass (v2.3) */
  measuredValue: number | null;
  /** service the worst measurement came from (fleet rules; v2.3) */
  violatedServiceName: string | null;
}

export interface CreateAlertRulePayload {
  name: string; // 3–80 chars
  /** omit or null = fleet rule */
  serviceId?: string | null;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  severity?: IncidentSeverity; // default 'warning'
  audience?: RuleAudience; // default 'technical'
  cooldownMin?: number; // default 15, clamp 1–1440
  /** quiet hours (minutes from midnight): warning/info defer to window end,
   *  critical pages always go out; null start = quiet hours disabled */
  quietStartMin?: number | null;
  quietEndMin?: number | null;
}

export type ChannelKind = 'telegram' | 'bale' | 'webhook' | 'email' | 'mattermost' | 'jira' | 'redmine';

/** Non-secret per-kind channel settings, echoed in DTOs (credentials live in `secret`). */
export interface JiraChannelSettings {
  projectKey: string; // Jira project key (e.g. OPS)
  issueTypeName?: string; // default 'Task'
}
export interface RedmineChannelSettings {
  projectId: string; // Redmine project identifier or numeric id
}
export interface MattermostChannelSettings {
  channel?: string; // optional channel override (e.g. town-square)
  username?: string; // optional bot display name override
}
export type ChannelSettings = JiraChannelSettings | RedmineChannelSettings | MattermostChannelSettings;
export type ChannelStatus = 'healthy' | 'degraded' | 'disabled';

/**
 * A notification delivery channel. Since the delivery is REAL (or
 * transport-simulated offline) through the transactional outbox: every attempt
 * lands in the delivery log with status + error text; counters, last outcome
 * and the dead-letter state make pipeline health observable.
 */
export interface NotificationChannelDTO {
  id: string;
  name: string;
  kind: ChannelKind;
  /** chat id / webhook URL / email address — validated per kind */
  target: string;
  audience: RuleAudience;
  enabled: boolean;
  /** total alert deliveries routed through this channel (incl. tests) */
  deliveredCount: number;
  /** total failed delivery attempts since creation */
  failedCount: number;
  lastDeliveryAt: string | null; // ISO
  /** null when the last delivery attempt succeeded (or never fired) */
  lastError: string | null;
  /** per-kind non-secret configuration (Jira project key, Redmine project id, …) */
  settings?: Record<string, unknown> | null;
  status: ChannelStatus;
  createdAt: string; // ISO
}

export interface CreateChannelPayload {
  name: string; // 3–60 chars
  kind: ChannelKind;
  target: string;
  audience?: RuleAudience; // default 'technical'
  /** per-channel credential (webhook HMAC; Jira email:token or PAT; Redmine API key); never echoed back */
  secret?: string | null;
  /** non-secret per-kind configuration, validated per kind */
  settings?: Record<string, unknown> | null;
}

export interface UpdateChannelPayload {
  name?: string;
  target?: string;
  audience?: RuleAudience;
  enabled?: boolean;
  secret?: string | null;
  settings?: Record<string, unknown> | null;
}

/** One engineer in the on-call rotation. */
export interface OnCallEntryDTO {
  id: string;
  engineerName: string;
  role: string; // e.g. 'Primary', 'Secondary', 'Manager'
  /** telegram handle or phone shown in the UI */
  handle: string;
  /** 0=Sunday … 6=Saturday (ISO-style week starting Sunday for fa-IR) */
  dayOfWeek: number;
  /** coverage window in minutes from midnight, local time — e.g. 540–1080 = 09:00–18:00 */
  startMinute: number;
  endMinute: number;
  active: boolean; // computed: covers “now”
}

export interface CreateOnCallPayload {
  engineerName: string; // 3–60
  role: string; // 3–40
  handle: string; // 3–80
  dayOfWeek: number; // 0–6
  startMinute: number; // 0–1439
  endMinute: number; // 1–1440, may wrap past midnight
}

// ── v2.6 escalation policy ─────────────────────────────────────────────────

/** The fleet-wide escalation policy (single row, editable via PUT /api/escalation). */
export interface EscalationPolicyDTO {
  id: string;
  name: string;
  /** unacknowledged minutes after detection before the secondary is paged */
  timeoutMin: number; // 1–30
  /** which incident severities the ladder applies to */
  appliesTo: 'critical' | 'all';
  enabled: boolean;
  /** lifetime count of fired escalation pages (policy row bookkeeping) */
  timesEscalated: number;
  lastEscalatedAt: string | null; // ISO
  createdAt: string; // ISO
}

export interface UpdateEscalationPayload {
  name?: string; // 3–80
  timeoutMin?: number; // 1–30
  appliesTo?: 'critical' | 'all';
  enabled?: boolean;
}

// ── v2.0 /contracts — contract compliance view ───────────────

/** How one service sits against its contractual target this window. */
export type ContractCompliance = 'compliant' | 'breach' | 'pending';

/**
 * One service's contract view for the measurement window (current Jalali
 * month). Every money figure here is Tomans; the UI pairs each with a
 * FormulaPopover so no number is unexplained.
 */
export interface ContractServiceRow {
  serviceId: string;
  serviceKey: string;
  serviceName: string;
  serviceNameFa: string | null;
  tenantId: string | null;
  tenantName: string | null;
  tenantNameFa: string | null;
  /** contractual availability target, percent (slaTarget × 100) */
  targetPct: number;
  /** contractual penalty scheme — the runtime fixed + per-minute fields */
  penaltyBase: number; // Tomans / incident
  penaltyPerMinute: number; // Tomans / min
  /** chargeable downtime inside the window, integer seconds */
  downtimeSec: number;
  /** billed minutes per the engine rule (ceil, 1-minute minimum); 0 = no downtime */
  billedMinutes: number;
  /** elapsed window seconds when the snapshot was taken */
  elapsedSec: number;
  /** measured availability, percent — null before any window time elapsed */
  availabilityPct: number | null;
  compliance: ContractCompliance;
  /** penalty accrued this window (Tomans) — ledger values + domain rule for clipped/ongoing */
  penaltyToDate: number;
  /** linear projection to window end; null until 5 % of the window elapsed */
  projectedPenalty: number | null;
  /** planned maintenance windows overlapping the window (informational) */
  plannedWindows: number;
  /** their total overlap with the window, seconds */
  plannedSec: number;
  /** incidents counted into this row */
  incidentsCount: number;
}

/** The /contracts payload (GET /api/contracts). */
export interface ContractsSnapshotDTO {
  window: {
    start: string; // ISO
    end: string; // ISO
    jy: number;
    jm: number;
    labelEn: string; // "Mehr 1405"
    labelFa: string; // «مهر ۱۴۰۵»
    lengthSec: number;
  };
  generatedAt: string; // ISO
  elapsedSec: number;
  totals: {
    tenants: number;
    services: number;
    breaches: number;
    penaltyToDate: number; // Tomans
    /** null while any service's projection is still pending (5 % guard) */
    projectedPenalty: number | null;
    plannedWindows: number;
  };
  rows: ContractServiceRow[];
}
