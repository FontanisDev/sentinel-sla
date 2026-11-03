// Sentinel-SLA — DTO mappers for database rows → API contract (src/lib/types.ts)

import type { Alert as AlertRow, ChaosExperiment, Incident, Service, SlaReport } from '@prisma/client';
import type { AlertDTO, ChaosExperimentDTO, IncidentDTO, IncidentEventDTO, ReportDTO } from '@/lib/types';

/**
 * Parse the incident `events` JSON timeline (array of {ts, event, detail?}).
 * Tolerant of malformed/missing data → []; order preserved as stored (oldest
 * first); `ts` normalized to an ISO string.
 */
export function parseIncidentEvents(raw: string): IncidentEventDTO[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: IncidentEventDTO[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { ts, event, detail } = entry as Record<string, unknown>;
    if (typeof event !== 'string') continue;
    let iso: string | null = null;
    if (typeof ts === 'number') {
      const d = new Date(ts);
      iso = Number.isNaN(d.getTime()) ? null : d.toISOString();
    } else if (typeof ts === 'string') {
      const d = new Date(ts);
      iso = Number.isNaN(d.getTime()) ? ts : d.toISOString();
    }
    if (iso === null) continue;
    out.push(typeof detail === 'string' ? { ts: iso, event, detail } : { ts: iso, event });
  }
  return out;
}

export function toIncidentDTO(row: Incident & { service: Service }): IncidentDTO {
  return {
    id: row.id,
    serviceId: row.serviceId,
    serviceName: row.service.name,
    serviceKey: row.service.key,
    status: row.status as IncidentDTO['status'],
    severity: row.severity as IncidentDTO['severity'],
    source: row.source as IncidentDTO['source'],
    startedAt: row.startedAt.toISOString(),
    detectedAt: row.detectedAt ? row.detectedAt.toISOString() : null,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    mttdSec: row.mttdSec,
    mttrSec: row.mttrSec,
    mttaSec: row.mttaSec,
    durationSec: row.durationSec,
    lostTransactions: row.lostTransactions,
    revenueLossTomans: row.revenueLossTomans,
    penaltyTomans: row.penaltyTomans,
    acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
    acknowledgedBy: row.acknowledgedBy,
    escalatedAt: row.escalatedAt ? row.escalatedAt.toISOString() : null,
    escalatedTo: row.escalatedTo,
    aiSummary: row.aiSummary,
    aiSource: (row.aiSource as IncidentDTO['aiSource']) ?? null,
    chaosExperimentId: row.chaosExperimentId,
    moneyModel: row.service
      ? {
          tps: row.service.tps,
          avgTransactionValue: row.service.avgTransactionValue,
          penaltyBase: row.service.penaltyBase,
          penaltyPerMinute: row.service.penaltyPerMinute,
        }
      : null,
    events: parseIncidentEvents(row.events),
  };
}

export function toAlertDTO(row: AlertRow & { service: Service | null }): AlertDTO {
  return {
    id: row.id,
    incidentId: row.incidentId,
    serviceName: row.service ? row.service.name : 'unknown',
    channel: row.channel,
    audience: row.audience as AlertDTO['audience'],
    severity: row.severity as AlertDTO['severity'],
    title: row.title,
    message: row.message,
    status: row.status,
    sentAt: row.sentAt.toISOString(),
  };
}

export function toChaosDTO(row: ChaosExperiment & { service: Service }): ChaosExperimentDTO {
  return {
    id: row.id,
    serviceId: row.serviceId,
    serviceName: row.service.name,
    type: row.type as ChaosExperimentDTO['type'],
    status: row.status as ChaosExperimentDTO['status'],
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    plannedDurationSec: row.plannedDurationSec,
    mttdSec: row.mttdSec,
    mttrSec: row.mttrSec,
    gatePassed: row.gatePassed,
  };
}

export function toReportDTO(row: SlaReport): ReportDTO {
  return {
    id: row.id,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    generatedAt: row.generatedAt.toISOString(),
    fileName: row.fileName,
    fileSize: row.fileSize,
    generatedBy: row.generatedBy,
    kind: row.kind,
    language: row.language,
    subjectId: row.subjectId,
    snapshotHash: row.snapshotHash,
  };
}
