# Release Engineering — Sentinel-SLA v2.0.0

How the v2.0.0 release artefacts are produced, verified and shipped: an
install tarball with compose files, scripts, docs, a CycloneDX SBOM and
checksums, plus a `docker save` image bundle for offline installs.

---

## 1. Artefact inventory

| Artefact | Path | What it is | Where it is built |
|---|---|---|---|
| Install tarball | `release/sentinel-sla-2.0.0.tar.gz` | The git-tracked tree at the release commit + the SBOM. Literally installable: `tar xzf … && cd sentinel-sla-2.0.0/deploy && ./install.sh` | Build machine (this repo, `bash scripts/build-release.sh`) |
| SBOM | `release/sentinel-sla-2.0.0.cdx.json` | CycloneDX 1.5 bill of materials — 195 components: the 188-package npm production closure (including the platform-specific `@img/*` libvips binaries), the 6 pinned monitoring-stack images and the Go exporter module | Build machine, included in the tarball too |
| Checksums | `release/SHA256SUMS` | SHA-256 of the tarball + SBOM (the image bundle appends its own line, see §4) | Build machine |
| Build manifest | `release/RELEASE-MANIFEST.json` | Provenance: version, source commit, build time, artefact sizes + SHA-256s, install instructions | Build machine |
| Image bundle | `release/sentinel-sla-2.0.0-images.tar.gz` | `docker save` of the application image **plus every monitoring-stack image**, for air-gapped install | Any host with Docker and registry access (see §4) |

What is deliberately **not** in the tarball: `.env` (secrets are generated at
install time), databases (`db/`, `data/`), build outputs (`.next/`,
`node_modules/`), logs, and earlier release artefacts. The tarball staging is
enforced by sanity checks inside `scripts/build-release.sh` (required paths
present, forbidden paths absent — the build fails loudly otherwise).

## 2. Building the artefacts

Prerequisites: a clean git worktree (uncommitted changes abort the build),
Node ≥ 20, `bun install` already run (the SBOM walks the installed
`node_modules`).

```bash
bun run sbom        # or: node scripts/gen-sbom.mjs       → SBOM only
bun run release     # or: bash scripts/build-release.sh  → SBOM + tarball + checksums + manifest
```

`build-release.sh` refuses to run for any version other than 2.0.0, refuses a
dirty worktree, runs the tarball sanity checks, and finishes by verifying its
own checksums (`sha256sum -c`). The manifest records the exact source commit
— rebuild from that commit to reproduce (byte-identity is not guaranteed
because gzip stores mtimes; checksums attest the published build).

## 3. Verifying a downloaded release

```bash
cd release
sha256sum -c SHA256SUMS          # both artefacts must answer OK
node -e 'const b=require("./sentinel-sla-2.0.0.cdx.json");
  console.log(b.bomFormat, b.specVersion, b.components.length, "components")'
# then the smoke install (demo mode, port 3000):
tar xzf sentinel-sla-2.0.0.tar.gz && cd sentinel-sla-2.0.0/deploy
SENTINEL_NONINTERACTIVE=1 SENTINEL_MODE=demo ./install.sh
curl -fsS http://localhost:3000/api/health/ready
```

## 4. Air-gapped image bundle

The image bundle requires a Docker daemon, so it is built separately from the
tarball on any host with Docker and registry access. One command does the
whole chain — build the app image, pull the pinned monitoring images,
`docker save | gzip`, append the checksum:

```bash
bash scripts/docker-save-release.sh          # → release/sentinel-sla-2.0.0-images.tar.gz
```

Ship it next to the tarball. On the air-gapped target:

```bash
gunzip -c sentinel-sla-2.0.0-images.tar.gz | docker load
docker images | grep -E 'sentinel-sla|prom/|grafana/'    # verify the set
```

The bundle carries exactly the images `deploy/docker-compose.yml` pins
(prometheus v2.53.1, grafana 11.1.0, loki 3.1.0, promtail 3.1.0,
alertmanager v0.27.0, blackbox-exporter v0.25.0) plus
`sentinel-sla/app:2.0.0` built from the same source commit as the tarball —
so a fully offline install never touches a registry.

## 5. Tag

The release commit is tagged `v2.0.0` (annotated).
`release/RELEASE-MANIFEST.json` records which commit the artefacts were
built from.

## 6. Known limitations

- The image bundle is the only artefact not produced by `build-release.sh`,
  because it needs a Docker daemon; use the procedure in §4.
- Licence: PolyForm Noncommercial 1.0.0 (see `LICENSE`); the SBOM carries the same
  declaration.
- Monitoring-stack images ship **unmodified**;
  their licences and upstream sources are documented in
  `docs/THIRD_PARTY_NOTICES.md` (AGPL note included).
