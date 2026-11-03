#!/usr/bin/env bash
# Sentinel-SLA v2.0.0 — root entrypoint.
# The real installer lives in deploy/install.sh (with deploy/lib.sh); this
# wrapper exists so the owner-style procedure works from the tarball root:
#   tar xzf sentinel-sla-2.0.0.tar.gz && cd sentinel-sla-2.0.0 && ./install.sh
set -euo pipefail
exec bash "$(cd "$(dirname "$0")" && pwd)/deploy/install.sh" "$@"
