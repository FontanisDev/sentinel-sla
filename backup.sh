#!/usr/bin/env bash
# Sentinel-SLA v2.0.0 — root entrypoint. See deploy/backup.sh.
# Consistent backup: SQLite via the python3 stdlib backup API (or pg_dump
# through the compose Postgres container) + data dir + .env + manifest +
# SHA256SUMS, written to a timestamped tarball under backups/.
set -euo pipefail
exec bash "$(cd "$(dirname "$0")" && pwd)/deploy/backup.sh" "$@"
