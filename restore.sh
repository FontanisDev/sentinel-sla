#!/usr/bin/env bash
# Sentinel-SLA v2.0.0 — root entrypoint. See deploy/restore.sh.
# Verifies every SHA256SUMS entry BEFORE touching the target, refuses
# non-clean targets without --force, restores db + data + .env (mode 600).
set -euo pipefail
exec bash "$(cd "$(dirname "$0")" && pwd)/deploy/restore.sh" "$@"
