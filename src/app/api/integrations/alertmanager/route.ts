// POST /api/integrations/alertmanager — Alertmanager webhook receiver.
//
// Auth: `Authorization: Bearer <SENTINEL_WEBHOOK_BEARER>` — this route is
// deliberately OUTSIDE the session/RBAC system (Alertmanager cannot hold a
// session); the shared secret IS the authentication. 503 when the secret is
// not configured, 401 on mismatch.
//
// Semantics:
//   • idempotent — every (source, fingerprint) pair is recorded once in
//     IntegrationEvent; re-deliveries return 200 without side effects
//   • supports `firing` and `resolved` ends
//   • maps labels to services via `service` / `serviceKey` / `instance`
//   • firing  → open a live incident (source 'live', evidence = payload)
//   • resolved→ resolve the open live incident for that service
// De-dup rule: the same (fingerprint, status) re-delivery is a no-op; a
// firing→resolved→firing cycle is legitimate and re-opens (new incident).

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { toErrorResponse, HttpError } from '@/server/http';
import { getConfig } from '@/server/config';
import { penaltyFixedPerMinute } from '@/domain/contract';

export const dynamic = 'force-dynamic';

interface AmAlert {
  status?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  fingerprint?: string;
  startsAt?: string;
  endsAt?: string;
}

interface AmPayload {
  alerts?: AmAlert[];
  status?: string;
}

function resolveServiceKey(labels: Record<string, string> | undefined): string | null {
  if (!labels) return null;
  return labels.serviceKey ?? labels.service ?? labels.sentinel_service ?? null;
}

export async function POST(req: Request) {
  try {
    const config = getConfig();
    if (!config.webhookBearer) {
      throw new HttpError(503, 'Alertmanager webhook is not configured (set SENTINEL_WEBHOOK_BEARER).');
    }
    const auth = req.headers.get('authorization') ?? '';
    const expected = `Bearer ${config.webhookBearer}`;
    if (auth !== expected) {
      throw new HttpError(401, 'Invalid webhook bearer token.');
    }

    const payload = (await req.json().catch(() => null)) as AmPayload | null;
    if (!payload || !Array.isArray(payload.alerts)) {
      throw new HttpError(400, 'Body must be an Alertmanager JSON payload with an alerts array.');
    }

    const results: Array<{ fingerprint: string; action: string }> = [];
    for (const alert of payload.alerts) {
      const fingerprint = alert.fingerprint ?? `${alert.labels?.alertname ?? 'unknown'}:${resolveServiceKey(alert.labels) ?? 'none'}`;
      const status = (alert.status ?? payload.status ?? 'firing') === 'resolved' ? 'resolved' : 'firing';
      const serviceKey = resolveServiceKey(alert.labels);
      const service = serviceKey
        ? await db.service.findUnique({ where: { key: serviceKey } })
        : null;

      // Idempotency: (source, fingerprint, status) triple. A re-delivery of
      // the SAME status is a no-op; the opposite status is a legitimate flip.
      const recent = await db.integrationEvent.findUnique({
        where: { source_fingerprint: { source: 'alertmanager', fingerprint } },
      });
      if (recent && recent.status === status) {
        results.push({ fingerprint, action: 'duplicate' });
        continue;
      }
      await db.integrationEvent.upsert({
        where: { source_fingerprint: { source: 'alertmanager', fingerprint } },
        update: { status, payload: JSON.stringify(alert), receivedAt: new Date(), incidentId: recent?.incidentId ?? null },
        create: { source: 'alertmanager', fingerprint, status, payload: JSON.stringify(alert) },
      });

      if (!service) {
        results.push({ fingerprint, action: 'unmapped-service' });
        continue;
      }

      if (status === 'firing') {
        const ongoing = await db.incident.findFirst({
          where: { serviceId: service.id, status: 'ongoing', source: 'live' },
          orderBy: { startedAt: 'desc' },
        });
        if (ongoing) {
          results.push({ fingerprint, action: 'already-firing' });
          continue;
        }
        const startedAt = alert.startsAt ? new Date(alert.startsAt) : new Date();
        const evidence = {
          rule: { kind: 'alertmanager-webhook', alert: alert.labels?.alertname ?? 'unknown', matcher: alert.labels },
          samples: [{ ok: false, value: null, atMs: startedAt.getTime(), query: `alert ${fingerprint}` }],
          contractVersion: null,
          moneyModelVersion: null,
          breakdown: null,
          annotations: alert.annotations ?? {},
        };
        const incident = await db.incident.create({
          data: {
            serviceId: service.id,
            status: 'ongoing',
            severity: (alert.labels?.severity === 'warning' ? 'warning' : 'critical') as string,
            source: 'live',
            startedAt,
            events: JSON.stringify([
              { ts: startedAt.toISOString(), event: 'fault_started', detail: `alertmanager: ${alert.labels?.alertname ?? 'alert'}` },
            ]),
            evidence: JSON.stringify(evidence),
          },
        });
        await db.integrationEvent.update({
          where: { source_fingerprint: { source: 'alertmanager', fingerprint } },
          data: { incidentId: incident.id },
        });
        await db.service.update({
          where: { id: service.id },
          data: { liveStatus: 'down', liveIncidentOpen: true, lastPolledAt: new Date() },
        });
        await db.alert.create({
          data: {
            serviceId: service.id,
            incidentId: incident.id,
            channel: 'dashboard',
            audience: 'technical',
            severity: incident.severity,
            title: `LIVE alert: ${service.name}`,
            message: alert.annotations?.description ?? alert.annotations?.summary ?? `Alertmanager fired ${alert.labels?.alertname ?? 'an alert'}.`,
            status: 'delivered',
          },
        });
        results.push({ fingerprint, action: 'opened' });
      } else {
        const ongoing = await db.incident.findFirst({
          where: { serviceId: service.id, status: 'ongoing', source: 'live' },
          orderBy: { startedAt: 'desc' },
        });
        if (!ongoing) {
          results.push({ fingerprint, action: 'nothing-to-resolve' });
          continue;
        }
        const endedAt = alert.endsAt ? new Date(alert.endsAt) : new Date();
        const endMs = Math.max(endedAt.getTime(), ongoing.startedAt.getTime());
        const durationSec = Math.round(((endMs - ongoing.startedAt.getTime()) / 1000) * 10) / 10;
        const penalty =
          Number.isSafeInteger(service.penaltyBase) && Number.isSafeInteger(service.penaltyPerMinute)
            ? penaltyFixedPerMinute(service.penaltyBase, service.penaltyPerMinute, Math.max(0, Math.round(durationSec)))
            : service.penaltyBase + service.penaltyPerMinute * Math.max(1, Math.ceil(durationSec / 60));
        const events = JSON.parse(ongoing.events || '[]') as Array<{ ts: string; event: string; detail?: string }>;
        events.push({ ts: endedAt.toISOString(), event: 'resolved', detail: `alertmanager resolved ${fingerprint}` });
        await db.incident.update({
          where: { id: ongoing.id },
          data: {
            status: 'resolved',
            resolvedAt: endedAt,
            durationSec,
            mttrSec: durationSec,
            penaltyTomans: penalty,
            events: JSON.stringify(events),
          },
        });
        await db.service.update({
          where: { id: service.id },
          data: { liveStatus: 'up', liveIncidentOpen: false, lastPolledAt: new Date() },
        });
        results.push({ fingerprint, action: 'resolved' });
      }
    }

    return NextResponse.json({ ok: true, processed: results.length, results });
  } catch (err) {
    return toErrorResponse(err);
  }
}
