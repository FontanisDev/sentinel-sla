// One-time data fixup (SQLite): normalize legacy TEXT-stored DateTime
// columns to the ORM-native epoch-ms INTEGER representation.
//
// Root cause: earlier versions of several raw-SQL write paths passed
// ISO-8601 strings instead of Date objects. Prisma stores SQLite DateTime as
// INTEGER (epoch ms); SQLite type ordering puts TEXT above every number, so
// those rows silently never matched integer-normalized comparisons — planned
// maintenance windows vanished from the contract sheet (found by the
// end-to-end journey suite), windows never expired, and stuck outbox rows could never
// become due. The write paths are fixed in the same commit; this script
// migrates the rows the old code already wrote.
//
// Idempotent: only rows with typeof(col) = 'text' are touched. Safe to
// re-run. On Postgres (production layout) typed timestamp columns make this
// unnecessary — the script is a SQLite-only repair, not part of install.
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

/** table, column pairs that may hold legacy ISO-text dates */
const TARGETS = [
  ['MaintenanceWindow', ['startAt', 'endAt', 'createdAt']],
  ['EscalationPolicy', ['lastEscalatedAt', 'createdAt']],
  ['Tenant', ['createdAt']],
  ['AlertRule', ['lastFiredAt', 'createdAt']],
  ['NotificationChannel', ['lastDeliveryAt', 'createdAt']],
  ['ReportSchedule', ['lastRunAt', 'createdAt']],
  ['ScheduleRun', ['startedAt', 'createdAt']],
  ['NotificationOutbox', ['availableAt', 'createdAt']],
];

async function main() {
  let fixed = 0;
  for (const [table, cols] of TARGETS) {
    for (const col of cols) {
      // identifiers are from the fixed list above — never user input
      const rows = await db.$queryRawUnsafe(
        `SELECT id, "${col}" AS v FROM "${table}" WHERE typeof("${col}") = 'text'`,
      );
      for (const row of rows) {
        const ms = new Date(row.v).getTime();
        if (Number.isNaN(ms)) continue; // unparseable legacy junk — leave it
        await db.$executeRawUnsafe(
          `UPDATE "${table}" SET "${col}" = ? WHERE id = ?`,
          ms,
          row.id,
        );
        fixed += 1;
      }
      if (rows.length > 0) console.log(`${table}.${col}: normalized ${rows.length} text row(s)`);
    }
  }
  console.log(`done — ${fixed} value(s) normalized`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
