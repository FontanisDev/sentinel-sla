// Sentinel-SLA — request/query validation (OWASP ASVS L1: all inputs validated)
// Numeric bounds that the product requires to be *clamped* (not rejected) are clamped
// after parsing via clampInt().

import { z } from 'zod';

/** Clamp to [min, max] after rounding to an integer. */
export function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export const engineActionSchema = z.object({
  action: z.enum(['pause', 'resume', 'set-mode']),
  mode: z.enum(['calm', 'normal', 'storm']).optional(),
});

export const chaosPayloadSchema = z.object({
  serviceId: z.string().min(1).max(64),
  type: z.enum(['outage', 'latency', 'error-spike']),
  durationSec: z.number().optional(), // clamped to 10–300 (default 45) by the route
});

export const autoChaosSchema = z.object({
  enabled: z.boolean(),
  intervalMin: z.number().optional(), // clamped to 1–30 (default 3) by the route
});

export const incidentQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(), // default 20
  status: z.enum(['ongoing', 'resolved']).optional(),
  // §6.8 TimeRange server twin: inclusive startedAt bounds as ISO datetimes.
  // Invalid dates fail validation with a named issue (honest 400).
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
});

export const alertQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(), // default 25
});

export const metricsHistoryQuerySchema = z.object({
  serviceId: z.string().min(1).max(64),
  minutes: z.coerce.number().optional(), // clamped to 5–360 (default 60) by the route
});

// onboarding wizard: where a service's live signal comes from.
// Mirrors ProbeSourceDTO (src/lib/types.ts) and the runtime parser in
// src/server/ingestion.ts — one shape, three kind-branches.
export const probeSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('blackbox'),
    job: z.string().trim().min(1).max(120),
    instance: z.string().trim().max(300).optional(),
  }),
  z.object({
    kind: z.literal('promql'),
    good: z.string().trim().min(1).max(500),
    total: z.string().trim().min(1).max(500),
  }),
  z.object({
    kind: z.literal('alertmanager'),
    alert: z.string().trim().min(1).max(120),
    matcher: z.string().trim().max(300).optional(),
  }),
  // self-test: a target the product fully controls — the ingestion
  // loop synthesizes the probe from the running SelfTestRun fault window.
  // Created/used only by the self-test module, never exposed in the wizard.
  z.object({
    kind: z.literal('synthetic'),
  }),
]);

export type ProbeSourceInput = z.infer<typeof probeSourceSchema>;

// wizard preview: an UNSAVED probe-source candidate (+ endpoint/SLA
// hints for query construction) is POSTed; nothing is persisted here.
export const servicePreviewSchema = z.object({
  probeSource: probeSourceSchema,
  endpoint: z
    .string()
    .trim()
    .max(300)
    .regex(/^https?:\/\//, 'endpoint must be an http(s) URL')
    .optional(),
  slaTarget: z.number().gt(0).lt(1).optional(), // default 0.999 in the route
  /** when set, scoped users must be a member of this tenant (403 otherwise) */
  tenantId: z.string().trim().max(64).optional(),
});

export type ServicePreviewInput = z.infer<typeof servicePreviewSchema>;

export const createServiceSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'key must be a lowercase slug (a-z, 0-9, hyphens)')
    .min(2)
    .max(64),
  name: z.string().trim().min(2).max(80),
  nameFa: z.string().trim().max(120).optional(),
  /** live signal source; stored as JSON on Service.probeSource */
  probeSource: probeSourceSchema.optional(),
  /** owning tenant (v2); must exist → 404 otherwise */
  tenantId: z.string().trim().min(1).max(64).optional(),
  tier: z.string().trim().max(20).optional(),
  endpoint: z
    .string()
    .trim()
    .max(300)
    .regex(/^https?:\/\//, 'endpoint must be an http(s) URL')
    .optional(),
  baseLatencyMs: z.number().positive().max(10000).optional(),
  tps: z.number().positive().max(100000).optional(),
  avgTransactionValue: z.number().positive().max(1e12).optional(),
  slaTarget: z.number().gt(0).lt(1).optional(),
  penaltyBase: z.number().positive().max(1e13).optional(),
  penaltyPerMinute: z.number().positive().max(1e12).optional(),
  criticality: z.enum(['critical', 'high', 'medium', 'low']).optional(),
});

// v2 multi-tenancy: tenant creation payload.
export const createTenantSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'key must be a lowercase slug (a-z, 0-9, hyphens)')
    .min(2)
    .max(40),
  name: z.string().trim().min(2).max(80),
  nameFa: z.string().trim().max(80).optional(),
});

// v2 analytics query: ?tenant=<id|all>&windowHours=<1-24>
// windowHours is clamped to 1–24 (default 24) by the route, per the product requirements.
export const analyticsQuerySchema = z.object({
  tenant: z.string().trim().max(64).optional(),
  windowHours: z.coerce.number().optional(),
});

