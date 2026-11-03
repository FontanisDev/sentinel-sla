#!/usr/bin/env bash
# Regenerate prisma/schema.postgres.prisma from prisma/schema.prisma.
# Keeps the two schemas from drifting: the Postgres variant is derived, never
# hand-edited. SQLite stays the zero-dependency dev/demo default; Postgres is
# the production path (docker-compose.yml). See docs/ARCHITECTURE.md.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "push" ]]; then
  # Apply the Postgres schema to $DATABASE_URL (used with docker-compose.dev.yml).
  : "${DATABASE_URL:?export DATABASE_URL=postgresql://... first}"
  exec bun x prisma db push --schema prisma/schema.postgres.prisma
fi

if [[ "${1:-}" == "generate" ]]; then
  # Generate the Postgres-flavoured client (for testing the postgres path
  # without touching the SQLite client in node_modules).
  exec bun x prisma generate --schema prisma/schema.postgres.prisma
fi

# Default: (re)derive the postgres schema from the canonical sqlite schema.
awk '
  /provider[ \t]*=[ \t]*"sqlite"/ { sub(/"sqlite"/, "\"postgresql\"") }
  { print }
' prisma/schema.prisma > prisma/schema.postgres.prisma

echo "wrote prisma/schema.postgres.prisma (provider=postgresql, derived from schema.prisma)"
echo "apply with:  DATABASE_URL=postgresql://... bun scripts/prisma-postgres.sh push"
