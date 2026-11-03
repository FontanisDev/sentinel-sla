// Sentinel-SLA — v2.5 report archive retention.
//
// SlaReport rows and db/reports/*.pdf|payload-*.json accumulate forever in a
// long-lived deployment. Policy: keep the NEWEST `REPORTS_KEEP` reports (by
// generatedAt); older rows are deleted together with their PDF and payload
// sidecar files. Runs after every successful generation (fire-and-forget,
// never blocks the API response) — manual and scheduled alike.
//
// Raw SQL + fs only (HMR-safe under prisma db push, same pattern as the
// governance modules).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { db } from '@/lib/db';
import { getConfig } from '@/server/config';

/** Archive policy: newest reports kept, everything older is pruned. */
export const REPORTS_KEEP = 30;

/**
 * Locate a stored report PDF. Reports generated before the data-dir
 * move store absolute paths under the legacy db/reports; new ones live under
 * SENTINEL_DATA_DIR/reports. Resolution order:
 *   1. the stored path itself (legacy rows, prune compatibility)
 *   2. <configured reports dir>/<basename> (moved data dirs)
 * Both candidates are basename-guarded against traversal.
 */
export async function resolveReportFile(storedPath: string, fileName: string): Promise<string | null> {
  const config = getConfig();
  const candidates = [
    storedPath,
    path.join(config.reportsDir, path.basename(fileName)),
    // legacy location, for checkouts that never set SENTINEL_DATA_DIR
    path.join(config.projectRoot, 'db', 'reports', path.basename(fileName)),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

interface ReportRow {
  id: string;
  fileName: string;
  filePath: string;
}

/** Best-effort unlink — missing files are fine (already pruned by hand). */
async function unlinkQuiet(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    /* not there — nothing to do */
  }
}

/** The payload-<stamp>.json sidecar of a sentinel-sla-report-<stamp>.pdf. */
function payloadSidecarFor(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const stamp = base.replace(/^sentinel-sla-report-/, '').replace(/\.pdf$/, '');
  return path.join(dir, `payload-${stamp}.json`);
}

export interface PruneResult {
  pruned: number;
  kept: number;
}

/**
 * Enforce the archive policy once. Returns how many rows/files were removed
 * (0 most of the time). Callers should treat failures as non-fatal noise —
 * the next report generation retries the prune.
 */
export async function pruneReportArchive(keep = REPORTS_KEEP): Promise<PruneResult> {
  const rows = (await db.$queryRaw`
    SELECT id, fileName, filePath FROM SlaReport
    ORDER BY generatedAt DESC, id ASC
  `) as ReportRow[];
  if (rows.length <= keep) return { pruned: 0, kept: rows.length };

  const doomed = rows.slice(keep);
  for (const row of doomed) {
    await db.$executeRaw`DELETE FROM SlaReport WHERE id = ${row.id}`;
    await unlinkQuiet(row.filePath);
    await unlinkQuiet(payloadSidecarFor(row.filePath));
  }
  return { pruned: doomed.length, kept: rows.length - doomed.length };
}

/** Fire-and-forget wrapper used by reportgen after a successful generation. */
export function pruneReportArchiveSoon(): void {
  void pruneReportArchive()
    .then(({ pruned }) => {
      if (pruned > 0) {
        console.log(`[sentinel:reports] archive pruned: ${pruned} old report(s) removed (policy: newest ${REPORTS_KEEP})`);
      }
    })
    .catch((err) => {
      console.warn('[sentinel:reports] archive prune failed (non-fatal):', err instanceof Error ? err.message : err);
    });
}
