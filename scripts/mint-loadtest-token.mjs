// Mint (or revoke) a short-lived Bearer API token for the load test.
//
// The load target requires authentication (the baseline load test is run
// with token auth enabled).
// This script creates a real ApiToken row through Prisma — the same row the
// app resolves via `Authorization: Bearer` — so the load test exercises the
// production auth path, not a bypass.
//
//   mint:   bun scripts/mint-loadtest-token.mjs [--name loadtest] [--days 1] [--scopes read]
//   revoke: bun scripts/mint-loadtest-token.mjs --revoke
//
// The raw token is printed ONCE on stdout; only its sha256 is stored.
// `--revoke` soft-revokes every token with the given name (default loadtest).

import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const args = process.argv.slice(2);
const name = args.includes('--name') ? args[args.indexOf('--name') + 1] : 'loadtest';
const days = args.includes('--days') ? Number(args[args.indexOf('--days') + 1]) : 1;
const scopes = args.includes('--scopes') ? args[args.indexOf('--scopes') + 1] : 'read';
const revoke = args.includes('--revoke');

async function main() {
  if (revoke) {
    const { count } = await db.apiToken.updateMany({
      where: { name, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    console.error(`revoked ${count} token(s) named "${name}"`);
    return;
  }

  const user = await db.user.findFirst({
    where: { role: { in: ['owner', 'admin'] }, disabled: false },
    orderBy: { createdAt: 'asc' },
  });
  if (!user) {
    console.error('ERROR: no enabled owner/admin user found — run the app setup first.');
    process.exit(2);
  }

  const raw = `stlt_${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + Math.max(1, days) * 24 * 3600 * 1000);
  const token = await db.apiToken.create({
    data: {
      userId: user.id,
      name,
      prefix: raw.slice(0, 8),
      tokenHash: sha256(raw),
      scopes,
      expiresAt,
    },
  });
  // The raw token goes to stdout ALONE so callers can pipe it safely.
  console.log(raw);
  console.error(`minted token ${token.prefix}… for ${user.email} (expires ${expiresAt.toISOString()})`);
}

main()
  .catch((err) => {
    console.error('ERROR:', err.message ?? err);
    process.exitCode = 2;
  })
  .finally(() => db.$disconnect());
