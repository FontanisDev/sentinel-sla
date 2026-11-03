// POST /api/integrations/prometheus/test — "Test connection" button.
//
// Accepts EITHER a stored connection (no body) or an unsaved candidate
// { baseUrl, auth } so the Settings UI can verify before saving.
// Probes: GET <base>/-/healthy (Prometheus liveness) then a trivial
// /api/v1/query — reports version + round-trip latency. Never stores.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { toErrorResponse, HttpError } from '@/server/http';
import { requireRole } from '@/server/authz';
import { readPrometheusSettings, promInstantQuery, type PrometheusSettings } from '@/server/ingestion';

export const dynamic = 'force-dynamic';

const authSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('basic'), username: z.string().min(1).max(120), password: z.string().min(1).max(240) }),
  z.object({ kind: z.literal('bearer'), token: z.string().min(1).max(240) }),
]);

const bodySchema = z
  .object({
    baseUrl: z.string().trim().url().max(300),
    auth: authSchema.optional(),
  })
  .optional();

export async function POST(req: Request) {
  try {
    await requireRole(req, 'admin');
    let settings: PrometheusSettings | null = null;
    const raw = await req.json().catch(() => undefined);
    const parsed = raw === undefined ? undefined : bodySchema.parse(raw);
    if (parsed) {
      settings = { baseUrl: parsed.baseUrl.replace(/\/+$/, ''), auth: parsed.auth ?? { kind: 'none' } };
    } else {
      settings = await readPrometheusSettings();
    }
    if (!settings) {
      throw new HttpError(400, 'No connection to test: pass { baseUrl, auth } or save the settings first.');
    }

    const started = Date.now();
    const healthyUrl = `${settings.baseUrl.replace(/\/+$/, '')}/-/healthy`;
    let healthy = false;
    try {
      const res = await fetch(healthyUrl, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
      healthy = res.ok;
    } catch {
      healthy = false;
    }
    // buildinfo gives the version; a failed buildinfo must not fail the whole probe
    let version: string | null = null;
    try {
      const res = await fetch(`${settings.baseUrl.replace(/\/+$/, '')}/api/v1/status/buildinfo`, {
        headers: settings.auth.kind === 'bearer' ? { Authorization: `Bearer ${settings.auth.token}` } : {},
        signal: AbortSignal.timeout(5000),
        cache: 'no-store',
      });
      if (res.ok) {
        const body = (await res.json()) as { data?: { version?: string } };
        version = body.data?.version ?? null;
      }
    } catch {
      version = null;
    }
    // the authoritative check: an actual query round-trip
    const query = await promInstantQuery(settings, '1+1', 5000);
    const latencyMs = Date.now() - started;

    return NextResponse.json({
      ok: query.value === 2,
      healthy,
      version,
      latencyMs,
      queryValue: query.value,
      baseUrl: settings.baseUrl,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
