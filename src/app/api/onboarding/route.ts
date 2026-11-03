// GET /api/onboarding — guided setup: the getting-started checklist.
//
// Read-only aggregation of REAL counts (tenants, services excluding the
// self-test synthetic target, tenant-bound services, channels, reports) plus
// the signal-source configuration state (stored Prometheus connection, or an
// honest "demo simulation" marker in demo mode). Viewer+ floor (requireUser)
// — every role benefits from seeing what is configured; nothing here is a
// secret (no counts are sensitive and no configuration values are echoed).

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getEngine } from '@/server/engine';
import { requireUser } from '@/server/authz';
import { readPrometheusSettings } from '@/server/ingestion';
import { getConfig } from '@/server/config';
import { computeOnboardingSteps, onboardingProgress, type OnboardingCounts } from '@/server/onboarding';
import { toErrorResponse } from '@/server/http';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requireUser(req);
    await getEngine().ensureInit();

    const [tenantRows, serviceRows, tenantServiceRows, channelRows, reportRows, prometheus] = (await Promise.all([
      db.$queryRaw`SELECT COUNT(*) AS n FROM Tenant`,
      db.$queryRaw`SELECT COUNT(*) AS n FROM Service WHERE key != 'selftest-synthetic'`,
      db.$queryRaw`SELECT COUNT(*) AS n FROM Service WHERE key != 'selftest-synthetic' AND tenantId IS NOT NULL`,
      db.$queryRaw`SELECT COUNT(*) AS n FROM NotificationChannel`,
      db.$queryRaw`SELECT COUNT(*) AS n FROM SlaReport`,
      readPrometheusSettings().catch(() => null),
    ])) as [Array<{ n: number | bigint }>, Array<{ n: number | bigint }>, Array<{ n: number | bigint }>, Array<{ n: number | bigint }>, Array<{ n: number | bigint }>, unknown];

    const counts: OnboardingCounts = {
      prometheusConfigured: prometheus !== null,
      mode: getConfig().mode === 'live' ? 'live' : 'demo',
      tenants: Number((tenantRows[0] as { n: number | bigint } | undefined)?.n ?? 0),
      services: Number((serviceRows[0] as { n: number | bigint } | undefined)?.n ?? 0),
      // a service is "under contract" when it belongs to a client tenant
      servicesWithTenant: Number((tenantServiceRows[0] as { n: number | bigint } | undefined)?.n ?? 0),
      channels: Number((channelRows[0] as { n: number | bigint } | undefined)?.n ?? 0),
      reports: Number((reportRows[0] as { n: number | bigint } | undefined)?.n ?? 0),
    };

    const steps = computeOnboardingSteps(counts);
    return NextResponse.json({
      steps,
      ...onboardingProgress(steps),
      mode: counts.mode,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
