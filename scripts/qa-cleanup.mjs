#!/usr/bin/env node
// One-off QA cleanup after contract-test runs (dev DB only). Removes the
// scratch resources the harness created (round-trips already delete their
// own channels/rules/oncall/users; tenants have no DELETE route, so they
// are removed here along with windows, minted sessions and orphan runs).
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
const db = new PrismaClient();
const tenants = await db.tenant.deleteMany({ where: { key: { startsWith: 'qa-' } } });
const windows = await db.maintenanceWindow.deleteMany({ where: { reason: { startsWith: 'QA contract window' } } });
const sessions = await db.session.deleteMany({ where: { user: { email: 'qa-owner@sentinel.test' }, userAgent: 'qa-mint' } });
const orphanRuns = await db.$executeRawUnsafe(`DELETE FROM ScheduleRun WHERE scheduleId NOT IN (SELECT id FROM ReportSchedule)`);
// contract runs generate executive reports (POST /api/reports + regenerate) —
// remove rows created in the last 3 h plus their PDF files
const cutoff = new Date(Date.now() - 3 * 3600 * 1000);
const reports = await db.slaReport.findMany({ where: { generatedAt: { gte: cutoff } } });
for (const r of reports) {
  for (const base of ['reports', '.next/standalone/reports']) {
    const p = `${base}/${r.fileName}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}
const reportRows = await db.slaReport.deleteMany({ where: { generatedAt: { gte: cutoff } } });
console.log(JSON.stringify({ tenants: tenants.count, windows: windows.count, sessions: sessions.count, orphanRuns, reports: reportRows.count }));
await db.$disconnect();
