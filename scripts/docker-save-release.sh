#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# Sentinel-SLA image tarball builder (docker save).
#
#   bash scripts/docker-save-release.sh
#
# Requires a Docker daemon. Produces release/sentinel-sla-<V>-images.tar.gz:
# a docker save bundle of the application image PLUS every monitoring-stack
# image, so an air-gapped host can load everything with one `docker load`.
#
# On a machine with Docker + network:
#   bash scripts/docker-save-release.sh          # ~10 min first run
#   sha256sum release/sentinel-sla-*-images.tar.gz >> release/SHA256SUMS
#   ship release/ (tarball + images tarball + SBOM + SHA256SUMS + manifest)
#
# On the air-gapped host:
#   gunzip -c sentinel-sla-2.0.0-images.tar.gz | docker load
#   docker images | grep sentinel-sla            # verify, then install.sh
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
V="$(node -p 'JSON.parse(require("fs").readFileSync("package.json","utf8")).version')"

if ! command -v docker >/dev/null 2>&1; then
  echo "FAIL: docker is not available on this machine." >&2
  echo "      This artefact must be built on a host with a Docker daemon." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "FAIL: docker daemon is not reachable (is the service running?)." >&2
  exit 1
fi

echo "── building the application image ──────────────────────────────────────────"
docker build -f Dockerfile -t "sentinel-sla/app:${V}" .

echo "── pulling the monitoring-stack images (compose pins) ──────────────────────"
IMAGES=("sentinel-sla/app:${V}")
while read -r ref; do
  [ -n "$ref" ] || continue
  echo "  pull $ref"
  docker pull "$ref"
  IMAGES+=("$ref")
done < <(sed -n 's/^[[:space:]]*image:[[:space:]]*//p' deploy/docker-compose.yml)

echo "── docker save (${#IMAGES[@]} images) ─────────────────────────────────────────────"
mkdir -p release
OUT="release/sentinel-sla-${V}-images.tar.gz"
docker save "${IMAGES[@]}" | gzip > "$OUT"
echo "── checksum ────────────────────────────────────────────────────────────────"
( cd release && sha256sum "sentinel-sla-${V}-images.tar.gz" | tee -a SHA256SUMS )
echo "images tarball ready: ${OUT}"
echo "load on the target:   gunzip -c $(basename "$OUT") | docker load"
