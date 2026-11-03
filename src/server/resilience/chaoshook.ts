// Sentinel-SLA — live-mode chaos: safe, opt-in customer hooks.
//
// The requirement: "Chaos in Live mode must act on real targets
// only through safe, opt-in hooks (a configured webhook or command the
// customer provides per service, for example to toggle a maintenance flag in
// a staging environment). Never kill customer production processes by
// default. Demo mode keeps simulated chaos."
//
// Implementation: a service opts in by storing chaosHookUrl (+ optional
// chaosHookSecret) on its row — managed like every other integration, never
// set by Sentinel itself. Launching chaos on that service in live mode POSTs
// a signed JSON envelope to the hook; the CUSTOMER's environment decides
// what the fault does (maintenance flag, test endpoint, canary reroute...).
// Sentinel never executes commands and never targets a service without a
// hook — the 409 names the missing opt-in. The payload is HMAC-SHA256
// signed (same scheme as notification webhooks) so the receiver can verify
// the experiment really came from this instance.
//
// MTTD/MTTR for hook experiments are measured through the REAL live
// pipeline: the ingestion loop observes the customer's signal dip and the
// open/resolve transitions finalize the experiment row.

import { db } from '@/lib/db';
import { HttpError } from '@/server/http';
import { SELFTEST_SERVICE_KEY } from '@/server/resilience/selftest';

export const CHAOS_HOOK_TIMEOUT_MS = 5000;

export interface ChaosHookPayload {
  experimentId: string;
  serviceKey: string;
  serviceName: string;
  type: string;
  durationSec: number;
  startedAt: string;
}

export interface ChaosHookResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
}

/** HMAC-SHA256 over the exact body bytes, hex — same scheme as notify webhooks. */
async function sign(secret: string, body: string): Promise<string> {
  const { createHmac } = await import('node:crypto');
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/**
 * POST the experiment envelope to the customer's opt-in hook. Never throws;
 * the result lands on the experiment row's notes either way.
 */
export async function dispatchChaosHook(
  url: string,
  secret: string | null,
  payload: ChaosHookPayload,
): Promise<ChaosHookResult> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Sentinel-SLA/2.0 chaos-hook',
  };
  if (secret) headers['X-Sentinel-Chaos-Signature'] = `sha256=${await sign(secret, body)}`;

  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAOS_HOOK_TIMEOUT_MS);
    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    clearTimeout(timer);
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return { ok: false, statusCode: res.status, latencyMs, error: `hook responded HTTP ${res.status}` };
    }
    return { ok: true, statusCode: res.status, latencyMs, error: null };
  } catch (err) {
    const msg =
      err instanceof Error && err.name === 'AbortError'
        ? `hook timed out after ${CHAOS_HOOK_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, statusCode: null, latencyMs: Date.now() - started, error: msg };
  }
}

/**
 * The single live-mode entry point for chaos (called by the engine).
 * Demo mode never reaches here. Rules, in order:
 *   1. The synthetic self-test target is managed by the self-test module —
 *      launching chaos on it through this path is refused with a name.
 *   2. No opt-in hook configured → 409 `chaos-hook-not-configured`.
 *   3. The hook is dispatched; failure marks the experiment failed honestly
 *      (the customer environment refused/did not answer) — detection cannot
 *      be expected, so no fake MTTD is ever recorded.
 */
export async function launchLiveChaos(svc: {
  id: string;
  key: string;
  name: string;
  chaosHookUrl: string | null;
  chaosHookSecret: string | null;
  enabled: boolean;
}): Promise<{ experimentId: string }> {
  if (svc.key === SELFTEST_SERVICE_KEY) {
    throw new HttpError(
      409,
      'This service is the self-test synthetic target — use the self-test run on /resilience instead.',
    );
  }
  if (!svc.chaosHookUrl) {
    throw new HttpError(
      409,
      `chaos-hook-not-configured: live-mode chaos only acts through a customer-provided hook. Configure one for ${svc.key} (staging targets only).`,
    );
  }
  const experiment = await db.chaosExperiment.create({
    data: {
      serviceId: svc.id,
      type: 'outage',
      status: 'running',
      plannedDurationSec: 0, // unknown in live mode — the customer hook owns the window
    },
  });
  const result = await dispatchChaosHook(svc.chaosHookUrl, svc.chaosHookSecret, {
    experimentId: experiment.id,
    serviceKey: svc.key,
    serviceName: svc.name,
    type: 'outage',
    durationSec: 0,
    startedAt: new Date().toISOString(),
  });
  await db.chaosExperiment.update({
    where: { id: experiment.id },
    data: {
      notes: result.ok
        ? `hook dispatched (${result.statusCode ?? 'ok'}) in ${result.latencyMs}ms`
        : `hook failed: ${result.error}`,
      status: result.ok ? 'running' : 'failed',
      endedAt: result.ok ? null : new Date(),
    },
  });
  console.log(
    `[sentinel:chaos] live hook ${result.ok ? 'dispatched' : 'FAILED'} for ${svc.key} ` +
      `(experiment ${experiment.id}${result.ok ? '' : `, ${result.error}`})`,
  );
  return { experimentId: experiment.id };
}

/**
 * Finalize the running chaos experiment of a live service when its incident
 * resolves (called from the ingestion resolution path). MTTD = incident
 * opened − experiment started; MTTR = the incident's own duration.
 */
export async function finalizeLiveChaosExperiment(serviceId: string, incident: {
  id: string;
  startedAt: Date;
  resolvedAt: Date | null;
  mttrSec: number | null;
}): Promise<void> {
  const experiment = await db.chaosExperiment.findFirst({
    where: { serviceId, status: 'running' },
    orderBy: { startedAt: 'desc' },
  });
  if (!experiment) return;
  const mttdSec = round1((incident.startedAt.getTime() - experiment.startedAt.getTime()) / 1000);
  const passed = mttdSec !== null && mttdSec < 60; // same SLA target as demo chaos
  await db.chaosExperiment.update({
    where: { id: experiment.id },
    data: {
      status: passed ? 'passed' : 'failed',
      gatePassed: passed,
      mttdSec,
      mttrSec: incident.mttrSec,
      endedAt: incident.resolvedAt ? new Date(incident.resolvedAt) : new Date(),
      notes: `${experiment.notes ?? ''} — detected via live ingestion (incident ${incident.id})`.trim(),
    },
  });
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
