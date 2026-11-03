// POST /api/rules/import — bulk import of alert rules from external
// monitoring systems (integrations: "Grafana/Zabbix alert
// import"). `source` selects the export format: 'grafana' (default — the
// JSON export of Grafana unified alerting) or 'zabbix' (the JSON array
// returned by trigger.get). Both map each rule/trigger's threshold
// expression onto one of Sentinel's four metrics and create policy rules
// through the SAME pipeline as POST /api/rules (createAlertRuleSchema +
// createAlertRule) — an imported rule can never be something the API would
// reject.
//
// Journey: paste/upload the export → dry-run (default; maps every row,
// writes nothing, reports unmapped rows with the exact reason) → commit.
// Commit is all-or-nothing: ANY unmapped, duplicated or unknown-service
// row aborts the whole import (422) — a half-imported alert policy is
// worse than none, because coverage gaps are invisible later.
//
// Authz mirrors POST /api/rules exactly: engineer+ floor (importing rules
// is rule creation, evaluated per row by the same engine).

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getEngine } from '@/server/engine';
import { HttpError, readJsonBody, toErrorResponse } from '@/server/http';
import { requireRole } from '@/server/authz';
import { createAlertRule } from '@/server/alertgovernance';
import { IMPORT_MAX_BYTES, importGrafanaRules } from '@/server/grafana-import';
import { importZabbixTriggers } from '@/server/zabbix-import';
import type { MappedRow } from '@/server/grafana-import';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    await requireRole(req, 'engineer');
    const body = (await readJsonBody(req)) as { json?: unknown; mode?: unknown; source?: unknown };

    if (typeof body.json !== 'string' || body.json.trim() === '') {
      throw new HttpError(400, "Body must be JSON with a non-empty 'json' string (the export)");
    }
    if (body.json.length > IMPORT_MAX_BYTES) {
      throw new HttpError(413, `Export exceeds ${IMPORT_MAX_BYTES} bytes`);
    }
    // dryRun is the default — writes only happen on explicit mode='commit'.
    const effectiveMode = body.mode === 'commit' ? 'commit' : 'dryRun';
    // 'grafana' is the default source (round-38 contract); 'zabbix' selects
    // the trigger.get shape. Same downstream pipeline for both.
    const source = body.source === 'zabbix' ? 'zabbix' : 'grafana';

    const parsed = source === 'zabbix' ? importZabbixTriggers(body.json) : importGrafanaRules(body.json);
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    const rows = parsed.rows;

    // Service labels ('service' / 'sentinel_service') resolve against the
    // registry by name or key, case-insensitively — a stale label must stop
    // the import (a fleet-wide rule that was meant for one service fires
    // money-relevant alerts for the wrong clients).
    const services = (await db.$queryRaw`
      SELECT id, key, name FROM Service
    `) as Array<{ id: string; key: string; name: string }>;
    const byLabel = new Map<string, string>();
    for (const s of services) {
      byLabel.set(s.name.toLowerCase(), s.id);
      byLabel.set(s.key.toLowerCase(), s.id);
    }

    const seenNames = new Set<string>();
    let failures = 0;
    for (const row of rows) {
      const r = row as MappedRow & { error?: string };
      try {
        if (!r.ok || !r.rule) throw new HttpError(400, r.error ?? 'unmapped rule');
        if (seenNames.has(r.rule.name)) {
          throw new HttpError(409, `duplicate rule name '${r.rule.name}' earlier in this export`);
        }
        seenNames.add(r.rule.name);
        if (r.rule.serviceLabel) {
          const serviceId = byLabel.get(r.rule.serviceLabel.toLowerCase());
          if (!serviceId) {
            throw new HttpError(
              404,
              `label service='${r.rule.serviceLabel}' matches no Sentinel service (by key or name, case-insensitive) — fix the label or remove it to import as a fleet rule`,
            );
          }
        }
        // Duplicate name already registered — importing twice must never
        // silently duplicate the alert policy (double alerts = wrong money).
        const existing = (await db.$queryRaw`
          SELECT id FROM AlertRule WHERE name = ${r.rule.name} LIMIT 1
        `) as Array<{ id: string }>;
        if (existing.length > 0) {
          throw new HttpError(409, `rule name '${r.rule.name}' already exists — deduplicate the export or rename`);
        }
      } catch (err) {
        if (err instanceof HttpError) r.error = err.message;
        else r.error = 'Unexpected row error';
        r.ok = false;
        r.rule = undefined;
        failures += 1;
      }
    }

    const total = rows.length;
    const ok = total - failures;
    const report = { source, mode: effectiveMode, total, ok, failed: failures, rows };

    if (effectiveMode !== 'commit') {
      return NextResponse.json({ ...report, committed: false });
    }

    if (failures > 0) {
      return NextResponse.json(
        {
          ...report,
          committed: false,
          error: `Import aborted: ${failures} of ${total} rule(s) did not map. Fix or remove them and re-run (the dry-run reports every failing row at once).`,
        },
        { status: 422 },
      );
    }

    // All rows validated — create each through the governance layer (same
    // path as POST /api/rules, incl. its audit trail + engine visibility).
    const createdIds: string[] = [];
    for (const row of rows) {
      const rule = row.rule!; // validated above — no failures reached here
      const serviceId = rule.serviceLabel
        ? (byLabel.get(rule.serviceLabel.toLowerCase()) ?? null)
        : null;
      const created = await createAlertRule({
        name: rule.name,
        serviceId,
        metric: rule.metric,
        operator: rule.operator,
        threshold: rule.threshold,
        severity: rule.severity,
        ...(rule.cooldownMin !== undefined ? { cooldownMin: rule.cooldownMin } : {}),
      });
      createdIds.push(created.id);
    }

    // Rules are read per tick from the DB by the engine — no reload needed;
    // touching the engine getter keeps the single-POST parity explicit.
    void getEngine();

    return NextResponse.json({ ...report, committed: true, ruleIds: createdIds }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
