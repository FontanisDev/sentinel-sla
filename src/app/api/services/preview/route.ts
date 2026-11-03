// POST /api/services/preview — one-hour lookback of an UNSAVED probe-source
// candidate (onboarding wizard: "Preview the
// last hour of the signal before saving").
//
// Authz: engineer floor (same as service creation — this is an ops probe).
// Tenant-scoped users must belong to the tenant they preview for. Nothing is
// persisted; the request only exercises the configured Prometheus connection.
// When Prometheus is not configured the route fails with a NAMED error
// (prometheus-not-configured) so the wizard can show setup guidance instead
// of a generic failure.

import { NextResponse } from 'next/server';
import { HttpError, readJsonBody, toErrorResponse } from '@/server/http';
import { servicePreviewSchema } from '@/server/validation';
import { requireRole, requireTenantAccess } from '@/server/authz';
import { previewProbeSource, readPrometheusSettings } from '@/server/ingestion';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const user = await requireRole(req, 'engineer'); // phase-2 authz: ops probe
    const parsed = servicePreviewSchema.parse(await readJsonBody(req));
    if (parsed.tenantId) {
      await requireTenantAccess(user, parsed.tenantId);
    }

    const settings = await readPrometheusSettings();
    if (!settings) {
      throw new HttpError(
        400,
        'prometheus-not-configured: set the Prometheus connection under Settings → Integrations first',
      );
    }

    const preview = await previewProbeSource(
      parsed.probeSource,
      {
        endpoint: parsed.endpoint ?? 'https://preview.example.ir/health',
        slaTarget: parsed.slaTarget ?? 0.999,
      },
      settings,
    );
    return NextResponse.json({ preview });
  } catch (err) {
    return toErrorResponse(err);
  }
}
