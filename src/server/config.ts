// Sentinel-SLA — central typed configuration.
//
// Every environment input the server depends on is declared here exactly once,
// validated with zod at start-up, and fails fast with a readable message.
// Rules enforced by this module:
//   * data paths come from SENTINEL_DATA_DIR (never ad-hoc process.cwd() joins
//     scattered through the code) — the production server runs from
//     .next/standalone whose cwd differs from the repo root;
//   * the report python interpreter is REPORT_PYTHON (legacy alias PYTHON_BIN
//     still honoured), auto-detected on PATH as a last resort and surfaced as
//     `null` (never a guess) so callers can emit a "not configured" error that
//     names the exact env var to set;
//   * no secret is ever logged.
//
// Usage: import { getConfig } from '@/server/config' — first call validates and
// freezes the config; later calls return the cached instance.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required (e.g. file:../db/custom.db for SQLite)'),
  PORT: z.coerce.number().int().positive().default(3000),

  /** demo = simulation engine allowed; live = simulation code path never starts. */
  SENTINEL_MODE: z.enum(['demo', 'live']).default('demo'),

  /**
   * Which background loops this process owns:
   *   all    → single-process deployment (simple installs): web + worker in one
   *   web    → HTTP only, engine tick/schedulers live in the worker process
   *   worker → background loops only (src/worker/index.ts entrypoint)
   */
  SENTINEL_ROLE: z.enum(['all', 'web', 'worker']).default('all'),

  /** Root for generated/derived artefacts (reports, uploads). Explicit in production. */
  SENTINEL_DATA_DIR: z.string().min(1).optional(),
  /** Directory holding FreeSerif*.ttf for the report pipeline (auto-detected when unset). */
  SENTINEL_FONT_DIR: z.string().optional(),
  FONT_DIR: z.string().optional(), // legacy alias honoured by reports/sla_report.py
  /** Python interpreter for the PDF pipeline; auto-detected when unset. */
  REPORT_PYTHON: z.string().optional(),
  PYTHON_BIN: z.string().optional(), // legacy alias
  /** Full path to the report generator script (defaults under the project root). */
  REPORT_SCRIPT: z.string().optional(),
  /** Full path to the WeasyPrint renderer (pipeline; defaults under the project root). */
  REPORT_WEASY_SCRIPT: z.string().optional(),

  // ── live mode ──────────────────────────────────────────────
  /** Seconds between ingestion polls of the Prometheus API. Default 15. */
  SENTINEL_POLL_INTERVAL_SEC: z.coerce.number().int().min(5).max(3600).default(15),
  /** Consecutive failed probes before a live incident opens. Default 3. */
  SENTINEL_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(1000).default(3),
  /** Consecutive successful probes before a live incident resolves. Default 2. */
  SENTINEL_SUCCESS_THRESHOLD: z.coerce.number().int().min(1).max(1000).default(2),
  /** Bearer secret the Alertmanager webhook requires (webhook_config bearer_token). */
  SENTINEL_WEBHOOK_BEARER: z.string().min(16).optional(),

  // ── notifications ─────────────────────────────────────────
  /** Transport: auto = real in live mode / simulate in demo; simulate forces offline bookkeeping. */
  SENTINEL_NOTIFY_TRANSPORT: z.enum(['auto', 'simulate', 'real']).default('auto'),
  /** Bot tokens (IntegrationSetting keys win over these env fallbacks). */
  SENTINEL_TELEGRAM_BOT_TOKEN: z.string().min(8).optional(),
  SENTINEL_BALE_BOT_TOKEN: z.string().min(8).optional(),
  /** API bases — override for self-hosted/air-gapped Bot API or tests. */
  SENTINEL_TELEGRAM_API_BASE: z.string().url().optional(),
  SENTINEL_BALE_API_BASE: z.string().url().optional(),
  /** HMAC secret for signed /ack links (or IntegrationSetting key ackSecret). */
  SENTINEL_ACK_SECRET: z.string().min(32).optional(),
  /** Public origin used inside ack links shown in messages. */
  SENTINEL_PUBLIC_BASE_URL: z.string().url().optional(),
  /** Minimal-SMTP email transport; host unset = email adapter reports not-configured. */
  SENTINEL_SMTP_HOST: z.string().min(1).optional(),
  SENTINEL_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SENTINEL_SMTP_USER: z.string().optional(),
  SENTINEL_SMTP_PASS: z.string().optional(),
  SENTINEL_SMTP_FROM: z.string().email().optional(),
  /** '1' = implicit TLS (port 465 style); default is plaintext+AUTH (LAN relay). */
  SENTINEL_SMTP_IMPLICIT_TLS: z.enum(['0', '1']).optional(),
});

export type SentinelMode = 'demo' | 'live';
export type SentinelRole = 'all' | 'web' | 'worker';

