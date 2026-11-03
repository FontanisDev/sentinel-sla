// Frozen report-snapshot fixtures.
//
// Shared by the unit tests (template invariants) and the visual-regression
// harness (deterministic pixels): the SAME fixture data must keep rendering
// the SAME document. Changing these on purpose means re-approving the
// baseline PNGs (scripts/report-visual-regression.ts --update) and the
// reviewer re-checking the diff.

import type {
  ExecutiveSnapshot,
  IncidentSnapshot,
  StatementSnapshot,
} from '@/server/reports/snapshot';
import { jalaliMonthWindow } from '@/server/contracts';

export const FIXTURE_NOW = new Date('2026-10-08T09:00:00Z');
export const WIN = jalaliMonthWindow(FIXTURE_NOW);

export const FIXTURE_META = {
  generatedAt: new Date('2026-10-08T09:03:10Z'),
  generatedBy: 'Dev Owner',
  tenantName: 'Sabz Pay Gateway Co.',
  tenantNameFa: 'شرکت نمونهٔ ای‌ای',
};

export function executiveSnapshot(): ExecutiveSnapshot {
  return {
    kind: 'executive',
    window: {
      start: WIN.start.toISOString(),
      end: WIN.end.toISOString(),
      jy: WIN.jy,
      jm: WIN.jm,
      labelEn: 'Mehr 1405',
      labelFa: 'مهر ۱۴۰۵',
      lengthSec: WIN.lengthSec,
      partial: true,
    },
    scopeTenant: null,
    headline: {
      penaltyToDateTomans: 127_478_750_000,
      projectedPenaltyTomans: 248_703_452_536,
      revenueLossTomans: 1_658_097_322_870,
      downtimeSec: 203_462,
      incidentsCount: 1902,
      servicesTotal: 91,
      servicesCompliant: 90,
      breaches: 1,
    },
    clients: [
      {
        tenantId: 't1',
        tenantName: 'Sabz Pay Gateway Co.',
        tenantNameFa: 'شرکت نمونهٔ ای‌ای',
        servicesTotal: 3,
        compliant: 2,
        breaches: 1,
        penaltyToDateTomans: 18_886_000_000,
        worstAvailabilityPct: 98.399,
      },
    ],
    perService: [
      {
        serviceId: 's1',
        serviceKey: 'payment-gateway',
        serviceName: 'Payment Gateway',
        serviceNameFa: 'درگاه پرداخت',
        tenantId: 't1',
        tenantName: 'Sabz Pay Gateway Co.',
        tenantNameFa: 'شرکت نمونهٔ ای‌ای',
        targetPct: 99.95,
        penaltyBase: 50_000_000,
        penaltyPerMinute: 7_500_000,
        downtimeSec: 12_345,
        billedMinutes: 206,
        elapsedSec: 1_296_000,
        availabilityPct: 99.047,
        compliance: 'breach',
        penaltyToDate: 18_886_000_000,
        projectedPenalty: 36_852_000_000,
        plannedWindows: 1,
        plannedSec: 600,
        incidentsCount: 12,
      },
    ],
    worstIncidents: [
      {
        id: 'inc1',
        serviceName: 'Payment Gateway',
        serviceNameFa: 'درگاه پرداخت',
        severity: 'critical',
        status: 'resolved',
        startedAt: '2026-10-01T10:00:00Z',
        endedAt: '2026-10-01T10:45:00Z',
        durationSec: 2700,
        penaltyTomans: 145_000_000,
        revenueLossTomans: 900_000_000,
        lostTransactions: 3600,
      },
    ],
    trend: [
      { labelEn: 'Days 1–10', labelFa: 'روزهای ۱ تا ۱۰', start: '2026-09-23T00:00:00Z', end: '2026-10-03T00:00:00Z', penaltyTomans: 1000, downtimeSec: 60, incidents: 2 },
      { labelEn: 'Days 11–20', labelFa: 'روزهای ۱۱ تا ۲۰', start: '2026-10-03T00:00:00Z', end: '2026-10-13T00:00:00Z', penaltyTomans: 2000, downtimeSec: 120, incidents: 3 },
      { labelEn: 'Days 21–end', labelFa: 'روزهای ۲۱ تا پایان ماه', start: '2026-10-13T00:00:00Z', end: '2026-10-23T00:00:00Z', penaltyTomans: 0, downtimeSec: 0, incidents: 0 },
    ],
    risk: {
      projectedPenaltyTomans: 248_703_452_536,
      watchServices: [
        {
          serviceKey: 'payment-gateway',
          serviceName: 'Payment Gateway',
          serviceNameFa: 'درگاه پرداخت',
          penaltyToDateTomans: 18_886_000_000,
          projectedPenaltyTomans: 36_852_000_000,
          targetPct: 99.95,
          availabilityPct: 99.047,
          compliance: 'breach',
        },
      ],
    },
  };
}

