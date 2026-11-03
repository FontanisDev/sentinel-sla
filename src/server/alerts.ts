// Sentinel-SLA — alerting entry points.
//
// Every detection/recovery/escalation event flows through emitNotification(),
// which renders bilingual templates (EN technical / FA executive — see
// src/server/notify/templates.ts), writes the Alert feed row(s) and fans the
// message out to every matching enabled channel as NotificationOutbox rows.
// Delivery (retry, backoff, dead-letter, delivery log, channel counters) is
// the outbox dispatcher's job — this module stays boring on purpose.
//
// The message wording keeps the v1.5 characterisation texts (engineers' tests
// and muscle memory rely on them) with the numbers now formatted per audience.

import { emitNotification } from '@/server/notify/outbox';
import {
  escalationWhoEn,
  escalationWhoFa,
  type NotifyVars,
} from '@/server/notify/templates';

interface AlertContext {
  incidentId: string;
  serviceId: string;
  serviceName: string;
  serviceKey: string;
  endpoint: string;
  severity: 'critical' | 'warning';
  startedAt: Date;
  tps: number;
  avgTransactionValue: number;
  penaltyBase: number;
  penaltyPerMinute: number;
}

function baseVars(ctx: AlertContext): NotifyVars {
  return {
    serviceName: ctx.serviceName,
    serviceKey: ctx.serviceKey,
    endpoint: ctx.endpoint,
    probeLabel: 'sentinel/blackbox',
    startedAt: ctx.startedAt.toISOString(),
    tps: ctx.tps,
    avgTransactionValue: ctx.avgTransactionValue,
    penaltyBase: ctx.penaltyBase,
    penaltyPerMinute: ctx.penaltyPerMinute,
  };
}

/** Fired when monitoring detects a fault (detectedAt set). */
export async function fireDetectionAlerts(
  ctx: AlertContext,
  live: { latencyMs?: number; errorRate?: number },
): Promise<void> {
  const vars = baseVars(ctx);
  vars.latencyMs = Math.round(live.latencyMs ?? 0);
  vars.errorRate = ((live.errorRate ?? 0) * 100).toFixed(1);
  await emitNotification({
    topic: 'detection',
    severity: ctx.severity,
    audiences: ['technical', 'executive'],
    vars,
    incidentId: ctx.incidentId,
    serviceId: ctx.serviceId,
    serviceName: ctx.serviceName,
  });
}

/** Fired when an incident resolves (auto-recovery or on-call intervention). */
export async function fireRecoveryAlerts(
  ctx: AlertContext,
  impact: {
    mttdSec: number | null;
    mttrSec: number | null;
    lostTransactions: number;
    revenueLossTomans: number;
    penaltyTomans: number;
  },
): Promise<void> {
  const vars = baseVars(ctx);
  vars.mttdSec = impact.mttdSec;
  vars.mttrSec = impact.mttrSec;
  vars.lostTransactions = impact.lostTransactions;
  vars.revenueLossTomans = impact.revenueLossTomans;
  vars.penaltyTomans = impact.penaltyTomans;
  await emitNotification({
    topic: 'recovery',
    severity: 'info',
    audiences: ['technical', 'executive'],
    vars,
    incidentId: ctx.incidentId,
    serviceId: ctx.serviceId,
    serviceName: ctx.serviceName,
  });
}

/**
 * Fired when a DETECTED incident stays unacknowledged past the escalation
 * policy timeout: the secondary on-call is paged (technical) and management
 * is informed (executive, financial framing).
 */
export async function fireEscalationAlerts(
  ctx: AlertContext,
  escalation: {
    unackedSec: number;
    timeoutMin: number;
    secondaryName: string;
    secondaryHandle: string;
    nobodyOnDuty: boolean;
  },
): Promise<void> {
  const vars = baseVars(ctx);
  vars.unackedSec = escalation.unackedSec;
  vars.timeoutMin = escalation.timeoutMin;
  vars.who = escalationWhoEn(escalation.secondaryName, escalation.secondaryHandle, escalation.nobodyOnDuty);
  vars.whoFa = escalationWhoFa(escalation.secondaryName, escalation.secondaryHandle, escalation.nobodyOnDuty);
  await emitNotification({
    topic: 'escalation',
    severity: ctx.severity,
    audiences: ['technical', 'executive'],
    vars,
    incidentId: ctx.incidentId,
    serviceId: ctx.serviceId,
    serviceName: ctx.serviceName,
  });
}
