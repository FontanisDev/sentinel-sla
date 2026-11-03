#!/usr/bin/env python3
"""Sentinel-SLA — OpenAPI document ↔ route-file parity check.

Proves openapi/openapi.yaml covers EXACTLY the live HTTP surface:

  1. every route file src/app/api/**/route.ts maps to a spec path, and the
     methods exported by that file (get/post/put/patch/delete handlers) are
     all declared in the document for that path;
  2. conversely, every spec path exists as a route file (no ghost endpoints);
  3. the document pins the release version (info.version == package.json);
  4. public endpoints (health, auth, callbacks) declare security: [].

This is the structural half of the contract guarantee — the live half is
tests/integration/api-contract.mjs, which validates response BODIES against
the schemas. Run from tests/integration/test_stack.sh; exits 1 on drift.
"""

import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "openapi" / "openapi.yaml"
API_DIR = ROOT / "src" / "app" / "api"

failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


spec = yaml.safe_load(SPEC.read_text(encoding="utf-8"))

# ── spec side ────────────────────────────────────────────────────────────────
spec_paths = set(spec.get("paths", {}))
HTTP = ("get", "post", "put", "patch", "delete")
spec_ops = {}  # path -> set(method)
for p, item in spec.get("paths", {}).items():
    spec_ops[p] = {m for m in item.keys() if m in HTTP}
    if not spec_ops[p]:
        fail(f"spec path {p} declares no HTTP operations")

version = spec.get("info", {}).get("version")
pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
if version != pkg.get("version"):
    fail(f"spec info.version {version} != package.json {pkg.get('version')}")
if spec.get("openapi") != "3.0.3":
    fail(f"spec declares openapi {spec.get('openapi')} (expected 3.0.3)")

# ── route side ───────────────────────────────────────────────────────────────
HANDLER = re.compile(r"export\s+(?:async\s+)?function\s+([A-Z]+)")
route_ops = {}  # path -> set(method)
for route in sorted(API_DIR.rglob("route.ts")):
    rel = route.relative_to(API_DIR).with_suffix("")
    parts = list(rel.parts)
    if parts and parts[-1] == "route":
        parts = parts[:-1]
    path = "/" + "/".join(parts) if parts else "/"
    path = "/api" + (path if path != "/" else "")  # route files live under src/app/api
    # Next.js [x] segment == OpenAPI {x}
    path = re.sub(r"\[([^\]]+)\]", r"{\1}", path)
    handlers = {m.group(1).lower() for m in HANDLER.finditer(route.read_text(encoding="utf-8"))}
    handlers &= set(HTTP)
    if not handlers:
        fail(f"{route.relative_to(ROOT)} exports no HTTP handlers")
    route_ops[path] = handlers

# ── parity ───────────────────────────────────────────────────────────────────
for path, methods in sorted(route_ops.items()):
    if path not in spec_paths:
        fail(f"route {path} exists in code but NOT in the OpenAPI document")
        continue
    for m in sorted(methods):
        if m not in spec_ops[path]:
            fail(f"{m.upper()} {path} exists in code but NOT in the OpenAPI document")
    extra = spec_ops[path] - methods
    if extra:
        fail(f"spec declares {sorted(extra)} for {path} but the route file does not export them")

for path in sorted(spec_paths - set(route_ops)):
    fail(f"spec path {path} has no corresponding route file (ghost endpoint)")

# ── public endpoints declare security: [] ────────────────────────────────────
PUBLIC = ("/api/health/live", "/api/health/ready", "/api/auth/session", "/api/auth/login", "/api/auth/setup")
for p in PUBLIC:
    item = spec.get("paths", {}).get(p)
    if not item:
        continue  # already reported by parity
    for m in spec_ops.get(p, set()):
        declared = item[m].get("security") == []
        if not declared:
            fail(f"{m.upper()} {p} must declare security: [] (public)")

if failures:
    print(f"[openapi-parity] FAIL — {len(failures)} drift finding(s):")
    for f in failures:
        print(f"  ✗ {f}")
    sys.exit(1)
n_ops = sum(len(v) for v in spec_ops.values())
print(f"[openapi-parity] OK — {len(route_ops)} route files ↔ {len(spec_paths)} spec paths ↔ {n_ops} operations, version {version}")
