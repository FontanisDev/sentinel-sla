#!/usr/bin/env python3
# Load test (target: 1000 events/sec) — run against a production-like server, not a dev instance.
#
# ═══════════════════════════════════════════════════════════════════════════
# Sentinel-SLA (سنتیل-SLA) — load generator for the dashboard aggregate API
#
# Target: GET /api/dashboard (the heaviest public read path — it aggregates
# engine state, KPIs, services, incidents, alerts, chaos and reports).
# Acceptance target: the system must sustain 1000 events/sec.
#
# Design: standard-library ONLY (threads + urllib — mirrors the chaos suite's
# zero-dependency policy). Open-loop pacing: each thread schedules requests at
# rate/threads per second and records per-request latency, so the achieved
# rate honestly reflects what the server can absorb.
#
# PASS criteria (CI): achieved RPS >= 90% of target AND error rate < 1%.
# Exit codes: 0 = PASS, 1 = FAIL, 2 = usage/setup error.
#
# Run: python3 tests/load/load_test.py --url http://localhost:3000/api/dashboard \
#          --rate 1000 --duration 60 --threads 50
# ═══════════════════════════════════════════════════════════════════════════

import argparse
import sys
import threading
import time
import urllib.error
import urllib.request

TARGET_DEFAULT = "http://localhost:3000/api/dashboard"


def percentile(sorted_latencies, pct):
    """p-th percentile (nearest-rank) of an ascending list, in seconds."""
    if not sorted_latencies:
        return float("nan")
    k = max(1, int(round(pct / 100.0 * len(sorted_latencies))))
    return sorted_latencies[min(k, len(sorted_latencies)) - 1]


class Worker(threading.Thread):
    """One open-loop load thread: fires rate/threads GETs per second."""

    def __init__(self, url, per_thread_rate, deadline_monotonic, token=None):
        super(Worker, self).__init__(daemon=False)
        self.url = url
        self.interval = 1.0 / per_thread_rate if per_thread_rate > 0 else 0
        self.deadline = deadline_monotonic
        self.token = token
        self.latencies = []
        self.errors = 0
        self.sent = 0

    def run(self):
        next_send = time.monotonic()
        while True:
            now = time.monotonic()
            if now >= self.deadline:
                return
            if now < next_send:
                time.sleep(next_send - now)
            if time.monotonic() >= self.deadline:
                return
            self.sent += 1
            started = time.monotonic()
            try:
                req = urllib.request.Request(self.url)
                if self.token:
                    req.add_header("Authorization", "Bearer %s" % self.token)
                with urllib.request.urlopen(req, timeout=15) as resp:
                    body = resp.read()
                    elapsed = time.monotonic() - started
                    if resp.status == 200 and body:
                        self.latencies.append(elapsed)
                    else:
                        self.errors += 1
            except urllib.error.HTTPError:
                self.errors += 1
            except (urllib.error.URLError, OSError):
                self.errors += 1
            next_send += self.interval


def main():
    parser = argparse.ArgumentParser(
        description="Sentinel-SLA load test: sustain --rate events/sec against one URL.")
    parser.add_argument("--url", default=TARGET_DEFAULT,
                        help="target URL (default: %(default)s)")
    parser.add_argument("--rate", type=float, default=1000,
                        help="target events per second, target is 1000 (default: %(default)s)")
    parser.add_argument("--duration", type=int, default=60,
                        help="test duration in seconds (default: %(default)s)")
    parser.add_argument("--threads", type=int, default=50,
                        help="worker thread count (default: %(default)s)")
    parser.add_argument("--token", default=None,
                        help="bearer API token — the load test runs WITH authentication "
                             "(mint one: bun scripts/mint-loadtest-token.mjs)")
    args = parser.parse_args()

    if args.rate <= 0 or args.duration <= 0 or args.threads <= 0:
        print("ERROR: --rate, --duration and --threads must be positive.", file=sys.stderr)
        return 2

    # quick reachability probe — fail fast with a clear message
    try:
        probe_req = urllib.request.Request(args.url)
        if args.token:
            probe_req.add_header("Authorization", "Bearer %s" % args.token)
        with urllib.request.urlopen(probe_req, timeout=10) as probe:
            if probe.status != 200:
                raise OSError("probe returned HTTP %d" % probe.status)
            if not probe.read():
                raise OSError("probe returned an empty body (401 body?)")
    except Exception as exc:  # noqa: BLE001 — report any probe failure identically
        print("ERROR: target %s is not reachable (%s). Start the server first — "
              "this test must not run against a dev instance." % (args.url, exc), file=sys.stderr)
        if args.token is None:
            print("note: the load test expects auth — pass --token <bearer token>.",
                  file=sys.stderr)
        return 2

    print("load test: url=%s target=%.0f events/s duration=%ds threads=%d auth=%s"
          % (args.url, args.rate, args.duration, args.threads, "bearer-token" if args.token else "none"))
    print("warming up for 2s ...")
    time.sleep(2)

    deadline = time.monotonic() + args.duration
    per_thread = args.rate / float(args.threads)
    workers = [Worker(args.url, per_thread, deadline, token=args.token) for _ in range(args.threads)]

    started_wall = time.monotonic()
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()
    elapsed = time.monotonic() - started_wall

    latencies = sorted(lat for worker in workers for lat in worker.latencies)
    total_ok = len(latencies)
    total_errors = sum(worker.errors for worker in workers)
    total_requests = total_ok + total_errors
    achieved = total_requests / elapsed if elapsed > 0 else 0.0
    error_rate = (total_errors / total_requests) if total_requests else 1.0

    p50 = percentile(latencies, 50)
    p95 = percentile(latencies, 95)
    p99 = percentile(latencies, 99)

    passed = (achieved >= 0.9 * args.rate) and (error_rate < 0.01) and total_ok > 0

    rows = [
        ("Target rate", "%.0f events/s" % args.rate),
        ("Achieved rate", "%.1f events/s" % achieved),
        ("Duration", "%.1f s" % elapsed),
        ("Requests OK", "%d" % total_ok),
        ("Requests failed", "%d" % total_errors),
        ("Error rate", "%.2f%%" % (error_rate * 100)),
        ("Latency p50", "%.1f ms" % (p50 * 1000)),
        ("Latency p95", "%.1f ms" % (p95 * 1000)),
        ("Latency p99", "%.1f ms" % (p99 * 1000)),
        ("Threads", "%d" % args.threads),
    ]
    label_w = max(len(r[0]) for r in rows)
    value_w = max(len(r[1]) for r in rows)
    gate_w = max(len("gate"), len(">= 90% target, err < 1%"))
    line = "+" + "-" * (label_w + 2) + "+" + "-" * (value_w + 2) + "+" + "-" * (gate_w + 2) + "+"
    print(line)
    print(("| %-*s | %-*s | %-*s |" % (label_w, "Sentinel-SLA load test", value_w,
                                        "Value", gate_w, "Gate")))
    print(line)
    for label, value in rows:
        print("| %-*s | %-*s | %-*s |" % (label_w, label, value_w, value, gate_w, ""))
    print(line)
    print("| %-*s | %-*s | %-*s |" % (label_w, "RESULT", value_w,
                                       "PASS" if passed else "FAIL", gate_w,
                                       ">= 90% target, err < 1%"))
    print(line)

    if not passed and total_ok == 0:
        print("ERROR: not a single successful request — server is down or URL is wrong.",
              file=sys.stderr)
        return 2
    return 0 if passed else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\ninterrupted — load test aborted by operator.", file=sys.stderr)
        sys.exit(2)
