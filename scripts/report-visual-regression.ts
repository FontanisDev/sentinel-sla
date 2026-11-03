// ═══════════════════════════════════════════════════════════════════════════
// Sentinel-SLA — report visual-regression check.
//
// Renders the three report templates × two languages from FROZEN fixture
// snapshots (tests/fixtures/report-snapshots.ts) through the REAL pipeline
// (templates.ts → reports/render_weasy.py → WeasyPrint) and compares page-1
// pixels against the approved baselines in tests/visual/reports-baseline/.
//
// Why frozen fixtures: the live demo DB changes every engine tick, so real
// reports can never be pixel-stable. The fixtures freeze the DATA; the
// harness then pins the PRESENTATION — any template/CSS change that moves
// a pixel fails until baselines are re-approved (--update) and a human
// re-checks the diff. WeasyPrint is deterministic for identical input, so
// unchanged templates diff 0.0000%.
//
// Usage:
//   bun scripts/report-visual-regression.ts            # comparison run (diff)
//   bun scripts/report-visual-regression.ts --update   # re-approve baselines
// Exit: 0 pass · 1 fail.
// ═══════════════════════════════════════════════════════════════════════════

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const WORK = path.join(ROOT, 'data', 'report-regression');
const BASELINES = path.join(ROOT, 'tests', 'visual', 'reports-baseline');
const UPDATE = process.argv.includes('--update');
const RASTER_DPI = '90';

const COMBOS = [
  ['executive', 'en'],
  ['executive', 'fa'],
  ['statement', 'en'],
  ['statement', 'fa'],
  ['incident', 'en'],
  ['incident', 'fa'],
] as const;

async function main() {
  const { renderReportHTML } = await import(path.join(ROOT, 'src/server/reports/templates'));
  const fixtures = await import(path.join(ROOT, 'tests/fixtures/report-snapshots'));
  const { snapshotHash } = await import(path.join(ROOT, 'src/server/reports/snapshot'));

  // getConfig() logs a banner line on first call — parse the LAST stdout line
  const raw = execFileSync(
    'bun',
    ['-e', 'import { getConfig } from "./src/server/config"; console.log(JSON.stringify({ py: getConfig().reportPython, weasy: getConfig().reportWeasyScript }))'],
    { cwd: ROOT, encoding: 'utf-8' },
  );
  const jsonLine = raw.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
  const config = JSON.parse(jsonLine ?? '{}');
  if (!config.py) throw new Error('REPORT_PYTHON not configured — cannot run the visual check');

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  if (UPDATE) mkdirSync(BASELINES, { recursive: true });

  let failures = 0;
  for (const [kind, lang] of COMBOS) {
    const combo = `${kind}-${lang}`;
    const snapshot =
      kind === 'executive'
        ? fixtures.executiveSnapshot()
        : kind === 'statement'
          ? fixtures.statementSnapshot()
          : fixtures.incidentSnapshot();
    const hash = snapshotHash(snapshot);
    const html = renderReportHTML({
      kind,
      lang,
      snapshot,
      hash,
      meta: fixtures.FIXTURE_META,
    });

    const htmlPath = path.join(WORK, `${combo}.html`);
    const pdfPath = path.join(WORK, `${combo}.pdf`);
    const prefix = path.join(WORK, combo); // pdftoppm appends -1/-01/-001
    writeFileSync(htmlPath, html, 'utf-8');

    execFileSync(config.py, [config.weasy, htmlPath, pdfPath, ROOT], { stdio: 'pipe' });
    execFileSync('pdftoppm', ['-png', '-r', RASTER_DPI, '-f', '1', '-l', '1', pdfPath, prefix], {
      stdio: 'pipe',
    });
    const current = [`${prefix}-1.png`, `${prefix}-01.png`, `${prefix}-001.png`].find((p) =>
      existsSync(p),
    );
    if (!current) throw new Error(`pdftoppm produced no page-1 PNG for ${combo}`);
    const baseline = path.join(BASELINES, `${combo}-page1.png`);

    if (UPDATE) {
      execFileSync('cp', [current, baseline]);
      console.log(`BASELINE UPDATED ${combo}`);
      continue;
    }

    if (!existsSync(baseline)) {
      console.error(`FAIL ${combo}: baseline missing (run with --update to approve)`);
      failures += 1;
      continue;
    }
    try {
      execFileSync(
        'python3',
        [path.join(ROOT, 'scripts', 'report-pixel-diff.py'), baseline, current, '--tolerance', '8', '--max', '0.001'],
        { stdio: 'inherit' },
      );
      console.log(`PASS ${combo}`);
    } catch {
      console.error(`FAIL ${combo}: pixels differ from the approved baseline — inspect the diff, then re-approve with --update if the change is intended`);
      failures += 1;
    }
  }

  if (!UPDATE) {
    console.log(
      failures === 0
        ? 'VISUAL REGRESSION PASS — all 6 report pages match the approved baselines'
        : `VISUAL REGRESSION FAIL — ${failures} of ${COMBOS.length} pages drifted`,
    );
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[report-visual] harness error:', err);
  process.exit(1);
});
