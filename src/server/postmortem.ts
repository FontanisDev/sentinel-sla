// Rule-based (deterministic) incident post-mortem generator.
//
// Sentinel-SLA's post-mortem feature is a contractual promise to both
// audiences (CEO + on-call). When the LLM backend is unreachable the route
// degrades to this generator instead of failing, and every artifact it
// produces is explicitly labeled as a rule-based draft — the product never
// pretends a heuristic draft was written by the AI engine.

import type { Incident, Service } from '@prisma/client'

export type PostMortemSource = 'llm' | 'heuristic'

interface IncidentEventRow {
  ts: string
  event: string
  detail?: string
}

function fmtT(v: number): string {
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}B Tomans`
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M Tomans`
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(0)}K Tomans`
  return `${Math.round(v)} Tomans`
}

function fmtSec(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'n/a'
  if (v < 60) return `${Math.round(v)}s`
  const m = Math.floor(v / 60)
  const s = Math.round(v % 60)
  return s ? `${m}m ${s}s` : `${m}m`
}

// Exported for the incident report snapshot: the rule-based cause
// hypotheses are pure telemetry-derived candidates, offline-safe. The keys
// form the stable contract the report templates localize; the English
// strings stay for the (English) heuristic post-mortem text.
export type FaultHypothesisKey = 'outage' | 'network' | 'cascading' | 'latency' | 'budget' | 'resource'

export function faultHypothesisKeys(severity: string): FaultHypothesisKey[] {
  return severity === 'critical'
    ? ['outage', 'network', 'cascading']
    : ['latency', 'budget', 'resource']
}

export function faultHypotheses(severity: string, svc: Service): string[] {
  if (severity === 'critical') {
    return [
      `full service outage: crashed process, exhausted worker pool, or failed dependency (DB/connection pool) taking ${svc.endpoint} off the air`,
      `network partition or load-balancer health-check failure dropping all probes despite partially running backends`,
      `cascading failure from an upstream provider (fraud-scoring/KYC vendors are the usual suspects in this tier)`,
    ]
  }
  return [
    `latency degradation: saturated connection pool, GC pauses, or a slow upstream call inflating response times toward probe timeouts`,
    `partial error budget burn: intermittent 5xx from one unhealthy replica behind ${svc.endpoint}`,
    `resource saturation (CPU/memory/disk I/O) on the ${svc.tier}-tier nodes serving this service`,
  ]
}

/**
 * Deterministic post-mortem derived purely from stored telemetry.
 * Same incident → same text (auditable, testable, no hallucinated numbers).
 */
export function buildHeuristicPostMortem(incident: Incident, svc: Service): string {
  const lines: string[] = []

  // Executive summary — Tomans first, gate compliance verdict.
  const gate = incident.mttdSec !== null ? (incident.mttdSec < 60 ? 'met' : 'violated') : 'pending'
  lines.push('EXECUTIVE SUMMARY')
  lines.push(
    `${svc.name} suffered a ${incident.severity} incident (${incident.source}) starting ` +
      `${incident.startedAt.toISOString()}. The platform recorded ${incident.lostTransactions.toLocaleString('en-US')} ` +
      `lost transactions worth ${fmtT(incident.revenueLossTomans)} in revenue, plus ${fmtT(incident.penaltyTomans)} ` +
      `in contractual SLA penalties. The 60-second contractual detection gate was ${gate}` +
      (incident.mttdSec !== null ? ` (MTTD ${fmtSec(incident.mttdSec)}).` : ' — detection still in progress at generation time.'),
  )
  lines.push('')

  // Technical assessment — hypotheses by fault class + detection quality.
  lines.push('TECHNICAL ASSESSMENT')
  const resolved = incident.resolvedAt !== null
  const detectDesc =
    incident.detectedAt !== null
      ? `Detection fired ${fmtSec(incident.mttdSec)} after fault start via the consecutive-probe-failure gate.`
      : 'Detection had not yet fired at generation time; the probe-failure streak was still accumulating.'
  lines.push(detectDesc)
  // v2.5: acknowledgment ownership, when on-call took the page.
  if (incident.acknowledgedAt && incident.acknowledgedBy) {
    lines.push(
      `On-call ownership was taken by ${incident.acknowledgedBy} ${fmtSec(incident.mttaSec)} after detection (MTTA)` +
        ` — the human response gap before recovery work started.`,
    )
  }
  // v2.6: escalation — the ladder fired before anyone acknowledged.
  if (incident.escalatedAt) {
    const escDelay =
      incident.escalatedAt && incident.detectedAt
        ? (incident.escalatedAt.getTime() - incident.detectedAt.getTime()) / 1000
        : null
    lines.push(
      `The escalation policy fired ${escDelay !== null ? fmtSec(escDelay) : 'past the timeout'} after detection without an acknowledgement — ` +
        `${incident.escalatedTo ?? 'the next on-call tier'} was paged (urgent technical page + management memo).`,
    )
  }
  for (const h of faultHypotheses(incident.severity, svc)) lines.push(`Likely cause: ${h}.`)
  lines.push(
    resolved
      ? `Recovery completed after ${fmtSec(incident.mttrSec)} (MTTR), returning the service to its ${svc.tps} tx/s baseline.`
      : 'The service had not yet recovered at generation time; on-call intervention remains available.',
  )
  lines.push('')

  // Recommendations — derived from measured gaps, not generic advice.
  lines.push('RECOMMENDATIONS')
  if (incident.mttdSec !== null && incident.mttdSec >= 30) {
    lines.push('- Tighten the probe-failure streak threshold — detection is consuming a third of the 60s gate budget.')
  }
  if (incident.mttrSec !== null && incident.mttrSec >= 120) {
    lines.push(`- Reduce MTTR (${fmtSec(incident.mttrSec)}): pre-authorized rollback runbook and automated failover for ${svc.name}.`)
  }
  if (incident.mttaSec !== null && incident.mttaSec >= 90) {
    lines.push(
      `- MTTA of ${fmtSec(incident.mttaSec)} shows a slow human response — wire paging directly into the on-call primary's device instead of the group channel.`,
    )
  }
  // v2.6: escalation went all the way — nobody acknowledged in time.
  if (incident.escalatedAt && incident.acknowledgedAt === null) {
    lines.push(
      '- Nobody acknowledged before the escalation timeout — review the primary paging path and consider a shorter ladder timeout for this service class.',
    )
  }
  if (incident.penaltyTomans > 0) {
    lines.push(`- Review the SLA penalty clause exposure (${fmtT(incident.penaltyTomans)}) with the account team — prevention here is cheaper than the penalty.`)
  }
  if (svc.criticality === 'core' || svc.criticality === 'high') {
    lines.push(`- Add ${svc.name} to the next chaos-drill rotation to validate failover under a repeat of this fault class.`)
  }
  if (lines[lines.length - 1] === 'RECOMMENDATIONS') {
    lines.push('- No elevated action required: detection and recovery both inside contractual envelopes.')
  }
  return lines.join('\n')
}

/** Parse the engine's event timeline (defensive — malformed rows are skipped). */
export function parseIncidentEvents(raw: string): IncidentEventRow[] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is IncidentEventRow =>
        !!e && typeof e === 'object' && typeof (e as IncidentEventRow).event === 'string',
    )
  } catch {
    return []
  }
}
