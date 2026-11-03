// Mint a temporary dev session for QA (dev SQLite only, never committed).
// Usage: node scripts/mint-dev-session.cjs <email>  → prints the raw cookie
// value; the DB stores only its sha256 (same scheme as src/server/auth).
// Delete afterwards: node scripts/mint-dev-session.cjs --revoke <email>
import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const email = process.argv[2];
const revoke = process.argv[1] === '--revoke' || process.argv[2] === '--revoke';

async function main() {
  const user = await db.user.findFirst({
    where: { email: email.toLowerCase() },
    orderBy: { createdAt: 'asc' },
  });
  if (!user) throw new Error(`no user ${email}`);
  if (revoke) {
    const del = await db.session.deleteMany({ where: { user: { id: user.id } } });
    console.log(`revoked ${del.count} session(s) for ${email}`);
    return;
  }
  const raw = randomBytes(32).toString('base64url');
  await db.session.create({
    data: {
      tokenHash: createHash('sha256').update(raw).digest('hex'),
      userId: user.id,
      absoluteExpiry: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      userAgent: 'qa-mint',
    },
  });
  console.log(raw);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
