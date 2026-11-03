// Report snapshot + template unit tests.
//
// The templates are pure functions snapshot → HTML, so the bilingual
// guarantees (RTL, Persian digits, Jalali, signature block, formula
// appendix, tamper-evident title block) are pinned here as string
// invariants. Snapshot hash rules are pinned against canonical JSON.

import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  jalaliMonthThirds,
  snapshotHash,
  unionOverlapSec,
} from '@/server/reports/snapshot';
import { renderReportHTML } from '@/server/reports/templates';

// ── fixtures (frozen, shared with the visual-regression harness) ───────────

const { executiveSnapshot, statementSnapshot, incidentSnapshot, FIXTURE_META: META, WIN } = await import(
  '../fixtures/report-snapshots'
);

// ── hash plumbing ───────────────────────────────────────────────────────────

describe('canonicalJson + snapshotHash', () => {
  it('sorts object keys deterministically regardless of insertion order', () => {
    const a = canonicalJson({ b: 1, a: { y: 2, x: 3 } });
    const b = canonicalJson({ a: { x: 3, y: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a.indexOf('"a"')).toBeLessThan(a.indexOf('"b"'));
  });

  it('preserves array order (arrays are data, not maps)', () => {
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it('same data → same hash; any change → different hash', () => {
    const s = executiveSnapshot();
    expect(snapshotHash(s)).toBe(snapshotHash(JSON.parse(JSON.stringify(s))));
    const other = { ...s, headline: { ...s.headline, breaches: 2 } };
    expect(snapshotHash(other)).not.toBe(snapshotHash(s));
  });

  it('hash is sha256 hex (64 chars)', () => {
    expect(snapshotHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('jalaliMonthThirds', () => {
  it('partitions the month into three contiguous spans', () => {
    const thirds = jalaliMonthThirds(WIN);
    expect(thirds).toHaveLength(3);
    expect(thirds[0].start.getTime()).toBe(WIN.start.getTime());
    expect(thirds[0].end.getTime()).toBe(thirds[1].start.getTime());
    expect(thirds[1].end.getTime()).toBe(thirds[2].start.getTime());
    expect(thirds[2].end.getTime()).toBe(WIN.end.getTime());
  });
});

describe('unionOverlapSec', () => {
  it('merges overlapping intervals without double counting', () => {
    const sec = unionOverlapSec(
      [
        { startMs: 0, endMs: 60_000 },
        { startMs: 30_000, endMs: 90_000 },
      ],
      0,
      120_000,
    );
    expect(sec).toBe(90); // union 0..90s
  });

  it('sums disjoint intervals and clips to the window', () => {
    const sec = unionOverlapSec(
      [
        { startMs: -50_000, endMs: 10_000 },
        { startMs: 100_000, endMs: 200_000 },
      ],
      0,
      120_000,
    );
    expect(sec).toBe(10 + 20);
  });
});

// ── template invariants (EN) ────────────────────────────────────────────────

describe('executive template (en)', () => {
  const html = renderReportHTML({
    kind: 'executive',
    lang: 'en',
    snapshot: executiveSnapshot(),
    hash: 'a'.repeat(64),
    meta: META,
  });

  it('carries the tamper-evident title block', () => {
    expect(html).toContain('Executive Monthly Report');
    expect(html).toContain('Sentinel-SLA · 2.0.0');
    expect(html).toContain('Dev Owner');
    expect(html).toContain('Mehr 1405');
    expect(html).toContain('a'.repeat(64));
    expect(html).toContain('Data snapshot SHA-256');
  });

  it('renders the headline tiles and per-client compliance', () => {
    expect(html).toContain('127.48B T');
    expect(html).toContain('Sabz Pay Gateway Co.');
    expect(html).toContain('Breach');
  });

  it('embeds the trend chart as SVG with printed labels', () => {
    expect(html).toContain('<svg');
    expect(html).toContain('Days 1–10');
  });

  it('never leaks undefined/NaN', () => {
    expect(html).not.toMatch(/undefined/);
    expect(html).not.toMatch(/NaN/);
  });
});

describe('executive template (fa)', () => {
  const html = renderReportHTML({
    kind: 'executive',
    lang: 'fa',
    snapshot: executiveSnapshot(),
    hash: 'b'.repeat(64),
    meta: { ...META, tenantNameFa: 'شرکت نمونهٔ ای‌ای' },
  });

  it('is RTL with Persian digits and the Persian title', () => {
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('گزارش ماهانه مدیران');
    expect(html).toContain('۱۲۷٫۴۸ میلیارد تومان'); // compact money headline
    expect(html).toContain('روزهای ۱ تا ۱۰'); // trend bucket label
  });

  it('keeps the SHA-256 on its own LTR line', () => {
    expect(html).toContain('class="hash-line"');
    expect(html).toContain('b'.repeat(64));
  });

  it('uses the Persian page counter style', () => {
    expect(html).toContain('counter(page, persian)');
  });
});

describe('statement template', () => {
  it('en: shows naive vs contractual availability, exclusions and penalty due', () => {
    const html = renderReportHTML({
      kind: 'statement',
      lang: 'en',
      snapshot: statementSnapshot(),
      hash: 'c'.repeat(64),
      meta: META,
    });
    expect(html).toContain('Client SLA Statement');
    expect(html).toContain('Avail. (naive)');
    expect(html).toContain('Avail. (contractual)');
    expect(html).toContain('98.399%');
    expect(html).toContain('98.468%');
    expect(html).toContain('Penalty due (payable to client)');
    expect(html).toContain('Planned-covered');
    expect(html).toContain('Datacenter network upgrade');
    expect(html).not.toMatch(/undefined/);
  });

  it('fa: signature block is present with the client name', () => {
    const html = renderReportHTML({
      kind: 'statement',
      lang: 'fa',
      snapshot: statementSnapshot(),
      hash: 'd'.repeat(64),
      meta: META,
    });
    expect(html).toContain('صورت‌حساب SLA مشتری');
    expect(html).toContain('نمایندهٔ مشتری');
    expect(html).toContain('نمایندهٔ ارائه‌دهندهٔ خدمات');
    expect(html).toContain('امضا');
    expect(html).toContain('شرکت نمونهٔ ای‌ای');
    expect(html).toContain('قابل جریمه');
  });
});

describe('incident template', () => {
  it('en: formula appendix substitutes the real inputs', () => {
    const html = renderReportHTML({
      kind: 'incident',
      lang: 'en',
      snapshot: incidentSnapshot(),
      hash: 'e'.repeat(64),
      meta: META,
    });
    expect(html).toContain('Incident Report');
    expect(html).toContain('Formula appendix');
    expect(html).toContain('7,500,000 × 45 min × 100%');
    expect(html).toContain('A. Karimi');
    expect(html).toContain('Fault started');
  });

  it('fa: hypotheses are localized Persian with the real endpoint', () => {
    const html = renderReportHTML({
      kind: 'incident',
      lang: 'fa',
      snapshot: incidentSnapshot(),
      hash: 'f'.repeat(64),
      meta: META,
    });
    expect(html).toContain('گزارش اختلال');
    expect(html).toContain('فرضیه‌های علت');
    expect(html).toContain('قطع کامل سرویس');
    expect(html).toContain('https://pay.example.ir/health');
    expect(html).toContain('شروع خرابی'); // timeline event localized
    expect(html).not.toContain('fault_started'); // raw keys never leak
  });
});
