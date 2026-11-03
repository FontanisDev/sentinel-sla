#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sentinel-SLA — Executive SLA Report Generator
==============================================
PDF generation uses ReportLab for the body and matplotlib for charts.

Reads a JSON payload describing the monitoring period (services, incidents,
chaos experiments, KPIs) and renders an executive-grade A4 PDF:
  - ReportLab body (tables, callouts, sections)
  - matplotlib charts (financial impact, uptime vs target, detection gates)
  - Fixed colour palette shared with the web UI.

Usage:
    python3 sla_report.py <payload.json> <output.pdf>

Payload contract (see src/app/api/reports/route.ts for producer):
{
  "period":   {"start": ISO, "end": ISO, "label": "Last 6 hours"},
  "generatedAt": ISO,
  "kpis":     {...KpiDTO},
  "services": [ {name, tier, status, uptime, slaTarget, incidentsCount,
                 revenueLossTomans, penaltyTomans} ],
  "incidents":[ {...IncidentDTO} ],
  "chaos":    [ {...ChaosExperimentDTO} ]
}
"""

import json
import os
import sys
import tempfile
from datetime import datetime

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.pdfmetrics import registerFontFamily
from reportlab.lib.utils import ImageReader
from reportlab.platypus import (
    Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

# ━━ Colour palette ━━
PAGE_BG       = colors.HexColor('#f5f5f4')
SECTION_BG    = colors.HexColor('#f2f1f0')
CARD_BG       = colors.HexColor('#ebeae8')
TABLE_STRIPE  = colors.HexColor('#ededeb')
HEADER_FILL   = colors.HexColor('#4e4732')
COVER_BLOCK   = colors.HexColor('#746c56')
BORDER        = colors.HexColor('#c5bfac')
ICON          = colors.HexColor('#a48e4b')
ACCENT        = colors.HexColor('#92761f')
ACCENT_2      = colors.HexColor('#3aa0c2')
TEXT_PRIMARY  = colors.HexColor('#151513')
TEXT_MUTED    = colors.HexColor('#7e7c74')
SEM_SUCCESS   = colors.HexColor('#529067')
SEM_WARNING   = colors.HexColor('#8c7443')
SEM_ERROR     = colors.HexColor('#a25b54')
SEM_INFO      = colors.HexColor('#507aa4')

HEX = {
    'HEADER_FILL': '#4e4732', 'COVER_BLOCK': '#746c56', 'BORDER': '#c5bfac',
    'ICON': '#a48e4b', 'ACCENT': '#92761f', 'ACCENT_2': '#3aa0c2',
    'TEXT_PRIMARY': '#151513', 'TEXT_MUTED': '#7e7c74', 'PAGE_BG': '#f5f5f4',
    'CARD_BG': '#ebeae8', 'SEM_SUCCESS': '#529067', 'SEM_WARNING': '#8c7443',
    'SEM_ERROR': '#a25b54', 'SEM_INFO': '#507aa4',
}

TABLE_HEADER_COLOR = HEADER_FILL
TABLE_ROW_EVEN      = colors.white
TABLE_ROW_ODD       = TABLE_STRIPE

# ── Fonts (allowed list only) ────────────────────────────────────────────────
# Debian/Ubuntu: /usr/share/fonts/truetype/freefont  Fedora: /usr/share/fonts/gnu-free
# Override with the FONT_DIR environment variable.
_FONT_DIRS = [
    os.environ.get('FONT_DIR', ''),
    '/usr/share/fonts/truetype/freefont',
    '/usr/share/fonts/gnu-free',
]
FONT_DIR = next(
    (d for d in _FONT_DIRS if d and os.path.exists(os.path.join(d, 'FreeSerif.ttf'))),
    '/usr/share/fonts/truetype/freefont',
)
pdfmetrics.registerFont(TTFont('FreeSerif', f'{FONT_DIR}/FreeSerif.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif-Bold', f'{FONT_DIR}/FreeSerifBold.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif-Italic', f'{FONT_DIR}/FreeSerifItalic.ttf'))
pdfmetrics.registerFont(TTFont('FreeSerif-BoldItalic', f'{FONT_DIR}/FreeSerifBoldItalic.ttf'))
registerFontFamily('FreeSerif', normal='FreeSerif', bold='FreeSerif-Bold',
                   italic='FreeSerif-Italic', boldItalic='FreeSerif-BoldItalic')

PAGE_W, PAGE_H = A4
MARGIN = 0.9 * inch
AVAIL_W = PAGE_W - 2 * MARGIN


# ── Formatting helpers ────────────────────────────────────────────────────────
def fmt_tomans(v):
    """Compact Tomans: 3_008_878_540 -> '3.01B T'."""
    try:
        v = float(v)
    except (TypeError, ValueError):
        return '0 T'
    if abs(v) >= 1_000_000_000:
        return f'{v / 1_000_000_000:.2f}B T'
    if abs(v) >= 1_000_000:
        return f'{v / 1_000_000:.1f}M T'
    if abs(v) >= 1_000:
        return f'{v / 1_000:.0f}K T'
    return f'{v:.0f} T'


def fmt_pct(ratio, digits=3):
    try:
        return f'{float(ratio) * 100:.{digits}f}%'
    except (TypeError, ValueError):
        return 'n/a'


def fmt_sec(v):
    if v is None:
        return 'n/a'
    v = float(v)
    if v < 60:
        return f'{v:.0f}s'
    m, s = divmod(int(v), 60)
    return f'{m}m {s}s' if s else f'{m}m'


def fmt_ts(iso):
    if not iso:
        return 'n/a'
    try:
        dt = datetime.fromisoformat(str(iso).replace('Z', '+00:00'))
        return dt.strftime('%d %b %H:%M')
    except ValueError:
        return str(iso)


def fmt_int(v):
    try:
        return f'{int(round(float(v))):,}'
    except (TypeError, ValueError):
        return 'n/a'


# ── Paragraph styles ──────────────────────────────────────────────────────────
S = {}
S['body'] = ParagraphStyle('body', fontName='FreeSerif', fontSize=10.5, leading=16,
                           alignment=TA_JUSTIFY, textColor=TEXT_PRIMARY, spaceAfter=8)
S['h1'] = ParagraphStyle('h1', fontName='FreeSerif-Bold', fontSize=17, leading=22,
                         textColor=HEADER_FILL, spaceBefore=18, spaceAfter=8)
S['caption'] = ParagraphStyle('caption', fontName='FreeSerif-Italic', fontSize=8.5,
                              leading=11, alignment=TA_CENTER, textColor=TEXT_MUTED)
S['th'] = ParagraphStyle('th', fontName='FreeSerif-Bold', fontSize=9,
                        leading=12, textColor=colors.white, alignment=TA_CENTER)
S['td'] = ParagraphStyle('td', fontName='FreeSerif', fontSize=9, leading=12,
                         textColor=TEXT_PRIMARY, alignment=TA_CENTER)
S['tdl'] = ParagraphStyle('tdl', fontName='FreeSerif', fontSize=9, leading=12,
                          textColor=TEXT_PRIMARY, alignment=TA_LEFT)
S['tdr'] = ParagraphStyle('tdr', fontName='FreeSerif', fontSize=9, leading=12,
                          textColor=TEXT_PRIMARY, alignment=TA_RIGHT)
S['stat_big'] = ParagraphStyle('stat_big', fontName='FreeSerif-Bold', fontSize=17,
                               leading=21, textColor=HEADER_FILL, alignment=TA_CENTER)
S['stat_lbl'] = ParagraphStyle('stat_lbl', fontName='FreeSerif', fontSize=7.5,
                               leading=10, textColor=colors.white, alignment=TA_CENTER)


# ── Charts (matplotlib, per charts.md: no top/right spines, dashed grid) ──────
MPL_RC = {
    'figure.facecolor': 'white', 'axes.facecolor': 'white',
    'axes.edgecolor': HEX['BORDER'], 'axes.linewidth': 0.8,
    'axes.labelcolor': HEX['TEXT_PRIMARY'], 'text.color': HEX['TEXT_PRIMARY'],
    'xtick.color': HEX['TEXT_MUTED'], 'ytick.color': HEX['TEXT_MUTED'],
    'xtick.labelsize': 10, 'ytick.labelsize': 10,
    'font.family': 'DejaVu Sans', 'axes.grid': True,
    'grid.linestyle': (0, (4, 4)), 'grid.linewidth': 0.5, 'grid.alpha': 0.18,
    'grid.color': HEX['TEXT_MUTED'],
}


def _strip_axes(ax):
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)


def chart_financial(services, path):
    """Horizontal bar — revenue loss by service (labels long -> horizontal)."""
    rows = sorted(services, key=lambda s: s.get('revenueLossTomans', 0), reverse=True)
    names = [r['name'] for r in rows]
    vals = [r.get('revenueLossTomans', 0) / 1e6 for r in rows]
    vmax = max(vals) if vals and max(vals) > 0 else 1
    # Minimum visible bar length so small (but non-zero) losses stay readable.
    vis = [v if v <= 0 else max(v, vmax * 0.012) for v in vals]
    fig, ax = plt.subplots(figsize=(7.2, 2.0 + 0.42 * len(rows)), dpi=200)
    with plt.rc_context(MPL_RC):
        bars = ax.barh(names[::-1], vis[::-1], height=0.62, color=HEX['SEM_ERROR'],
                       alpha=0.85, zorder=3)
        for b, v in zip(bars, vals[::-1]):
            ax.text(b.get_width() + vmax * 0.015, b.get_y() + b.get_height() / 2,
                    fmt_tomans(v * 1e6), va='center', ha='left', fontsize=9.5,
                    color=HEX['TEXT_PRIMARY'])
        ax.set_xlabel('Revenue loss (million Tomans)', fontsize=10)
        ax.set_xlim(0, vmax * 1.24)
        ax.xaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f'{x:,.0f}'))
        ax.grid(axis='y', visible=False)
        _strip_axes(ax)
        fig.tight_layout(pad=1.4)
        fig.savefig(path, bbox_inches='tight')
        plt.close(fig)


def chart_uptime(services, path):
    """Horizontal bar — uptime vs SLA target."""
    rows = sorted(services, key=lambda s: s.get('uptime', 1))
    names = [r['name'] for r in rows]
    up = [r.get('uptime', 1) * 100 for r in rows]
    tgt = [r.get('slaTarget', 0.999) * 100 for r in rows]
    fig, ax = plt.subplots(figsize=(7.2, 2.0 + 0.42 * len(rows)), dpi=200)
    with plt.rc_context(MPL_RC):
        ok = [u >= t for u, t in zip(up, tgt)]
        ax.barh(names[::-1], up[::-1], height=0.6,
                color=[HEX['SEM_SUCCESS'] if k else HEX['SEM_ERROR'] for k in ok[::-1]],
                alpha=0.88, zorder=3)
        for i, (u, t) in enumerate(zip(up[::-1], tgt[::-1])):
            ax.plot([t, t], [i - 0.42, i + 0.42], color=HEX['TEXT_PRIMARY'],
                    lw=1.6, ls=(0, (3, 2)), zorder=4)
            ax.text(u - 0.06, i, f'{u:.3f}%', va='center', ha='right', fontsize=9.5,
                    color=HEX['TEXT_PRIMARY'])
        ax.set_xlabel('Uptime % (dashed marker = SLA target)', fontsize=10)
        ax.set_xlim(right=100.6)
        lo = min(min(up), min(tgt)) if up else 90
        ax.set_xlim(left=max(0, min(90.0, lo - 1.5)))
        ax.grid(axis='y', visible=False)
        _strip_axes(ax)
        fig.tight_layout(pad=1.4)
        fig.savefig(path, bbox_inches='tight')
        plt.close(fig)


def chart_mttd(incidents, path):
    """MTTD per incident with the 60s gate line ('first/last/max/min' labels)."""
    rows = [i for i in incidents if i.get('mttdSec') is not None][-14:]
    if not rows:
        return False
    xs = list(range(1, len(rows) + 1))
    ys = [float(i['mttdSec']) for i in rows]
    fig, ax = plt.subplots(figsize=(7.2, 2.7), dpi=200)
    with plt.rc_context(MPL_RC):
        ax.plot(xs, ys, color=HEX['ACCENT'], lw=2.4, marker='o', ms=4,
                mfc=HEX['ACCENT'], zorder=3, solid_capstyle='round')
        ax.fill_between(xs, ys, color=HEX['ACCENT'], alpha=0.12, zorder=2)
        ax.axhline(60, color=HEX['SEM_ERROR'], lw=1.4, ls=(0, (5, 3)), zorder=2)
        ax.text(len(xs) + 0.15, 60, 'gate 60s', fontsize=9, color=HEX['SEM_ERROR'],
                va='center', ha='left')
        key_pts = {0: ys[0], len(ys) - 1: ys[-1]}
        if len(ys) > 2:
            key_pts[ys.index(max(ys))] = max(ys)
            key_pts[ys.index(min(ys))] = min(ys)
        for idx, v in key_pts.items():
            ax.annotate(f'{v:.0f}s', (xs[idx], v), textcoords='offset points',
                        xytext=(0, 8), fontsize=9, ha='center',
                        color=HEX['TEXT_PRIMARY'])
        ax.set_xticks(xs)
        ax.set_xticklabels([i['serviceName'][:12] for i in rows], rotation=38,
                           ha='right', fontsize=8.5)
        ax.set_ylabel('MTTD (seconds)', fontsize=10)
        ax.set_ylim(bottom=0)
        ax.grid(axis='x', visible=False)
        _strip_axes(ax)
        fig.tight_layout(pad=1.4)
        fig.savefig(path, bbox_inches='tight')
        plt.close(fig)
    return True


class ReportDoc(SimpleDocTemplate):
    """SimpleDocTemplate carrying the cover/header data used by the page callbacks."""
    _period_label: str = ''
    _generated_label: str = ''
    _tenant_name = None
    _cover_stats: list


# ── Table builder ─────────────────────────────────────────────────────────────
def fit_image(path, max_w, max_h=280):
    """Load an image scaled to fit (max_w, max_h) preserving aspect ratio."""
    iw, ih = ImageReader(path).getSize()
    scale = min(max_w / iw, max_h / ih)
    img = Image(path, width=iw * scale, height=ih * scale)
    img.hAlign = 'CENTER'
    return img


def make_table(header, rows, ratios, aligns=None, highlight_rows=None):
    """header: [str], rows: [[str]], ratios sum to 1.0, aligns: list of 'L'/'C'/'R'."""
    aligns = aligns or ['C'] * len(header)
    stylemap = {'L': S['tdl'], 'C': S['td'], 'R': S['tdr']}
    data = [[Paragraph(f'<b>{h}</b>', S['th']) for h in header]]
    for row in rows:
        data.append([Paragraph(str(c), stylemap[aligns[j]]) for j, c in enumerate(row)])
    col_w = [r * AVAIL_W for r in ratios]
    t = Table(data, colWidths=col_w, hAlign='CENTER', repeatRows=1)
    style = [
        ('BACKGROUND', (0, 0), (-1, 0), TABLE_HEADER_COLOR),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('GRID', (0, 0), (-1, -1), 0.4, BORDER),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [TABLE_ROW_EVEN, TABLE_ROW_ODD]),
    ]
    for i in (highlight_rows or []):
        style.append(('BACKGROUND', (0, i + 1), (-1, i + 1), CARD_BG))
    t.setStyle(TableStyle(style))
    return t


def callout_kpis(kpis, escalated=0):
    """Executive summary stat strip (Data Sculpture) — 2×4 grid:
    uptime / money row + response-time row (MTTD/MTTA/MTTR + escalations)."""
    cells = [
        (fmt_pct(kpis.get('fleetUptime')), 'Fleet uptime'),
        (fmt_tomans(kpis.get('lostRevenueTomans', 0)), 'Revenue loss'),
        (fmt_tomans(kpis.get('penaltyExposureTomans', 0)), 'SLA penalties'),
        (fmt_int(kpis.get('transactionsLost', 0)), 'Transactions lost'),
        (fmt_sec(kpis.get('avgMttdSec')), 'Avg. MTTD'),
        (fmt_sec(kpis.get('avgMttaSec')), 'Avg. MTTA'),
        (fmt_sec(kpis.get('avgMttrSec')), 'Avg. MTTR'),
        (fmt_int(escalated), 'Escalations'),
    ]
    COLS = 4
    cw = AVAIL_W / COLS - 6
    rows = []
    for r in range(0, len(cells), COLS):
        row = []
        for val, lbl in cells[r:r + COLS]:
            inner = Table(
                [[Paragraph(f'<b>{val}</b>', S['stat_big'])], [Paragraph(lbl, S['stat_lbl'])]],
                colWidths=[cw])
            inner.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, -1), COVER_BLOCK),
                ('TOPPADDING', (0, 0), (-1, 0), 8), ('BOTTOMPADDING', (0, -1), (-1, -1), 7),
                ('TOPPADDING', (0, 1), (-1, 1), 1),
                ('LEFTPADDING', (0, 0), (-1, -1), 2), ('RIGHTPADDING', (0, 0), (-1, -1), 2),
            ]))
            row.append(inner)
        rows.append(row)
    outer = Table(rows, colWidths=[AVAIL_W / COLS] * COLS, hAlign='CENTER')
    outer.setStyle(TableStyle([
        ('LEFTPADDING', (0, 0), (-1, -1), 3), ('RIGHTPADDING', (0, 0), (-1, -1), 3),
        ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ]))
    return outer


# ── Cover (ReportLab-native, follows cover typography scale + safe zones) ─────
def draw_cover(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(PAGE_BG)
    canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)

    # Geometric accent: restrained radar arcs, top-right
    canvas.setStrokeColor(colors.HexColor('#d8d3c3'))
    canvas.setLineWidth(1)
    for r in (60, 105, 150, 195):
        canvas.circle(PAGE_W - 70, PAGE_H - 130, r, stroke=1, fill=0)
    canvas.setStrokeColor(ACCENT)
    canvas.setLineWidth(1.6)
    canvas.arc(PAGE_W - 70 - 135, PAGE_H - 130 - 135, PAGE_W - 70 + 135,
               PAGE_H - 130 + 135, 35, 75)
    canvas.setFillColor(ACCENT)
    canvas.circle(PAGE_W - 70, PAGE_H - 130, 3.2, stroke=0, fill=1)

    # Brand block (top-left)
    canvas.setFillColor(HEADER_FILL)
    canvas.setFont('FreeSerif-Bold', 13)
    canvas.drawString(MARGIN, PAGE_H - 1.35 * inch, 'SENTINEL-SLA')
    canvas.setFillColor(TEXT_MUTED)
    canvas.setFont('FreeSerif', 9)
    canvas.drawString(MARGIN, PAGE_H - 1.35 * inch - 14, 'Fintech Service-Level Command Center')
    canvas.setStrokeColor(ACCENT)
    canvas.setLineWidth(2)
    canvas.line(MARGIN, PAGE_H - 1.35 * inch - 26, MARGIN + 64, PAGE_H - 1.35 * inch - 26)

    # v2.3 per-tenant branding: "prepared for" block under the brand.
    # NOTE: only the Latin-script tenant name is rendered — ReportLab has no
    # Arabic shaping, so the Persian nameFa would print disconnected glyphs.
    tenant_name = getattr(doc, '_tenant_name', None)
    if tenant_name:
        tag_y = PAGE_H - 1.35 * inch - 52
        canvas.setFillColor(ACCENT_2)
        canvas.roundRect(MARGIN, tag_y - 4, 92, 15, 3, stroke=0, fill=1)
        canvas.setFillColor(colors.white)
        canvas.setFont('FreeSerif-Bold', 7.5)
        canvas.drawCentredString(MARGIN + 46, tag_y, 'PREPARED FOR')
        canvas.setFillColor(TEXT_PRIMARY)
        canvas.setFont('FreeSerif-Bold', 15)
        canvas.drawString(MARGIN + 102, tag_y - 1, tenant_name)

    # Title (40pt-class, chunked with line breaks per cover rules)
    canvas.setFillColor(TEXT_PRIMARY)
    canvas.setFont('FreeSerif-Bold', 40)
    canvas.drawString(MARGIN, PAGE_H - 3.15 * inch, 'Executive Service')
    canvas.drawString(MARGIN, PAGE_H - 3.15 * inch - 48, 'Level Report')
    canvas.setFillColor(COVER_BLOCK)
    canvas.setFont('FreeSerif', 15)
    canvas.drawString(MARGIN, PAGE_H - 3.15 * inch - 86,
                      'Technical availability, translated into Tomans.')

    # Summary block (mandatory) — 3 headline stats
    y0 = 2.05 * inch
    stats = doc._cover_stats
    labels = ['FLEET UPTIME', 'REVENUE LOSS', 'SLA PENALTIES']
    for i, (val, lbl) in enumerate(zip(stats, labels)):
        x = MARGIN + i * (AVAIL_W / 3)
        canvas.setFillColor(CARD_BG)
        canvas.roundRect(x, y0 - 0.62 * inch, AVAIL_W / 3 - 14, 0.92 * inch, 8,
                         stroke=0, fill=1)
        canvas.setFillColor(HEADER_FILL)
        canvas.setFont('FreeSerif-Bold', 20)
        canvas.drawString(x + 12, y0 - 0.62 * inch + 38, val)
        canvas.setFillColor(TEXT_MUTED)
        canvas.setFont('FreeSerif-Bold', 8)
        canvas.drawString(x + 12, y0 - 0.62 * inch + 16, lbl)

    # Meta (bottom-left, safe zone)
    canvas.setFillColor(TEXT_MUTED)
    canvas.setFont('FreeSerif', 9.5)
    canvas.drawString(MARGIN, 1.28 * inch, f'Period: {doc._period_label}')
    canvas.drawString(MARGIN, 1.28 * inch - 15, f'Generated: {doc._generated_label}')
    canvas.setFont('FreeSerif-Italic', 8.5)
    canvas.drawString(MARGIN, 0.78 * inch,
                      'Prepared automatically by the Sentinel-SLA monitoring engine — '
                      'numbers cross-checked against the incident register.')
    canvas.restoreState()


def draw_body_page(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(BORDER)
    canvas.setLineWidth(0.6)
    canvas.line(MARGIN, PAGE_H - 0.62 * inch, PAGE_W - MARGIN, PAGE_H - 0.62 * inch)
    canvas.setFont('FreeSerif', 7.5)
    canvas.setFillColor(TEXT_MUTED)
    header_left = 'Sentinel-SLA — Executive SLA Report'
    tenant_name = getattr(doc, '_tenant_name', None)
    if tenant_name:
        header_left += f' — {tenant_name}'
    canvas.drawString(MARGIN, PAGE_H - 0.55 * inch, header_left)
    canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - 0.55 * inch, doc._period_label)
    canvas.setFont('FreeSerif-Italic', 8)
    canvas.drawString(MARGIN, 0.5 * inch, f'Page {doc.page}')
    canvas.drawRightString(PAGE_W - MARGIN, 0.5 * inch, 'sentinel-sla / executive-brief')
    canvas.restoreState()


# ── Document assembly ─────────────────────────────────────────────────────────
def build_report(payload, out_path, tmpdir):
    kpis = payload.get('kpis', {})
    services = payload.get('services', [])
    incidents = payload.get('incidents', [])
    # v2.6: incidents that outlived the escalation timeout (register carries
    # escalatedAt since the ladder shipped).
    escalated_count = sum(1 for i in incidents if i.get('escalatedAt'))
    chaos = payload.get('chaos', [])
    period = payload.get('period', {})

    doc = ReportDoc(
        out_path, pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=0.95 * inch, bottomMargin=0.78 * inch,
        title='Sentinel-SLA Executive Service Level Report',
        author='Sentinel-SLA', creator='Sentinel-SLA',
        subject='Executive SLA report — financial impact of service downtime')
    doc._period_label = period.get('label', 'Monitoring period')
    doc._generated_label = fmt_ts(payload.get('generatedAt'))
    # v2.3: per-tenant branding (Latin name only — no Arabic shaping in ReportLab).
    tenant = payload.get('tenant') or {}
    doc._tenant_name = tenant.get('name') or None
    doc._cover_stats = [
        fmt_pct(kpis.get('fleetUptime')),
        fmt_tomans(kpis.get('lostRevenueTomans', 0)),
        fmt_tomans(kpis.get('penaltyExposureTomans', 0)),
    ]

    story = []

    # Cover occupies page 1 alone (drawn by onFirstPage); body starts on page 2.
    from reportlab.platypus import PageBreak
    story.append(PageBreak())

    # 1 ─ Executive Summary ------------------------------------------------
    story.append(Paragraph('<b>1. Executive Summary</b>', S['h1']))
    total_impact = (kpis.get('lostRevenueTomans', 0) + kpis.get('penaltyExposureTomans', 0))
    story.append(Paragraph(
        f'During the reporting period ({doc._period_label.lower()}), Sentinel-SLA continuously '
        f'probed the production fintech fleet and translated every technical deviation into '
        f'its financial consequence. The fleet recorded an uptime of '
        f'<b>{fmt_pct(kpis.get("fleetUptime"))}</b> across '
        f'{kpis.get("totalServices", len(services))} services, with '
        f'{kpis.get("incidentsTotal", 0)} incidents in total. '
        f'{fmt_int(kpis.get("transactionsLost", 0))} transactions were lost while services '
        f'were unavailable, which represents <b>{fmt_tomans(kpis.get("lostRevenueTomans", 0))}</b> '
        f'in transaction value taken out of the pipeline. Contractual SLA penalties for the '
        f'period amount to <b>{fmt_tomans(kpis.get("penaltyExposureTomans", 0))}</b>, bringing '
        f'the total cost of downtime exposure to <b>{fmt_tomans(total_impact)}</b>.', S['body']))
    story.append(Paragraph(
        f'The monitoring pipeline detected outages with a mean time to detect (MTTD) of '
        f'<b>{fmt_sec(kpis.get("avgMttdSec"))}</b>&nbsp;— comfortably inside the 60-second '
        f'contractual detection gate&nbsp;— and the mean time to recovery (MTTR) closed at '
        f'<b>{fmt_sec(kpis.get("avgMttrSec"))}</b>. On-call acknowledged pages with a mean '
        f'time to acknowledge (MTTA) of <b>{fmt_sec(kpis.get("avgMttaSec"))}</b>; '
        f'<b>{fmt_int(escalated_count)}</b> incident(s) outlived the escalation policy timeout '
        f'and were re-paged up the on-call ladder. '
        f'{kpis.get("slaCompliantServices", 0)} of {kpis.get("totalServices", len(services))} '
        f'services currently satisfy their SLA target. The figures in this report are derived '
        f'from the same incident register that drives live alerting, so every number below '
        f'can be traced back to a logged event.', S['body']))
    story.append(Spacer(1, 6))
    story.append(callout_kpis(kpis, escalated_count))
    story.append(Spacer(1, 10))

    # 2 ─ Financial Impact --------------------------------------------------
    story.append(Paragraph('<b>2. Financial Impact of Downtime</b>', S['h1']))
    story.append(Paragraph(
        'The table below decomposes the cost of unreliability by service. Revenue loss is '
        'the transaction value that could not be processed while the service was degraded '
        'or fully unavailable; the SLA penalty is the contractual charge that applies once '
        'the incident crosses the contract threshold.', S['body']))
    rows = []
    for s in sorted(services, key=lambda x: x.get('revenueLossTomans', 0), reverse=True):
        rows.append([
            s.get('name', 'n/a'), s.get('tier', 'n/a'),
            fmt_int(s.get('incidentsCount', 0)),
            fmt_tomans(s.get('revenueLossTomans', 0)),
            fmt_tomans(s.get('penaltyTomans', 0)),
            fmt_tomans(s.get('revenueLossTomans', 0) + s.get('penaltyTomans', 0)),
        ])
    rows.append(['<b>Total</b>', 'n/a', f"<b>{fmt_int(kpis.get('incidentsTotal', 0))}</b>",
                 f"<b>{fmt_tomans(kpis.get('lostRevenueTomans', 0))}</b>",
                 f"<b>{fmt_tomans(kpis.get('penaltyExposureTomans', 0))}</b>",
                 f"<b>{fmt_tomans(total_impact)}</b>"])
    story.append(make_table(
        ['Service', 'Tier', 'Incidents', 'Revenue loss', 'SLA penalty', 'Total impact'],
        rows, [0.28, 0.10, 0.12, 0.17, 0.15, 0.18],
        aligns=['L', 'C', 'C', 'R', 'R', 'R']))
    story.append(Spacer(1, 14))

    ch1 = os.path.join(tmpdir, 'chart_fin.png')
    chart_financial(services, ch1)
    if os.path.exists(ch1):
        story.append(Spacer(1, 8))
        story.append(fit_image(ch1, AVAIL_W * 0.96, 250))
        story.append(Spacer(1, 4))
        story.append(Paragraph('Figure 1 — Revenue loss by service (million Tomans).',
                               S['caption']))

    # 3 ─ SLA Compliance -----------------------------------------------------
    story.append(Paragraph('<b>3. SLA Compliance</b>', S['h1']))
    story.append(Paragraph(
        'Each service carries its own contractual availability target. A service is '
        'compliant when its measured uptime over the period meets or exceeds that target; '
        'otherwise the SLA penalty clauses of the contract are triggered.', S['body']))
    rows = []
    hl = []
    for i, s in enumerate(sorted(services, key=lambda x: x.get('uptime', 1))):
        up, tgt = s.get('uptime', 0), s.get('slaTarget', 0.999)
        rows.append([s.get('name', 'n/a'), fmt_pct(up), fmt_pct(tgt, 2),
                     'COMPLIANT' if up >= tgt else 'BREACH',
                     fmt_tomans(s.get('penaltyTomans', 0)) if up < tgt else 'n/a'])
        if up < tgt:
            hl.append(i)
    story.append(make_table(
        ['Service', 'Uptime', 'SLA target', 'Status', 'Penalty triggered'],
        rows, [0.30, 0.17, 0.17, 0.18, 0.18],
        aligns=['L', 'C', 'C', 'C', 'R'], highlight_rows=hl))
    story.append(Spacer(1, 14))
    ch2 = os.path.join(tmpdir, 'chart_up.png')
    chart_uptime(services, ch2)
    if os.path.exists(ch2):
        story.append(fit_image(ch2, AVAIL_W * 0.96, 250))
        story.append(Spacer(1, 4))
        story.append(Paragraph('Figure 2 — Measured uptime against SLA target.', S['caption']))

    # 4 ─ Incident Register ---------------------------------------------------
    story.append(Paragraph('<b>4. Incident Register</b>', S['h1']))
    story.append(Paragraph(
        'Every incident below is a logged event chain (fault started, detected, resolved) '
        'recorded by the detection pipeline. MTTD measures how quickly monitoring noticed '
        'the fault; MTTA how quickly on-call took ownership of the page; MTTR the full '
        'business impact window. “ESC” marks incidents that outlived the escalation '
        'policy timeout and were re-paged up the on-call ladder.', S['body']))
    if incidents:
        rows = []
        for i in incidents[:18]:
            sev = i.get('severity', 'critical')
            rows.append([
                fmt_ts(i.get('startedAt')), i.get('serviceName', 'n/a'),
                'CRITICAL' if sev == 'critical' else 'WARNING',
                i.get('source', 'n/a').upper(),
                fmt_sec(i.get('mttdSec')), fmt_sec(i.get('mttaSec')), fmt_sec(i.get('mttrSec')),
                ('ESC' if i.get('escalatedAt') else '—'),
                fmt_int(i.get('lostTransactions', 0)),
                fmt_tomans(i.get('revenueLossTomans', 0)),
            ])
        story.append(make_table(
            ['Started', 'Service', 'Severity', 'Source', 'MTTD', 'MTTA', 'MTTR',
             'Esc.', 'Lost tx', 'Revenue loss'],
            rows, [0.12, 0.15, 0.10, 0.13, 0.07, 0.07, 0.07, 0.07, 0.09, 0.13],
            aligns=['L', 'L', 'C', 'C', 'C', 'C', 'C', 'C', 'R', 'R']))
        story.append(Spacer(1, 14))
        ch3 = os.path.join(tmpdir, 'chart_mttd.png')
        if chart_mttd(incidents, ch3):
            story.append(fit_image(ch3, AVAIL_W * 0.96, 250))
            story.append(Spacer(1, 4))
            story.append(Paragraph(
                'Figure 3 — Detection latency (MTTD) per incident against the 60s gate.',
                S['caption']))
    else:
        story.append(Paragraph(
            'No incidents were recorded during the reporting period. The fleet ran clean '
            'and no SLA penalty clauses were triggered.', S['body']))

    # 5 ─ Chaos Engineering ----------------------------------------------------
    story.append(Paragraph('<b>5. Chaos Engineering Self-Tests</b>', S['h1']))
    story.append(Paragraph(
        'Sentinel-SLA verifies its own detection pipeline by deliberately injecting '
        'controlled faults into production services (chaos experiments). Each experiment '
        'measures whether the outage was detected within the 60-second contractual gate. '
        'A failed gate means the monitoring pipeline itself needs attention — this is the '
        'system testing itself.', S['body']))
    if chaos:
        rows = []
        for c in chaos[:12]:
            status = c.get('status', 'n/a')
            badge = {'running': 'RUNNING', 'passed': 'GATE PASSED',
                     'failed': 'GATE FAILED', 'aborted': 'ABORTED'}.get(status, status.upper())
            rows.append([
                fmt_ts(c.get('startedAt')), c.get('serviceName', 'n/a'),
                c.get('type', 'n/a').replace('-', ' ').title(),
                fmt_sec(c.get('mttdSec')), fmt_sec(c.get('mttrSec')), badge])
        story.append(make_table(
            ['Started', 'Service', 'Fault type', 'MTTD', 'MTTR', 'Result'],
            rows, [0.20, 0.24, 0.16, 0.12, 0.12, 0.16]))
    else:
        story.append(Paragraph(
            'No chaos experiments were executed in this period. The scheduled weekly '
            'self-test (see methodology) will populate this section automatically.', S['body']))

    # 6 ─ Methodology -----------------------------------------------------------
    story.append(Paragraph('<b>6. Methodology and Next Steps</b>', S['h1']))
    story.append(Paragraph(
        'Data collection, processing, alerting and reporting follow the five-stage '
        'pipeline defined for Sentinel-SLA: metrics are collected by continuously probing '
        'each service health endpoint; the processor applies consecutive-failure '
        'detection logic before opening an incident; alerts are dispatched in two '
        'languages — a technical format for the engineering on-call channel, and an '
        'executive format quantifying the loss in Tomans per minute; the reporting stage '
        'produces this document; and the feedback loop feeds MTTD/MTTR results back '
        'into the alerting thresholds. Deployment artifacts assemble the industrial '
        'open-source stack (Prometheus, Blackbox Exporter, Loki, Alertmanager, Grafana) '
        'via Docker Compose and Helm; custom Go exporters expose the financial metrics.',
        S['body']))
    story.append(Paragraph(
        'Recommended next steps: (1) review the services currently below their SLA target '
        'and prioritise their error budgets; (2) schedule the weekly chaos self-test if '
        'not yet enabled, so the 60-second detection gate is continuously verified; '
        '(3) after MVP sign-off, extend the platform with Kubernetes integration, '
        'multi-tenant support and richer financial reporting.', S['body']))

    doc.build(story, onFirstPage=draw_cover, onLaterPages=draw_body_page)


def main():
    if len(sys.argv) != 3:
        print('usage: sla_report.py <payload.json> <output.pdf>', file=sys.stderr)
        sys.exit(2)
    payload_path, out_path = sys.argv[1], sys.argv[2]
    with open(payload_path, 'r', encoding='utf-8') as f:
        payload = json.load(f)
    tmpdir = tempfile.mkdtemp(prefix='sentinel-report-')
    try:
        build_report(payload, out_path, tmpdir)
    finally:
        for f in os.listdir(tmpdir):
            try:
                os.remove(os.path.join(tmpdir, f))
            except OSError:
                pass
        try:
            os.rmdir(tmpdir)
        except OSError:
            pass
    size = os.path.getsize(out_path)
    print(json.dumps({'ok': True, 'file': out_path, 'bytes': size}))


if __name__ == '__main__':
    main()