export interface SentinelConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  mode: SentinelMode;
  role: SentinelRole;
  /** Project root — safe for READ-ONLY bundled assets (scripts), never for writes. */
  projectRoot: string;
  /** Mutable artefacts (reports, uploads) live here. */
  dataDir: string;
  reportsDir: string;
  /** FreeSerif font dir for the report pipeline; null = caller must report "not configured". */
  fontDir: string | null;
  /** Python interpreter for the PDF pipeline; null = "not configured", caller names the env var. */
  reportPython: string | null;
  reportScript: string;
  /** WeasyPrint renderer script (HTML→PDF pipeline). */
  reportWeasyScript: string;
  /** Live-mode ingestion interval (seconds). */
  pollIntervalSec: number;
  /** Consecutive failed probes before a live incident opens. */
  liveFailureThreshold: number;
  /** Consecutive successful probes before a live incident resolves. */
  liveSuccessThreshold: number;
  /** Alertmanager webhook bearer secret; null = webhook returns 503 not-configured. */
  webhookBearer: string | null;
  /** Notification transport: auto resolves to real|simulate by mode. */
  notifyTransport: 'auto' | 'simulate' | 'real';
}

/** Read-only helper: which candidate dir actually contains FreeSerif.ttf? */
function detectFontDir(explicit: string | undefined): string | null {
  const candidates = [
    explicit,
    process.env.FONT_DIR,
    '/usr/share/fonts/truetype/freefont', // Debian/Ubuntu
    '/usr/share/fonts/gnu-free', // Fedora
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'FreeSerif.ttf'))) return dir;
  }
  return null;
}

/** Is this path an existing executable file? (exists + any execute bit) */
function isExecutable(p: string): boolean {
  try {
     
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the PDF python interpreter. Order: REPORT_PYTHON → PYTHON_BIN →
 * `<cwd>/.venv/bin/python3` → first `python3` on PATH. Never guesses: when
 * nothing resolves, returns null so the caller can say exactly what to set.
 */
function detectReportPython(explicit: string | undefined): string | null {
  const candidates = [explicit, process.env.PYTHON_BIN].filter((v): v is string => Boolean(v));
  const venv = path.join(process.cwd(), '.venv', 'bin', 'python3');
  if (isExecutable(venv)) candidates.push(venv);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'python3');
    if (isExecutable(p)) candidates.push(p);
  }
  return candidates.find((c) => isExecutable(c)) ?? null;
}

let cached: SentinelConfig | null = null;

/** Validate + freeze the environment. Throws a readable AggregateError on bad input. */
function loadConfig(): SentinelConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Sentinel-SLA configuration is invalid — fix the environment and restart:\n${issues}`,
    );
  }
  const env = parsed.data;
  const projectRoot = process.cwd();
  const dataDir = env.SENTINEL_DATA_DIR
    ? path.resolve(env.SENTINEL_DATA_DIR)
    : path.join(projectRoot, 'data');

  const fontDir = detectFontDir(env.SENTINEL_FONT_DIR);
  const reportPython = detectReportPython(env.REPORT_PYTHON);
  const reportScript = env.REPORT_SCRIPT
    ? path.resolve(env.REPORT_SCRIPT)
    : path.join(projectRoot, 'reports', 'sla_report.py');
  const reportWeasyScript = env.REPORT_WEASY_SCRIPT
    ? path.resolve(env.REPORT_WEASY_SCRIPT)
    : path.join(projectRoot, 'reports', 'render_weasy.py');

  const config: SentinelConfig = {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    mode: env.SENTINEL_MODE,
    role: env.SENTINEL_ROLE,
    projectRoot,
    dataDir,
    reportsDir: path.join(dataDir, 'reports'),
    fontDir,
    reportPython,
    reportScript,
    reportWeasyScript,
    pollIntervalSec: env.SENTINEL_POLL_INTERVAL_SEC,
    liveFailureThreshold: env.SENTINEL_FAILURE_THRESHOLD,
    liveSuccessThreshold: env.SENTINEL_SUCCESS_THRESHOLD,
    webhookBearer: env.SENTINEL_WEBHOOK_BEARER ?? null,
    notifyTransport: env.SENTINEL_NOTIFY_TRANSPORT,
  };
  return Object.freeze(config);
}

/** Get the frozen config (validates on first call, cached afterwards). */
export function getConfig(): SentinelConfig {
  if (!cached) {
    cached = loadConfig();
    console.log(
      `[sentinel] config — mode=${cached.mode} role=${cached.role} env=${cached.nodeEnv} ` +
        `dataDir=${cached.dataDir} reportPython=${cached.reportPython ?? 'NOT CONFIGURED (set REPORT_PYTHON)'} ` +
        `fontDir=${cached.fontDir ?? 'NOT FOUND (set SENTINEL_FONT_DIR)'}`,
    );
  }
  return cached;
}

/** Test helper: drop the cached config so a new env takes effect. */
export function resetConfigForTests(): void {
  cached = null;
}
