// Next.js instrumentation hook — boots the Sentinel-SLA background world
// with the server. getEngine() is idempotent via a globalThis guard, so API
// routes calling it again never create a second instance.
//
// role split: the engine tick/schedulers/escalation belong to the
// worker process (src/worker/index.ts, SENTINEL_ROLE=worker) or to a
// single-process deployment (SENTINEL_ROLE=all). A role=web server loads
// engine state for reads but never starts background loops.
//
// mode split:
//   SENTINEL_MODE=demo (default) → simulation engine as before.
//   SENTINEL_MODE=live           → the simulation code path is NOT started;
//                                  the live ingestion loop owns the tick.
// The startup banner states the mode (the UI shows it
// too — ModeBadge on the dashboard).
//
// NOTE: imports here MUST stay dynamic inside register() — instrumentation is
// also compiled for the Edge runtime, and a static import would pull node
// modules (fs/path/prisma) into that bundle and crash it.

const BACKGROUND_LOOPS_BY_ROLE: Record<string, boolean> = {
  all: true, // single process: web + worker in one (simple installs)
  web: false, // loops live in the worker process
  worker: false, // misconfigured web process in worker mode: worker entrypoint owns loops
};

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { getConfig } = await import('./server/config');
    const config = getConfig();

    if (config.mode === 'live') {
      // LIVE: never boot the simulator. The ingestion loop polls Prometheus.
      if (BACKGROUND_LOOPS_BY_ROLE[config.role] ?? true) {
        const { startIngestionLoop } = await import('./server/ingestion');
        startIngestionLoop();
        console.log(
          `[sentinel] mode=live — simulation disabled; ingestion every ${config.pollIntervalSec}s ` +
            `(failures>${config.liveFailureThreshold - 1} opens, successes>=${config.liveSuccessThreshold} resolves)`,
        );
      } else {
        console.log('[sentinel] mode=live — web process: ingestion owned by the worker');
      }
      return;
    }

    // DEMO: simulation engine (unchanged behaviour).
    const { getEngine } = await import('./server/engine');
    getEngine({ backgroundLoops: BACKGROUND_LOOPS_BY_ROLE[config.role] ?? true });
    console.log(`[sentinel] mode=demo — simulation engine active (role=${config.role})`);
  }
}
