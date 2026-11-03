// GET /api/health/live — liveness: the process is up and its config is valid.
// Never touches the database. Public by design (allow-listed in the authz layer).

import { getConfig } from '@/server/config';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const config = getConfig();
    return NextResponse.json(
      {
        status: 'ok',
        service: 'sentinel-sla',
        mode: config.mode,
        role: config.role,
        ts: new Date().toISOString(),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return NextResponse.json(
      { status: 'fail', error: err instanceof Error ? err.message : 'config invalid' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
