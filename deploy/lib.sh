#!/usr/bin/env bash
# Sentinel-SLA v2.0.0 — shared shell helpers for install/backup/restore/upgrade.
# Sourced by the deploy scripts; never executed directly.
# Paths are PORTABLE: everything derives from the script location, no machine
# absolute paths are hardcoded anywhere.
#
# shellcheck shell=bash

# ── layout ───────────────────────────────────────────────────────────────────
sentinel_run_dir() {
  # PID files + runtime state. Writable, gitignored (under data/ by default).
  printf '%s' "${SENTINEL_RUN_DIR:-$1/data/run}"
}

# ── .env handling ────────────────────────────────────────────────────────────
# Load KEY=VALUE lines from .env into the environment. Existing env wins for
# operator overrides (PORT=3100 ./deploy/...), EXCEPT DATABASE_URL: that one is
# ALWAYS taken from the file — an ambient shell export pointing at another
# install's database must never win (misdirected prisma db push = disaster).
sentinel_load_env() {
  local envfile="$1"
  [[ -f "$envfile" ]] || return 0
  while IFS='=' read -r key value; do
    case "$key" in ''|\#*) continue ;; esac
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    if [[ -n "$key" ]] && { [[ "$key" == "DATABASE_URL" ]] || [[ -z "${!key+x}" ]]; }; then
      export "$key=$value"
    fi
  done < <(grep -v '^\s*$' "$envfile" | grep -v '^\s*#')
}

sentinel_db_kind() {
  # sqlite | postgres | unknown — from DATABASE_URL only.
  case "${DATABASE_URL:-}" in
    file:*) printf '%s' 'sqlite' ;;
    postgresql://*|postgres://*) printf '%s' 'postgres' ;;
    *) printf '%s' 'unknown' ;;
  esac
}

sentinel_db_file() {
  # Absolute path of the SQLite database file (resolves the prisma-relative
  # file:../db/custom.db convention). Empty when DATABASE_URL is not sqlite.
  case "${DATABASE_URL:-}" in
    file:*)
      local p="${DATABASE_URL#file:}"
      if [[ "$p" = /* ]]; then printf '%s' "$p"; else printf '%s' "$1/prisma/$p"; fi
      ;;
  esac
}

# ── secrets ──────────────────────────────────────────────────────────────────
sentinel_gen_hex() { openssl rand -hex "$1"; }

# ── stack control (native install) ──────────────────────────────────────────
sentinel_stop_stack() {
  local root="$1" rundir pidfile pid stopped=0
  rundir="$(sentinel_run_dir "$root")"
  for pidfile in "$rundir/web.pid" "$rundir/worker.pid"; do
    if [[ -f "$pidfile" ]]; then
      pid="$(cat "$pidfile" 2>/dev/null || true)"
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || { stopped=1; break; }; sleep 0.5; done
        kill -9 "$pid" 2>/dev/null || true
      fi
      rm -f "$pidfile"
    fi
  done
  # Fallback: kill anything still LISTENING on the app port (pattern-independent,
  # a stale-listener lesson).
  if [[ -n "${PORT:-}" ]] && command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" 2>/dev/null || true
  fi
  return 0
}

sentinel_start_web() {
  local root="$1" rundir log server_dir
  rundir="$(sentinel_run_dir "$root")"
  mkdir -p "$rundir"
  log="$rundir/web.log"
  server_dir="$(sentinel_server_dir "$root")" || return 1
  # Run the standalone entry directly (CWD = the standalone dir, so its
  # internal .next resolution is always correct, flat or nested).
  ( cd "$server_dir" && PORT="${PORT:-3000}" HOSTNAME=0.0.0.0 NODE_ENV=production \
      nohup bun server.js >>"$log" 2>&1 & echo $! >"$rundir/web.pid" )
}

sentinel_start_worker() {
  # Live mode only: background loops run in the dedicated worker process.
  local root="$1" rundir log
  rundir="$(sentinel_run_dir "$root")"
  mkdir -p "$rundir"
  log="$rundir/worker.log"
  ( cd "$root" && SENTINEL_ROLE=worker nohup bun src/worker/index.ts >>"$log" 2>&1 & echo $! >"$rundir/worker.pid" )
}

# ── standalone resolution ────────────────────────────────────────────────────
sentinel_server_dir() {
  # Echo the directory containing the standalone server.js. Next.js nests the
  # output below `.next/standalone/<relative-path>/` whenever it infers a
  # parent workspace root (monorepo layouts, CI containers, or an extract dir
  # sitting under a tree that owns a lockfile); a plain VM install gets the
  # flat layout. Prefer the flat layout, else the SHALLOWEST nested hit.
  local root="$1" cand
  if [[ -f "$root/.next/standalone/server.js" ]]; then
    printf '%s' "$root/.next/standalone"
    return 0
  fi
  cand="$(find "$root/.next/standalone" -mindepth 2 -type f -name server.js -printf '%d %p\n' 2>/dev/null | sort -n | head -1 | cut -d' ' -f2-)"
  if [[ -n "$cand" ]]; then printf '%s' "$(dirname "$cand")"; return 0; fi
  return 1
}

sentinel_sync_static() {
  # Ensure .next/static, public/ and reports/ exist inside the resolved server
  # dir (the package build script copies them for the flat layout; nested
  # layouts need the same treatment after build).
  local root="$1" server_dir
  server_dir="$(sentinel_server_dir "$root")" || return 1
  [[ -d "$server_dir/.next/static" ]] || cp -r "$root/.next/static" "$server_dir/.next/static"
  [[ -d "$server_dir/public" ]] || cp -r "$root/public" "$server_dir/public"
  [[ -d "$server_dir/reports" ]] || cp -r "$root/reports" "$server_dir/reports"
}

# ── health wait ──────────────────────────────────────────────────────────────
sentinel_wait_health() {
  # $1 port, $2 timeout seconds — polls /api/health/ready until 200.
  local port="$1" timeout="${2:-120}" i
  for ((i = 0; i < timeout * 2; i++)); do
    if curl -fsS --max-time 3 "http://localhost:${port}/api/health/ready" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

sentinel_wait_health_json() {
  curl -fsS --max-time 3 "http://localhost:${1}/api/health/ready" 2>/dev/null
}

# ── Prisma one-liners (bun eval; the repo tree ships the client) ─────────────
sentinel_prisma_eval() {
  # $1 root — runs the given bun script with an ABSOLUTE sqlite DATABASE_URL so
  # relative file: URLs in .env cannot mis-resolve depending on cwd.
  local root="$1" script="$2"
  local url="$DATABASE_URL"
  if [[ "$(sentinel_db_kind)" == 'sqlite' ]]; then
    url="file:$(sentinel_db_file "$root")"
  fi
  ( cd "$root" && DATABASE_URL="$url" bun -e "$script" )
}
