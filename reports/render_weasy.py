#!/usr/bin/env python3
"""Sentinel-SLA — WeasyPrint PDF renderer (report service).

The TypeScript side builds a complete, self-contained HTML document per
report (bilingual templates, RTL support, inline SVG charts) and invokes
this script as a subprocess:

    <REPORT_PYTHON> reports/render_weasy.py <input.html> <output.pdf>

WeasyPrint (Pango + HarfBuzz) shapes Persian correctly and supports
@font-face; the HTML templates reference the bundled Vazirmatn/Inter woff2
fonts in public/fonts/ via file:// URLs resolved through --base-url, so no
system font installation is required (offline-first, portable paths).

Exit codes: 0 ok · 2 usage · 3 input missing · 4 render failure.
"""
import sys
from pathlib import Path

USAGE = "usage: render_weasy.py <input.html> <output.pdf> [base_url]"


def main(argv: list[str]) -> int:
    if len(argv) not in (3, 4):
        print(USAGE, file=sys.stderr)
        return 2

    src = Path(argv[1]).resolve()
    dst = Path(argv[2]).resolve()
    base_url = argv[3] if len(argv) == 4 else str(Path(__file__).resolve().parent.parent)

    if not src.is_file():
        print(f"render_weasy: input HTML not found: {src}", file=sys.stderr)
        return 3

    try:
        from weasyprint import HTML  # imported lazily so --help stays cheap
    except ImportError:
        print(
            "render_weasy: WeasyPrint is not installed for this interpreter "
            "(pip install weasyprint); the report container bundles it",
            file=sys.stderr,
        )
        return 4

    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        HTML(filename=str(src), base_url=base_url, encoding="utf-8").write_pdf(
            str(dst)
        )
    except Exception as exc:  # noqa: BLE001 — subprocess boundary: report and fail
        print(f"render_weasy: render failed: {exc}", file=sys.stderr)
        return 4

    if not dst.is_file() or dst.stat().st_size == 0:
        print("render_weasy: render produced no output", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
