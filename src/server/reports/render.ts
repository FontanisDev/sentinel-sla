// Sentinel-SLA — HTML → PDF bridge.
//
// Invokes reports/render_weasy.py (WeasyPrint, Pango shapes Persian
// correctly) as a subprocess with the project root as base_url so the
// bundled public/fonts woff2 files resolve through relative @font-face
// URLs — portable, offline-first, no system font installation.

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { getConfig } from '@/server/config';
import { HttpError } from '@/server/http';

/** Render a complete report HTML document to a PDF file. */
export async function renderHtmlToPdf(html: string, outPath: string): Promise<void> {
  const config = getConfig();
  if (!config.reportPython) {
    throw new HttpError(
      503,
      'PDF rendering is not configured: set REPORT_PYTHON to a python3 interpreter with '
        + 'weasyprint installed (legacy alias PYTHON_BIN is still honored).',
    );
  }

  const htmlPath = outPath.replace(/\.pdf$/, '.html');
  await fs.writeFile(htmlPath, html, 'utf-8');
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        config.reportPython as string,
        [config.reportWeasyScript, htmlPath, outPath, config.projectRoot],
        { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
        (err, _stdout, stderr) => {
          if (err) {
            const tail = stderr ? String(stderr).slice(-400) : err.message;
            reject(new HttpError(500, `PDF rendering failed: ${tail}`));
          } else {
            resolve();
          }
        },
      );
    });
  } finally {
    await fs.rm(htmlPath, { force: true }).catch(() => undefined);
  }
}

/** Timestamped output file name per report kind. */
export function reportFileName(kind: string, generatedAt: Date): string {
  const stamp = generatedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // executive keeps the legacy sentinel-sla-report- prefix (the executive
  // digest PDF attachment looks up the newest sentinel-sla-report-*.pdf)
  const prefix = kind === 'executive' ? 'sentinel-sla-report' : `sentinel-${kind}-report`;
  return `${prefix}-${stamp}.pdf`;
}
