#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════════
# Sentinel-SLA (سنتیل-SLA) — Chaos Engineering experiment runner
# Owner: Sentinel-SLA
#
# Validates the product's core promise: "we detect outages in under 60
# seconds" Flow:
#   1. GET  {base}/api/dashboard  → resolve the target service (key or id)
#   2. POST {base}/api/chaos      → {serviceId, type, durationSec}
#   3. Poll {base}/api/dashboard every 2 s until an incident with source
#      "chaos" appears for that service → MTTD = detectedAt − startedAt
#   4. Wait for resolution (incident resolved / experiment finished) → MTTR
#   5. Gate: MTTD < --gate seconds (default 60)
#
# Exit codes: 0 = PASS, 1 = FAIL (gate missed / timeout), 2 = error (bad
# target, connection problems, malformed API responses).
#
# Requirements: Python 3.8+, STANDARD LIBRARY ONLY (urllib, json, time,
# argparse, sys, datetime) — no pip install, runs on any on-call laptop.
#
# Run: python3 chaos_experiment.py --base http://localhost:3000 \
#            --service ps-gateway --type outage --duration 45 --gate 60 \
#            --token stlt_...   (or export SENTINEL_TOKEN=stlt_...)
#
# Authentication (v2.0.0): /api/dashboard and /api/chaos require a session.
# Machine clients pass `Authorization: Bearer <api-token>`; mint one with
#   bun scripts/mint-loadtest-token.mjs --name chaos
# (the raw token prints once; it inherits the owner/admin fleet role, which
# satisfies the engineer role floor that POST /api/chaos enforces).
# ═══════════════════════════════════════════════════════════════════════════

import argparse
import json
import os
import sys
from typing import NoReturn
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

POLL_INTERVAL_SEC = 2
HTTP_TIMEOUT_SEC = 10
RESOLUTION_GRACE_SEC = 180  # extra seconds allowed beyond the planned duration

# Set from --token / $SENTINEL_TOKEN in main(); attached to every request.
AUTH_TOKEN = ""  # empty = unauthenticated (only works on pre-2.0 apps)


# ── small HTTP helpers (stdlib only) ───────────────────────────────────────

def _auth_headers():
    """Authorization header dict when a token is configured, else {}."""
    if AUTH_TOKEN:
        return {"Authorization": "Bearer %s" % AUTH_TOKEN}
    return {}


def http_get_json(url):
    """GET a JSON document; raises SystemExit(2) with a clear message on failure."""
    req = urllib.request.Request(url, headers=_auth_headers())
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as resp:
            if resp.status != 200:
                raise OSError("HTTP %d from %s" % (resp.status, url))
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            die("GET %s returned 401 — authentication required. Mint a token "
                "(`bun scripts/mint-loadtest-token.mjs --name chaos`) and pass "
                "--token (or export SENTINEL_TOKEN)." % url)
        die("GET %s failed with HTTP %d — is the Sentinel app running?" % (url, exc.code))
    except urllib.error.URLError as exc:
        die("cannot reach %s: %s — start the app first (npm run dev)." % (url, exc.reason))
    except json.JSONDecodeError as exc:
        die("GET %s returned malformed JSON: %s" % (url, exc))


