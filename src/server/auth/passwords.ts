// Sentinel-SLA — password hashing + policy.
//
// argon2id via hash-wasm: WASM-compiled reference implementation that runs
// identically under Node (next dev / standalone server) and Bun (worker), with
// no native-glibc constraints — the runtime here is mixed (web on Node, worker
// on Bun), so a runtime-specific API (Bun.password) is not usable.
// Parameters follow OWASP's argon2id guidance: 64 MiB memory, 3 iterations,
// 4 lanes. Encoded PHC string is stored; verification re-derives and compares.

import { argon2id, argon2Verify } from 'hash-wasm';
import { randomBytes } from 'crypto';

const MIN_PASSWORD_LENGTH = 12; // policy ≥ 12 characters

// OWASP argon2id baseline (2026): m=64 MiB, t=3, p=4.
const ARGON2_PARAMS = {
  iterations: 3,
  memorySize: 65536, // KiB
  hashLength: 32,
  parallelism: 4,
} as const;

export function passwordPolicyError(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`;
  }
  if (/^(.)\1+$/.test(password)) {
    return 'Password must not be a single repeated character';
  }
  const lower = password.toLowerCase();
  const trivial = ['password', 'sentinel', '12345678', 'qwerty', 'letmein', 'welcome'];
  if (trivial.some((t) => lower.includes(t))) {
    return 'Password must not contain common dictionary words';
  }
  return null;
}

/** argon2id hash (PHC encoded) — store this, never the password. */
export async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(16),
    outputType: 'encoded',
    ...ARGON2_PARAMS,
  });
}

/** Constant-time verify against a stored argon2id PHC string. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash });
  } catch {
    // Malformed hash in the DB — treat as mismatch, never throw to the caller.
    return false;
  }
}
