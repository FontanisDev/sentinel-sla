# ═══════════════════════════════════════════════════════════════════════════
# Sentinel-SLA — business exporter container image
# Owner: Sentinel-SLA
#
# Multi-stage build: compile with the official Go toolchain, then ship a
# ~2 MB static binary on distroless (no shell, no package manager → tiny
# attack surface, matches the OWASP ASVS L1 posture of the project).
#
#   docker build -t sentinel-sla/exporter:latest exporter/
# ═══════════════════════════════════════════════════════════════════════════

FROM golang:1.22-alpine AS build

WORKDIR /src

# source layer
COPY . .

# go.mod + go.sum are committed; the build fetches the pinned modules.
# static, stripped, reproducible-ish binary
RUN go mod download && \
    CGO_ENABLED=0 GOOS=linux \
    go build -trimpath -ldflags="-s -w" -o /out/sentinel-exporter .

# ── runtime: distroless static, non-root ──────────────────────────────────
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/sentinel-exporter /sentinel-exporter

# 9108 = /metrics + /webhook/executive-alert
EXPOSE 9108

ENTRYPOINT ["/sentinel-exporter"]
