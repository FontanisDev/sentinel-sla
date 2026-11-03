#!/usr/bin/env python3
"""Pixel diff for the report visual-regression check.

Compares two PNGs of identical dimensions and reports the fraction of
differing pixels (per-channel tolerance, default 8/255 — catches layout and
colour changes while ignoring anti-aliasing noise).

Usage: report-pixel-diff.py <baseline.png> <current.png> [--tolerance 8] [--max 0.001]
Exit codes: 0 within budget · 1 over budget or size mismatch · 2 usage.
"""
import sys

from PIL import Image, ImageChops


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    baseline_path, current_path = argv[1], argv[2]
    tolerance = 8
    max_frac = 0.001
    args = argv[3:]
    i = 0
    while i < len(args):
        if args[i] == "--tolerance":
            tolerance = int(args[i + 1])
            i += 2
        elif args[i] == "--max":
            max_frac = float(args[i + 1])
            i += 2
        else:
            print(f"unknown arg {args[i]}", file=sys.stderr)
            return 2

    a = Image.open(baseline_path).convert("RGB")
    b = Image.open(current_path).convert("RGB")
    if a.size != b.size:
        print(
            f"PIXEL-DIFF SIZE MISMATCH baseline={a.size} current={b.size}",
            file=sys.stderr,
        )
        return 1

    diff = ImageChops.difference(a, b).convert("L")
    # a pixel "differs" when any channel exceeds the tolerance; the L image
    # carries the max channel delta, so one threshold suffices
    hist = diff.histogram()
    total = a.size[0] * a.size[1]
    over = sum(hist[tolerance + 1:])
    frac = over / total
    status = "PASS" if frac <= max_frac else "FAIL"
    print(f"PIXEL-DIFF {status} {frac:.6%} over tolerance {tolerance}/255 "
          f"(budget {max_frac:.3%}, {over}/{total} px)")
    return 0 if frac <= max_frac else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
