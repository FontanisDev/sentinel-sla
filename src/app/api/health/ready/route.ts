// GET /api/health/ready — readiness: the app can serve traffic.
// Checks (fast, no engine tick dependency):
//   1. configuration valid (getConfig throws with a readable message)
//   2. database reachable (SELECT 1)
//   3. report pipeline configured (report python + script + bundled fonts) — reported
//      as a sub-status, NOT a hard failure: reports are a feature, not traffic.
// `curl /api/health/ready` returns 200 on a healthy install.

import { promises as fs } from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getConfig } from '@/server/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  let config;
  try {
    config = getConfig();
    checks.config = { ok: true };
  } catch (err) {
    checks.config = { ok: false, detail: err instanceof Error ? err.message : 'invalid' };
    return NextResponse.json(
      { status: 'fail', checks, ts: new Date().toISOString() },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    await db.$queryRaw`SELECT 1`;
    checks.database = { ok: true };
  } catch (err) {
    checks.database = { ok: false, detail: err instanceof Error ? err.message : 'unreachable' };
  }

  // Report pipeline readiness (informational).
  try {
    const missing: string[] = [];
    if (!config.reportPython) missing.push('REPORT_PYTHON');
    try {
      await fs.access(config.reportWeasyScript);
    } catch {
      missing.push(`report script (${config.reportWeasyScript})`);
    }
    // Fonts are bundled (public/fonts: Inter, Vazirmatn, JetBrains Mono); no system font is needed.
    try {
      await fs.access(path.join(config.projectRoot, 'public', 'fonts', 'vazirmatn-arabic-wght-normal.woff2'));
    } catch {
      missing.push('bundled fonts (public/fonts)');
    }
    checks.reportPipeline =
      missing.length === 0
        ? { ok: true }
        : { ok: false, detail: `missing: ${missing.join(', ')}` };
  } catch (err) {
    checks.reportPipeline = {
      ok: false,
      detail: err instanceof Error ? err.message : 'unknown',
    };
  }

  const ok = Object.entries(checks)
    .filter(([name]) => name !== 'reportPipeline')
    .every(([, c]) => c.ok);

  return NextResponse.json(
    { status: ok ? 'ok' : 'fail', checks, ts: new Date().toISOString() },
    { status: ok ? 200 : 500, headers: { 'Cache-Control': 'no-store' } },
  );
}