// v2.1 maintenance windows: POST /api/maintenance payload.
// serviceId omitted or null = fleet-wide window; a provided id must exist
// (404 from the service layer otherwise). durationMin is validated strictly
// (int 5–720) — out-of-range values are rejected, not clamped.
export const createMaintenanceWindowSchema = z.object({
  serviceId: z.string().trim().min(1).max(64).nullable().optional(),
  reason: z.string().trim().min(3).max(200),
  durationMin: z.number().int().min(5).max(720),
});

// Path id for POST /api/maintenance/{id}/cancel.
export const maintenanceIdSchema = z.string().trim().min(1).max(64);

// v2.5 body for POST /api/incidents/{id}/acknowledge (all fields optional).
export const acknowledgeIncidentSchema = z.object({
  by: z.string().trim().min(2).max(40).optional(),
});

// v2.1 data exports: shared query params (?format=csv|json & ?tenant=<id|all>).
// `limit` (incidents export) is clamped to 1–2000 (default 500) by the route;
// analytics `windowHours` is clamped to 1–24 (default 24) by the route.
export const exportQuerySchema = z.object({
  format: z.enum(['csv', 'json']).optional(), // default csv (analytics export: json)
  tenant: z.string().trim().max(64).optional(),
});

export const incidentsExportQuerySchema = exportQuerySchema.extend({
  status: z.enum(['ongoing', 'resolved']).optional(),
  limit: z.coerce.number().optional(),
});

export const analyticsExportQuerySchema = z.object({
  format: z.enum(['csv', 'json']).optional(), // only json is served; csv → 400 in the route
  tenant: z.string().trim().max(64).optional(),
  windowHours: z.coerce.number().optional(),
});

export type CreateServiceInput = z.infer<typeof createServiceSchema>;
export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type CreateMaintenanceWindowInput = z.infer<typeof createMaintenanceWindowSchema>;
export type ChaosInput = z.infer<typeof chaosPayloadSchema>;
export type AutoChaosInput = z.infer<typeof autoChaosSchema>;

// ── v2.2 alert governance ─────────────────────────────────────────────

// POST /api/rules — create a policy rule. Threshold ranges are per metric
// semantics: uptime/errorRate are 0–1 ratios, latencyMs/throughput are ≥ 0.
export const createAlertRuleSchema = z
  .object({
    name: z.string().trim().min(3).max(80),
    serviceId: z.string().trim().min(1).max(64).nullable().optional(),
    metric: z.enum(['uptime', 'errorRate', 'latencyMs', 'throughput']),
    operator: z.enum(['lt', 'gt']),
    threshold: z.number(),
    severity: z.enum(['critical', 'warning']).optional(),
    audience: z.enum(['technical', 'executive', 'both']).optional(),
    cooldownMin: z.number().int().min(1).max(1440).optional(),
    quietStartMin: z.number().int().min(0).max(1439).nullable().optional(),
    quietEndMin: z.number().int().min(0).max(1440).nullable().optional(),
  })
  .refine(
    (v) =>
      (v.metric === 'uptime' || v.metric === 'errorRate' ? v.threshold >= 0 && v.threshold <= 1 : v.threshold >= 0),
    { message: 'uptime/errorRate thresholds must be 0–1 ratios; latencyMs/throughput ≥ 0' },
  )
  .refine(
    (v) => (v.quietStartMin === null || v.quietStartMin === undefined) === (v.quietEndMin === null || v.quietEndMin === undefined),
    { message: 'quiet hours need BOTH quietStartMin and quietEndMin (or neither)' },
  );

// POST /api/rules/{id}/toggle body.
export const ruleToggleSchema = z.object({ enabled: z.boolean() });

