// Sentinel-SLA — worker entrypoint (web/worker split, live-mode aware).
//
// One process owns the background loops:
//   SENTINEL_MODE=demo → the simulation engine tick, report scheduler and
//                        escalation ladder (unchanged behaviour);
//   SENTINEL_MODE=live → the Prometheus ingestion loop (the simulation code
//                        path is NOT started at all) + schedulers.
// The web process (SENTINEL_ROLE=web) boots the same modules with
// backgroundLoops=false and only reads state. Web and worker share the
// database — never memory.
//
// Run: bun run worker   (or: node dist/worker.js after the packaging)

import { getConfig } from '@/server/config';
import { getEngine } from '@/server/engine';
import { startIngestionLoop, stopIngestionLoop } from '@/server/ingestion';
import { startOutboxDispatcher, stopOutboxDispatcher } from '@/server/notify/outbox';

async function main(): Promise<void> {
  const config = getConfig();
  if (config.role === 'web') {
    console.error(
      '[sentinel:worker] refusing to start: SENTINEL_ROLE=web — this process must own the loops. ' +
        'Set SENTINEL_ROLE=worker (or all for single-process mode).',
    );
    process.exit(2);
  }

  console.log(`[sentinel:worker] starting — mode=${config.mode} pid=${process.pid}`);

  // In live mode getEngine() itself forces backgroundLoops=false (the live-mode
  // gate) — the simulator never ticks. Schedulers, however, must still fire,
  // so the worker owns a standalone report-schedule interval here.
  const engine = getEngine({ backgroundLoops: true });
  await engine.ensureInit();

  let ingestionStarted = false;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  if (config.mode === 'live') {
    const sec = startIngestionLoop();
    ingestionStarted = true;
    console.log(
      `[sentinel] mode=live — simulation disabled; ingestion every ${sec}s ` +
        `(failures>=${config.liveFailureThreshold} opens, successes>=${config.liveSuccessThreshold} resolves)`,
    );
    // Report schedules stay live in live mode (~60s cadence, advisory-locked).
    const { runDueReportSchedules } = await import('@/server/reportscheduling');
    // the executive digest schedule runs in live mode too.
    const { runDueDigests } = await import('@/server/notify/digest');
    // the weekly detection self-test runs in live mode too — its
    // fault window feeds the synthetic probe in the ingestion loop above.
    const { runDueSelfTests } = await import('@/server/resilience/selftest');
    timers.push(
      setInterval(() => {
        void runDueReportSchedules().catch((err: unknown) =>
          console.error('[sentinel:worker] report schedule run failed:', err instanceof Error ? err.message : err),
        );
        void runDueDigests().catch((err: unknown) =>
          console.error('[sentinel:worker] digest run failed:', err instanceof Error ? err.message : err),
        );
        void runDueSelfTests().catch((err: unknown) =>
          console.error('[sentinel:worker] selftest run failed:', err instanceof Error ? err.message : err),
        );
      }, 60_000),
    );
    // notifications deliver in live mode too (real transport by
    // default there — the engine did NOT start the dispatcher because live
    // mode forces its backgroundLoops off).
    startOutboxDispatcher();
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[sentinel:worker] ${signal} received — stopping loops`);
    for (const t of timers) clearInterval(t);
    if (ingestionStarted) stopIngestionLoop();
    stopOutboxDispatcher();
    engine.stop();
    // Prisma's connection pool closes with the process; exit promptly.
    setTimeout(() => process.exit(0), 250);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    console.error('[sentinel:worker] unhandled rejection:', reason);
  });

  // The engine's setInterval keeps the event loop alive; this resolution guard
  // only matters if all timers were somehow cleared.
  await new Promise<void>(() => undefined);
}

void main().catch((err) => {
  console.error('[sentinel:worker] fatal:', err);
  process.exit(1);
});
