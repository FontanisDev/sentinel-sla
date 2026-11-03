#!/usr/bin/env bash
# Sentinel-SLA v2.0.0 — root entrypoint. See deploy/upgrade.sh.
# upgrade.sh: backup (rollback anchor) → deps/schema → rebuild → restart →
# health; any failure rolls back to the pre-upgrade backup automatically.
set -euo pipefail
exec bash "$(cd "$(dirname "$0")" && pwd)/deploy/upgrade.sh" "$@"