def http_post_json(url, payload):
    """POST a JSON document; returns the decoded response."""
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    headers.update(_auth_headers())
    req = urllib.request.Request(url, data=data, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8", "replace")
        except Exception:  # noqa: BLE001 — best effort only
            detail = ""
        if exc.code == 401:
            die("POST %s returned 401 — authentication required. Mint a token "
                "(`bun scripts/mint-loadtest-token.mjs --name chaos`) and pass "
                "--token (or export SENTINEL_TOKEN)." % url)
        die("POST %s failed with HTTP %d: %s" % (url, exc.code, detail))
    except urllib.error.URLError as exc:
        die("cannot reach %s: %s" % (url, exc.reason))
    except json.JSONDecodeError as exc:
        die("POST %s returned malformed JSON: %s" % (url, exc))


def die(message, code=2) -> NoReturn:
    print("ERROR: %s" % message, file=sys.stderr)
    sys.exit(code)


# ── time helpers ────────────────────────────────────────────────────────────

def parse_iso(value):
    """Parse an ISO-8601 timestamp (tolerates the 'Z' suffix on Python 3.8)."""
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def now_utc():
    return datetime.now(timezone.utc)


def elapsed_sec(start, end):
    """Seconds between two tz-aware datetimes."""
    return (end - start).total_seconds()


# ── flow ────────────────────────────────────────────────────────────────────

def resolve_service(dashboard, wanted):
    """Match --service against key, then id; default to the first service."""
    services = dashboard.get("services") or []
    if not services:
        die("the Sentinel dashboard reports no monitored services.")
    if wanted is None:
        return services[0]
    for svc in services:
        if wanted in (svc.get("key"), svc.get("id"), svc.get("name")):
            return svc
    available = ", ".join(s.get("key", "?") for s in services)
    die("service %r not found. Available keys: %s" % (wanted, available))


def find_incident(dashboard, service, experiment_id, started_after):
    """Find the chaos incident for our experiment.

    Match order: chaosExperimentId → (source=chaos, matching service,
    started at/after our experiment start). Returns the newest match.
    """
    incidents = dashboard.get("incidents") or []
    candidates = []
    for inc in incidents:
        if experiment_id and inc.get("chaosExperimentId") == experiment_id:
            candidates.append(inc)
            continue
        if inc.get("source") != "chaos":
            continue
        if inc.get("serviceId") not in (service.get("id"), service.get("key")) \
                and inc.get("serviceKey") != service.get("key") \
                and inc.get("serviceName") != service.get("name"):
            continue
        started = parse_iso(inc.get("startedAt"))
        if started_after and started and started < started_after:
            continue
        candidates.append(inc)
    if not candidates:
        return None
    # incidents are newest-first in the DTO; keep the newest
    return candidates[0] if len(candidates) == 1 else max(
        candidates, key=lambda i: parse_iso(i.get("startedAt")) or now_utc())


def find_experiment(dashboard, experiment_id):
    for exp in dashboard.get("chaosExperiments") or []:
        if exp.get("id") == experiment_id:
            return exp
    return None


def wait_for_detection(base, service, experiment_id, started_after, deadline):
    """Poll until the chaos incident is detected. Returns (incident, mttd)."""
    while now_utc() < deadline:
        dashboard = http_get_json(base + "/api/dashboard")
        incident = find_incident(dashboard, service, experiment_id, started_after)
        if incident is not None:
            detected = parse_iso(incident.get("detectedAt")) or now_utc()
            if incident.get("mttdSec") is not None:
                mttd = float(incident["mttdSec"])
            else:
                mttd = elapsed_sec(started_after, detected)
            return incident, mttd
        time.sleep(POLL_INTERVAL_SEC)
    return None, None


def wait_for_resolution(base, service, experiment_id, incident, deadline):
    """Poll until the incident is resolved or the experiment ends.

    Returns (resolved, mttr, latest_incident): resolved is True/False; mttr may
    be None when the clock data was unavailable; latest_incident is the freshest
    incident snapshot (for reporting resolvedAt etc.).
    """
    detected_at = parse_iso(incident.get("detectedAt"))
    current = incident
    while now_utc() < deadline:
        dashboard = http_get_json(base + "/api/dashboard")
        current = find_incident(dashboard, service, experiment_id, None) or current
        experiment = find_experiment(dashboard, experiment_id) if experiment_id else None

        if current.get("status") == "resolved":
            resolved_at = parse_iso(current.get("resolvedAt"))
            if current.get("mttrSec") is not None:
                return True, float(current["mttrSec"]), current
            if detected_at and resolved_at:
                return True, elapsed_sec(detected_at, resolved_at), current
            return True, None, current

        if experiment and experiment.get("status") in ("passed", "failed", "aborted"):
            ended_at = parse_iso(experiment.get("endedAt"))
            if experiment.get("mttrSec") is not None:
                return True, float(experiment["mttrSec"]), current
            if detected_at and ended_at:
                return True, elapsed_sec(detected_at, ended_at), current
            return True, None, current

        time.sleep(POLL_INTERVAL_SEC)
    return False, None, current


# ── reporting ───────────────────────────────────────────────────────────────

def render_report(rows, gate, passed, note):
    """ASCII-bordered experiment report."""
    title = "Sentinel-SLA — Chaos Experiment Report"
    label_width = max([len(title)] + [len(label) for label, _ in rows])
    value_width = max(len(value) for _, value in rows)
    gate_width = max(len(gate), 6)
    top = "+" + "-" * (label_width + 2) + "+" + "-" * (value_width + 2) + "+" + "-" * (gate_width + 2) + "+"
    lines = [top]
    lines.append("| %-*s | %-*s | %-*s |" % (label_width, title, value_width, "Value", gate_width, "Gate"))
    lines.append(top)
    for label, value in rows:
        lines.append("| %-*s | %-*s | %-*s |" % (label_width, label, value_width, value, gate_width, ""))
    lines.append(top)
    lines.append("| %-*s | %-*s | %-*s |" % (label_width, "RESULT", value_width, "PASS" if passed else "FAIL", gate_width, gate))
    lines.append(top)
    if note:
        lines.append(note)
    return "\n".join(lines)


def fmt_sec(value):
    if value is None:
        return "n/a"
    return "%.1f s" % value


# ── main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Sentinel-SLA chaos experiment: verify MTTD < gate seconds.")
    parser.add_argument("--base", default="http://localhost:3000",
                        help="base URL of the Sentinel-SLA app (default: %(default)s)")
    parser.add_argument("--service", default=None,
                        help="target service key or id (default: first service)")
    parser.add_argument("--type", dest="chaos_type",
                        choices=["outage", "latency", "error-spike"], default="outage",
                        help="chaos type to inject (default: %(default)s)")
    parser.add_argument("--duration", type=int, default=45,
                        help="planned experiment duration in seconds (default: %(default)s)")
    parser.add_argument("--gate", type=float, default=60,
                        help="MTTD gate threshold in seconds (default: %(default)s)")
    parser.add_argument("--token", default=os.environ.get("SENTINEL_TOKEN", ""),
                        help="Bearer API token for authenticated apps "
                             "(default: $SENTINEL_TOKEN; mint one with "
                             "`bun scripts/mint-loadtest-token.mjs --name chaos`)")
    args = parser.parse_args()

    global AUTH_TOKEN
    AUTH_TOKEN = (args.token or "").strip()

    base = args.base.rstrip("/")

    # 1) snapshot the fleet and resolve the target service
    dashboard = http_get_json(base + "/api/dashboard")
    service = resolve_service(dashboard, args.service)
    service_label = service.get("key") or service.get("id")
    service_id = service.get("id") or service.get("key")

    # 2) launch the experiment
    started_wall = now_utc()
    payload = {"serviceId": service_id, "type": args.chaos_type,
               "durationSec": args.duration}
    response = http_post_json(base + "/api/chaos", payload)
    experiment_id = None
    experiment_started = started_wall
    if isinstance(response, dict):
        experiment_id = response.get("id")
        experiment_started = parse_iso(response.get("startedAt")) or started_wall

    print("chaos: injecting %s on %s for %ds (experiment %s)"
          % (args.chaos_type, service_label, args.duration, experiment_id or "untracked"))

    # 3) wait for detection (cap: duration + 180 s from experiment start)
    overall_deadline = datetime.fromtimestamp(
        experiment_started.timestamp() + args.duration + RESOLUTION_GRACE_SEC,
        tz=timezone.utc)
    incident, mttd = wait_for_detection(base, service, experiment_id,
                                        experiment_started, overall_deadline)
    if incident is None:
        report = render_report(
            [("Experiment ID", experiment_id or "n/a"),
             ("Service", service_label),
             ("Type", args.chaos_type),
             ("MTTD", "TIMEOUT (> %d s)" % (args.duration + RESOLUTION_GRACE_SEC)),
             ("MTTR", "n/a")],
            "MTTD < %.0f s" % args.gate, False,
            "note: no incident was detected for the chaos injection — the "
            "detection pipeline failed this gate.")
        print(report)
        sys.exit(1)

    # 4) wait for resolution (incident resolved or experiment finished)
    resolved, mttr, incident = wait_for_resolution(base, service, experiment_id,
                                                   incident, overall_deadline)

    # 5) evaluate the gate and report
    passed = mttd is not None and mttd < args.gate
    rows = [
        ("Experiment ID", experiment_id or "n/a"),
        ("Service", service_label),
        ("Type", args.chaos_type),
        ("Incident", incident.get("id") or "n/a"),
        ("MTTD", fmt_sec(mttd)),
        ("MTTR", fmt_sec(mttr) if resolved else "UNRESOLVED (timeout)"),
        ("Detected", incident.get("detectedAt") or "n/a"),
        ("Resolved", incident.get("resolvedAt") or "n/a"),
    ]
    note = None
    if not resolved:
        note = ("note: the incident did not resolve within the wait window "
                "(duration + %d s) — investigate MTTR separately." % RESOLUTION_GRACE_SEC)
    print(render_report(rows, "MTTD < %.0f s" % args.gate, passed, note))
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\ninterrupted — experiment aborted by operator.", file=sys.stderr)
        sys.exit(2)
