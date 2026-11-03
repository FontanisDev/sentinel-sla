# Sentinel-SLA — production image.
# Multi-stage, non-root, standalone Next.js output. Read-only-rootfs compatible:
# everything mutable goes to /data (SENTINEL_DATA_DIR) or /tmp.
#
# Build:  docker build -t sentinel-sla/app:2.0.0 .
# Run:    see docker-compose.yml (web + worker share this image, different commands)

# ── deps: install with a prisma client generated for linux-musl ────────────
FROM oven/bun:1.3.14-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

# ── build: compile the standalone bundle ────────────────────────────────────
FROM oven/bun:1.3.14-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The build needs the Prisma client (postinstall of bun install already ran
# generate for the schema's provider) and a DATABASE_URL that satisfies config
# validation — the value is never connected to at build time.
ENV DATABASE_URL=file:../db/custom.db
RUN bun x prisma generate && bun run build

# ── runtime ─────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    SENTINEL_DATA_DIR=/data \
    REPORT_PYTHON=/opt/venv/bin/python3 \
    XDG_CACHE_HOME=/tmp/.cache

# python3 + WeasyPrint (Pango) for the PDF report pipeline, in an isolated venv.
COPY reports/requirements.txt /tmp/report-requirements.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv libpango-1.0-0 libpangoft2-1.0-0 \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r /tmp/report-requirements.txt \
    && rm -rf /var/lib/apt/lists/* /tmp/report-requirements.txt

# Non-root user; /data and /tmp are the only writable mounts needed.
RUN groupadd -r sentinel --gid=1001 && useradd -r -g sentinel --uid=1001 sentinel \
    && mkdir -p /data && chown -R sentinel:sentinel /data

# Standalone output + source (worker entrypoint runs TS via bun) + the report
# script it shells out to + prisma schema for migrate jobs.
# Full node_modules (with the Prisma client generated for SQLite and the
# pinned prisma CLI): the worker runs TypeScript from src/ and the migrate job
# needs the CLI, neither of which the traced standalone output contains.
COPY --from=build --chown=sentinel:sentinel /app/node_modules ./node_modules
COPY --from=build --chown=sentinel:sentinel /app/.next/standalone ./
COPY --from=build --chown=sentinel:sentinel /app/src ./src
COPY --from=build --chown=sentinel:sentinel /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=sentinel:sentinel /app/reports ./reports
COPY --from=build --chown=sentinel:sentinel /app/prisma ./prisma

USER sentinel
EXPOSE 3000
VOLUME ["/data"]

# Healthcheck hits the readiness endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# Default = web server. The worker container overrides:
#   command: ["bun", "src/worker/index.ts"]
CMD ["bun", "server.js"]
