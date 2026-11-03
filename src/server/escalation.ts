// Sentinel-SLA — v2.6 escalation policy data access.
//
// Single fleet-wide policy row: when a DETECTED incident stays unacknowledged
// past `timeoutMin`, the engine pages the secondary on-call and informs the
// executive channel (Slack/PagerDuty-style escalation ladder). Same
// parameterized raw-SQL pattern as alertgovernance.ts (HMR-safe under
// `prisma db push`; every value bound — OWASP ASVS L1).

import { db } from '@/lib/db';
import { HttpError } from '@/server/http';
import type { EscalationPolicyDTO, UpdateEscalationPayload } from '@/lib/types';

export interface EscalationPolicyRow {
  id: string;
  name: string;
  timeoutMin: number | unknown;
  appliesTo: string;
  enabled: number | unknown;
  timesEscalated: number | unknown;
  lastEscalatedAt: Date | string | null;
  createdAt: Date | string;
}

function newId(): string {
  const t = Date.now().toString(36).padStart(8, '0');
  const rand = Math.random().toString(36).slice(2, 12);
  return `c${t}${rand}`;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function toEscalationPolicyDTO(row: EscalationPolicyRow): EscalationPolicyDTO {
  return {
    id: row.id,
    name: row.name,
    timeoutMin: Number(row.timeoutMin ?? 2),
    appliesTo: row.appliesTo === 'all' ? 'all' : 'critical',
    enabled: Number(row.enabled ?? 1) === 1,
    timesEscalated: Number(row.timesEscalated ?? 0),
    lastEscalatedAt: toIso(row.lastEscalatedAt),
    createdAt: toIso(row.createdAt) ?? new Date().toISOString(),
  };
}

// Column list is spelled literally in every query below — compile-time
// identifiers, never user input, so no binding is needed (OWASP ASVS L1).

/**
 * The fleet policy — creates the default row on first read (idempotent seed),
 * so the dashboard and the engine always see a policy, never a gap.
 */
export async function getEscalationPolicy(): Promise<EscalationPolicyDTO> {
  const rows = (await db.$queryRaw`
    SELECT id, name, timeoutMin, appliesTo, enabled, timesEscalated, lastEscalatedAt, createdAt
    FROM EscalationPolicy LIMIT 1
  `) as EscalationPolicyRow[];
  if (rows.length > 0) return toEscalationPolicyDTO(rows[0]);
  const id = newId();
  const now = new Date(); // Date param → ORM-native storage (see maintenance.ts note)
  await db.$executeRaw`
    INSERT INTO EscalationPolicy (id, name, timeoutMin, appliesTo, enabled, timesEscalated, lastEscalatedAt, createdAt)
    VALUES (${id}, 'Page the secondary after 2 min unacknowledged', 2, 'critical', 1, 0, NULL, ${now})
  `;
  const fresh = (await db.$queryRaw`
    SELECT id, name, timeoutMin, appliesTo, enabled, timesEscalated, lastEscalatedAt, createdAt
    FROM EscalationPolicy WHERE id = ${id} LIMIT 1
  `) as EscalationPolicyRow[];
  return toEscalationPolicyDTO(fresh[0]);
}

/** PUT /api/escalation — edit the fleet policy (name/timeout/appliesTo/enabled). */
export async function updateEscalationPolicy(payload: UpdateEscalationPayload): Promise<EscalationPolicyDTO> {
  const current = await getEscalationPolicy(); // ensures the row exists
  const name = payload.name?.trim() ?? current.name;
  const timeoutMin = payload.timeoutMin ?? current.timeoutMin;
  const appliesTo = payload.appliesTo ?? current.appliesTo;
  const enabled = payload.enabled ?? current.enabled;
  await db.$executeRaw`
    UPDATE EscalationPolicy
    SET name = ${name}, timeoutMin = ${timeoutMin}, appliesTo = ${appliesTo},
        enabled = ${enabled ? 1 : 0}
    WHERE id = ${current.id}
  `;
  const rows = (await db.$queryRaw`
    SELECT id, name, timeoutMin, appliesTo, enabled, timesEscalated, lastEscalatedAt, createdAt
    FROM EscalationPolicy WHERE id = ${current.id} LIMIT 1
  `) as EscalationPolicyRow[];
  if (rows.length === 0) throw new HttpError(500, 'Escalation policy update failed');
  return toEscalationPolicyDTO(rows[0]);
}

/** Engine bookkeeping after a fired escalation page (timesEscalated + stamp). */
export async function markPolicyEscalated(id: string): Promise<void> {
  const now = new Date(); // Date param → ORM-native storage
  await db.$executeRaw`
    UPDATE EscalationPolicy
    SET timesEscalated = COALESCE(timesEscalated, 0) + 1, lastEscalatedAt = ${now}
    WHERE id = ${id}
  `;
}
