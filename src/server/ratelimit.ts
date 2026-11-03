// Sentinel-SLA — rate limiting.
//
// In-memory sliding-window limiter, applied at the route layer:
//   * /api/auth/login          — brute-force throttle beside the account lockout
//   * /api/auth/setup          — first-run wizard abuse guard
//   * POST /api/reports        — expensive (spawns the PDF pipeline)
//   * /api/export/*            — expensive (full-table serialisation)
//
// Single-process deployment note (mirrors src/server/locks.ts): the buckets
// live in this process's memory. On Postgres replicas each web process keeps
// its own bucket — the LIMIT is per-process, which still bounds abuse; the
// account lockout (DB-backed, src/server/auth/session.ts) remains the
// authoritative brute-force control. Postgres-backed buckets can slot in
// behind the same checkRateLimit() signature without touching call sites.

import { NextResponse } from 'next/server';

export interface RateLimitRule {
  /** Sliding window length in milliseconds. */
  windowMs: number;
  /** Max requests allowed inside the window. */
  max: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the oldest hit leaves the window (Retry-After value). */
  retryAfterSec: number;
  remaining: number;
  limit: number;
}

interface Bucket {
  hits: number[];
}

const globalForLimiter = globalThis as unknown as {
  __sentinelRateBuckets?: Map<string, Bucket>;
};

function buckets(): Map<string, Bucket> {
  if (!globalForLimiter.__sentinelRateBuckets) {
    globalForLimiter.__sentinelRateBuckets = new Map();
  }
  return globalForLimiter.__sentinelRateBuckets;
}

/**
 * Sliding-window check for `key`. `now` is injectable for deterministic
 * unit tests. Never throws; on any internal problem it fails OPEN (rate
 * limiting is a mitigation, not a correctness control — an limiter outage
 * must not take the API down).
 */
export function checkRateLimit(
  key: string,
  rule: RateLimitRule,
  now: number = Date.now(),
): RateLimitResult {
  try {
    const map = buckets();
    const bucket = map.get(key) ?? { hits: [] };
    const windowStart = now - rule.windowMs;

    // Drop expired hits.
    bucket.hits = bucket.hits.filter((t) => t > windowStart);

    if (bucket.hits.length >= rule.max) {
      const oldest = bucket.hits[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000));
      map.set(key, bucket);
      return { ok: false, retryAfterSec, remaining: 0, limit: rule.max };
    }

    bucket.hits.push(now);
    map.set(key, bucket);

    // Opportunistic pruning so abandoned keys cannot grow memory unbounded.
    if (map.size > 10_000) {
      for (const [k, b] of map) {
        if (b.hits.every((t) => t <= windowStart)) map.delete(k);
      }
    }

    return {
      ok: true,
      retryAfterSec: 0,
      remaining: rule.max - bucket.hits.length,
      limit: rule.max,
    };
  } catch {
    return { ok: true, retryAfterSec: 0, remaining: rule.max, limit: rule.max };
  }
}

/** Test helper: wipe every bucket. */
export function resetRateLimitsForTests(): void {
  buckets().clear();
}

/** Named rules used by routes (single place to reason about limits). */
export const RATE_RULES = {
  // Login: 10 attempts / 5 min / IP. The 5-failure account lockout remains
  // the stronger per-account control; this slows credential stuffing.
  login: { windowMs: 5 * 60 * 1000, max: 10 },
  // Setup: only reachable with zero users, but keep it tight anyway.
  setup: { windowMs: 60 * 60 * 1000, max: 20 },
  // Report generation spawns a Python process + DB scan — expensive.
  reportGenerate: { windowMs: 10 * 60 * 1000, max: 12 },
  // Exports serialise whole tables — expensive.
  export: { windowMs: 60 * 1000, max: 20 },
  // Generic API write mutations get a generous abuse ceiling.
  mutation: { windowMs: 60 * 1000, max: 120 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Client IP for bucket keys (same derivation as requestMeta in authz.ts —
 * x-forwarded-for first hop, then x-real-ip, then loopback for local dev).
 */
export function clientKey(req: Request, extra?: string): string {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'local';
  return extra ? `${ip}|${extra}` : ip;
}

/** Apply a rate limit inside a route handler; returns a 429 response when exceeded. */
export function enforceRateLimit(
  req: Request,
  scope: string,
  rule: RateLimitRule,
): NextResponse | null {
  const result = checkRateLimit(clientKey(req, scope), rule);
  if (result.ok) return null;
  return new NextResponse(
    JSON.stringify({
      error: `Too many requests. Retry in ${result.retryAfterSec}s.`,
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(result.retryAfterSec),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': '0',
        'Cache-Control': 'no-store',
      },
    },
  );
}
