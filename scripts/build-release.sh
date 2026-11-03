#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# Sentinel-SLA release builder.
#
#   bash scripts/build-release.sh
#
# Produces in release/:
#   sentinel-sla-<V>.tar.gz      installable source tree (git-tracked files at
#                                the current commit) + the SBOM — the literal
#                                artefact for `tar xzf … && cd …/deploy &&
#                                ./install.sh`
#   sentinel-sla-<V>.cdx.json    CycloneDX 1.5 SBOM (built by gen-sbom.mjs)
#   SHA256SUMS                   checksums of the tarball + SBOM
#   RELEASE-MANIFEST.json        build provenance + artefact inventory
#
# The tarball deliberately contains NO secrets (.env), NO databases, NO build
# outputs (.next, node_modules) and no release artefacts from earlier runs —
# only the tracked tree plus the freshly generated SBOM.
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
V="$(bun -p 'JSON.parse(require("fs").readFileSync("package.json","utf8")).version')"
case "$V" in 2.0.0) ;; *) echo "FAIL: refusing to build a release for version '$V' (expected 2.0.0)" >&2; exit 1 ;; esac

command -v git >/dev/null 2>&1 || { echo "FAIL: git required to build the release tree" >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "FAIL: not a git worktree" >&2; exit 1; }
if [ -n "$(git status --porcelain -- . ':!release')" ]; then
  echo "FAIL: worktree has uncommitted changes (release artefacts must build from a clean tree)" >&2
  git status --porcelain -- . ':!release' >&2
  exit 1
fi

echo "── 1/5 CycloneDX SBOM ──────────────────────────────────────────────────────"
bun scripts/gen-sbom.mjs
SBOM="release/sentinel-sla-${V}.cdx.json"
test -f "$SBOM"

echo "── 2/5 stage the tracked tree ──────────────────────────────────────────────"
STAGE="release/.stage"
rm -rf "$STAGE" && mkdir -p "$STAGE"
git archive "HEAD" --prefix="sentinel-sla-${V}/" | tar -x -C "$STAGE"
# never ship stale release artefacts from a previous build inside the tarball
rm -rf "${STAGE}/sentinel-sla-${V}/release"
# ship the freshly generated SBOM inside the artefact (standard practice: the
# SBOM travels with the thing it describes)
mkdir -p "${STAGE}/sentinel-sla-${V}/release"
cp "$SBOM" "${STAGE}/sentinel-sla-${V}/release/"

echo "── 3/5 tarball sanity checks ───────────────────────────────────────────────"
for must in "package.json" "deploy/docker-compose.yml" "deploy/install.sh" "install.sh" \
            "docs/INSTALL.md" "docs/RELEASE.md" "docs/OPERATIONS.md" "openapi/openapi.yaml" \
            "README.md" "CHANGELOG.md" "prisma/schema.prisma" "public/fonts" "release/sentinel-sla-${V}.cdx.json"; do
  test -e "${STAGE}/sentinel-sla-${V}/${must}" || { echo "FAIL: tarball staging missing ${must}" >&2; exit 1; }
done
for forbidden in ".env" "db/custom.db" ".next" "node_modules" "*.log"; do
  if [ "$forbidden" = "*.log" ]; then
    if find "${STAGE}" -name '*.log' | grep -q .; then echo "FAIL: tarball staging contains log files" >&2; exit 1; fi
  elif find "${STAGE}" -path "*${forbidden}" | grep -q .; then
    echo "FAIL: tarball staging contains forbidden path ${forbidden}" >&2; exit 1
  fi
done
TRACKED="$(git ls-files | wc -l | tr -d ' ')"

echo "── 4/5 build the tarball ───────────────────────────────────────────────────"
TARBALL="release/sentinel-sla-${V}.tar.gz"
tar -czf "$TARBALL" -C "$STAGE" "sentinel-sla-${V}"
rm -rf "$STAGE"

echo "── 5/5 checksums + manifest ────────────────────────────────────────────────"
COMMIT="$(git rev-parse HEAD)"
COMMIT_SHORT="$(git rev-parse --short HEAD)"
TAGGED="$(git tag --list "v${V}" | head -1 || true)"
# sha256sum entries are relative to release/ so `sha256sum -c` works in place
( cd release && sha256sum "sentinel-sla-${V}.tar.gz" "sentinel-sla-${V}.cdx.json" > SHA256SUMS )

bun - "$V" "$COMMIT" "$COMMIT_SHORT" "$TAGGED" "$TRACKED" <<'NODE'
const { readFileSync, statSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const [V, COMMIT, COMMIT_SHORT, TAGGED, TRACKED] = process.argv.slice(2);
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const arte = (f) => ({ file: `release/${f}`, bytes: statSync(`release/${f}`).size, sha256: sha(`release/${f}`) });
const sbom = JSON.parse(readFileSync(`release/sentinel-sla-${V}.cdx.json`, 'utf8'));
const manifest = {
  product: 'sentinel-sla',
  version: V,
  sourceCommit: COMMIT,
  sourceCommitShort: COMMIT_SHORT,
  builtAt: new Date().toISOString(),
  tag: TAGGED || null,
  note: 'Built by scripts/build-release.sh from the git-tracked tree at sourceCommit plus the freshly generated SBOM. Rebuild from the same commit to reproduce; byte-identity is not guaranteed (gzip stores mtimes).',
  artefacts: [arte(`sentinel-sla-${V}.tar.gz`), arte(`sentinel-sla-${V}.cdx.json`)],
  checksums: `release/SHA256SUMS (verify: cd release && sha256sum -c SHA256SUMS)`,
  install: [`tar xzf release/sentinel-sla-${V}.tar.gz`, `cd sentinel-sla-${V}/deploy`, `./install.sh`],
  sbom: { format: sbom.bomFormat, specVersion: sbom.specVersion, components: sbom.components.length },
  trackedFilesInTarball: Number(TRACKED),
};
writeFileSync('release/RELEASE-MANIFEST.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest: ${manifest.artefacts.map(a => `${a.file} (${a.bytes} bytes)`).join(', ')}`);
NODE

echo ""
echo "════════════════════════════════════════════════════════════════════════════"
echo " release ready: ${TARBALL}"
( cd release && sha256sum -c SHA256SUMS --quiet && echo " checksums verified OK" )
echo " next: scripts/docker-save-release.sh (needs a Docker daemon — see docs/RELEASE.md)"
echo "════════════════════════════════════════════════════════════════════════════"