// POST /api/channels — create a notification channel (target format checked
// per kind in the service layer, which owns the error messages). secret is the
// per-channel credential — stored, never echoed back in DTOs. settings is the
// non-secret per-kind configuration (Jira project key, Redmine project id,
// Mattermost overrides) — validated per kind below and echoed in DTOs.
export const mattermostSettingsSchema = z
  .object({
    channel: z.string().trim().min(1).max(80).optional(),
    username: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export const jiraSettingsSchema = z
  .object({
    projectKey: z.string().trim().min(2).max(20).regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'project key must start with a letter (Jira keys are alphanumeric)'),
    issueTypeName: z.string().trim().min(2).max(60).optional(),
  })
  .strict();

export const redmineSettingsSchema = z
  .object({
    projectId: z.string().trim().min(1).max(60),
  })
  .strict();

export const createChannelSchema = z
  .object({
    name: z.string().trim().min(3).max(60),
    kind: z.enum(['telegram', 'bale', 'webhook', 'email', 'mattermost', 'jira', 'redmine']),
    target: z.string().trim().min(3).max(500),
    audience: z.enum(['technical', 'executive', 'both']).optional(),
    secret: z.string().trim().min(8).max(200).nullable().optional(),
    settings: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.settings === undefined || val.settings === null) {
      // settings are REQUIRED for the ticketing kinds (a ticket needs a project)
      if (val.kind === 'jira')
        ctx.addIssue({ code: 'custom', path: ['settings'], message: 'Jira channels need settings.projectKey' });
      if (val.kind === 'redmine')
        ctx.addIssue({ code: 'custom', path: ['settings'], message: 'Redmine channels need settings.projectId' });
      return;
    }
    if (val.kind === 'jira') {
      const p = jiraSettingsSchema.safeParse(val.settings);
      if (!p.success) ctx.addIssue({ code: 'custom', path: ['settings'], message: p.error.issues[0]?.message ?? 'invalid Jira settings' });
    } else if (val.kind === 'redmine') {
      const p = redmineSettingsSchema.safeParse(val.settings);
      if (!p.success) ctx.addIssue({ code: 'custom', path: ['settings'], message: p.error.issues[0]?.message ?? 'invalid Redmine settings' });
    } else if (val.kind === 'mattermost') {
      const p = mattermostSettingsSchema.safeParse(val.settings);
      if (!p.success) ctx.addIssue({ code: 'custom', path: ['settings'], message: p.error.issues[0]?.message ?? 'invalid Mattermost settings' });
    } else if (Object.keys(val.settings).length > 0) {
      ctx.addIssue({ code: 'custom', path: ['settings'], message: `settings are not used by ${val.kind} channels` });
    }
  });

// PATCH /api/channels/{id} — edit a channel. secret and settings follow PATCH
// semantics: undefined = keep current, null = clear, value = replace.
export const updateChannelSchema = z
  .object({
    name: z.string().trim().min(3).max(60).optional(),
    target: z.string().trim().min(3).max(500).optional(),
    audience: z.enum(['technical', 'executive', 'both']).optional(),
    enabled: z.boolean().optional(),
    secret: z.string().trim().min(8).max(200).nullable().optional(),
    settings: z.record(z.string(), z.unknown()).nullable().optional(),
  });

export const channelToggleSchema = z.object({ enabled: z.boolean() });

// POST /api/oncall — create a rotation entry. dayOfWeek 0=Sunday…6=Saturday,
// start/end are minutes-from-midnight; end may wrap past midnight (e.g. 1320→360).
export const createOnCallSchema = z.object({
  engineerName: z.string().trim().min(3).max(60),
  role: z.string().trim().min(2).max(40),
  handle: z.string().trim().min(3).max(80),
  dayOfWeek: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
});

export const governanceIdSchema = z.string().trim().min(1).max(64);
export type EngineActionInput = z.infer<typeof engineActionSchema>;

// ── v2.4 report schedules ─────────────────────────────────────────────

// POST /api/schedules — create a cron-style report schedule. Frequency-
// specific day fields are refined (weekly needs dayOfWeek, monthly needs
// dayOfMonth ≤ 28 so every month is valid — no skipped Februarys).
export const createReportScheduleSchema = z
  .object({
    label: z.string().trim().min(3).max(80),
    frequency: z.enum(['weekly', 'monthly']),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    dayOfMonth: z.number().int().min(1).max(28).optional(),
    hour: z.number().int().min(0).max(23),
    periodHours: z.union([z.literal(1), z.literal(6), z.literal(24)]).optional(),
    // which template a schedule produces, in which language.
    // incident reports are per-incident and not schedulable.
    kind: z.enum(['executive', 'statement']).optional(),
    language: z.enum(['en', 'fa']).optional(),
    tenantId: z.string().trim().min(1).max(64).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => v.frequency !== 'weekly' || v.dayOfWeek !== undefined, {
    message: 'weekly schedules require dayOfWeek (0=Sunday … 6=Saturday)',
  })
  .refine((v) => v.frequency !== 'monthly' || v.dayOfMonth !== undefined, {
    message: 'monthly schedules require dayOfMonth (1-28)',
  })
  .refine((v) => v.kind !== 'statement' || v.tenantId !== undefined, {
    message: 'kind=statement schedules require tenantId (a per-client statement)',
  });

export const scheduleToggleSchema = z.object({ enabled: z.boolean() });

// ── v2.6 escalation policy ─────────────────────────────────────────────

// PUT /api/escalation — edit the fleet escalation policy. All fields optional
// (partial update against the current row); timeout bounded 1–30 min so the
// ladder stays honest in demos without becoming a page storm.
export const updateEscalationSchema = z.object({
  name: z.string().trim().min(3).max(80).optional(),
  timeoutMin: z.number().int().min(1).max(30).optional(),
  appliesTo: z.enum(['critical', 'all']).optional(),
  enabled: z.boolean().optional(),
});