export function statementSnapshot(): StatementSnapshot {
  return {
    kind: 'statement',
    window: executiveSnapshot().window,
    contract: {
      tenantId: 't1',
      tenantName: 'Sabz Pay Gateway Co.',
      tenantNameFa: 'شرکت نمونهٔ ای‌ای',
      services: [
        {
          serviceId: 's1',
          serviceKey: 'payment-gateway',
          serviceName: 'Payment Gateway',
          serviceNameFa: 'درگاه پرداخت',
          slaTargetPct: 99.95,
          availabilityNaivePct: 98.399,
          availabilityContractualPct: 98.468,
          downtimeTotalSec: 12_345,
          downtimeExcludedSec: 600,
          downtimeChargeableSec: 11_745,
          penaltyDueTomans: 18_886_000_000,
          compliance: 'breach',
        },
      ],
    },
    outages: [
      {
        id: 'inc1',
        serviceName: 'Payment Gateway',
        serviceNameFa: 'درگاه پرداخت',
        severity: 'critical',
        category: 'chargeable',
        startedAt: '2026-10-01T10:00:00Z',
        endedAt: '2026-10-01T10:45:00Z',
        durationSec: 2700,
        chargeableSec: 2700,
        excludedSec: 0,
        penaltyTomans: 145_000_000,
        lostTransactions: 3600,
        evidence: 'spontaneous · 4 ev · probe samples recorded',
      },
      {
        id: 'inc2',
        serviceName: 'Wallet Service',
        serviceNameFa: 'کیف پول',
        severity: 'warning',
        category: 'planned-covered',
        startedAt: '2026-10-02T14:00:00Z',
        endedAt: '2026-10-02T15:00:00Z',
        durationSec: 3600,
        chargeableSec: 0,
        excludedSec: 3600,
        penaltyTomans: 0,
        lostTransactions: 0,
        evidence: 'chaos · 2 ev',
      },
    ],
    plannedWindows: [
      {
        reason: 'Datacenter network upgrade',
        startAt: '2026-10-02T13:00:00Z',
        endAt: '2026-10-02T16:00:00Z',
        serviceScope: 'fleet-wide',
      },
    ],
    totals: {
      penaltyDueTomans: 18_886_000_000,
      downtimeChargeableSec: 11_745,
      downtimeExcludedSec: 600,
      outagesCount: 2,
    },
  };
}

export function incidentSnapshot(): IncidentSnapshot {
  return {
    kind: 'incident',
    incident: {
      id: 'inc1',
      status: 'resolved',
      severity: 'critical',
      source: 'chaos',
      startedAt: '2026-10-01T10:00:00Z',
      detectedAt: '2026-10-01T10:00:20Z',
      acknowledgedAt: '2026-10-01T10:02:00Z',
      acknowledgedBy: 'A. Karimi',
      escalatedAt: null,
      escalatedTo: null,
      resolvedAt: '2026-10-01T10:45:00Z',
      mttdSec: 20,
      mttaSec: 100,
      mttrSec: 2700,
      durationSec: 2700,
      lostTransactions: 3600,
      revenueLossTomans: 900_000_000,
      penaltyTomans: 145_000_000,
    },
    service: {
      id: 's1',
      key: 'payment-gateway',
      name: 'Payment Gateway',
      nameFa: 'درگاه پرداخت',
      tier: 'tier-1',
      slaTargetPct: 99.95,
    },
    tenant: { id: 't1', name: 'Sabz Pay Gateway Co.', nameFa: 'شرکت نمونهٔ ای‌ای' },
    moneyModel: {
      penaltyBaseTomans: 50_000_000,
      penaltyPerMinuteTomans: 7_500_000,
      weightPct: 100,
      billedMinutes: 45,
      tps: 500,
      avgTransactionValueTomans: 250_000,
      formulaTomans:
        'penalty = 50,000,000 + 7,500,000 × 45 min × 100% = 387,500,000 T  |  revenue loss = 3,600 lost tx × 250,000 T = 900,000,000 T',
    },
    timeline: [
      { ts: '2026-10-01T10:00:00Z', event: 'fault_started', detail: 'chaos experiment' },
      { ts: '2026-10-01T10:00:20Z', event: 'detected', detail: 'streak 3/3' },
    ],
    postMortem: { source: null, text: null },
    hypotheses: [
      { key: 'outage', endpoint: 'https://pay.example.ir/health', tier: 'tier-1' },
      { key: 'network', endpoint: 'https://pay.example.ir/health', tier: 'tier-1' },
    ],
  };
}
