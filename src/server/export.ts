// Sentinel-SLA — v2.1 data-export helpers (CSV / JSON download responses).
//
// CSV follows RFC 4180: CRLF line endings, fields containing commas, double
// quotes or line breaks are wrapped in double quotes with inner quotes
// doubled; nulls render as empty fields. The body is UTF-8 with a BOM so
// Excel detects the encoding (Persian service names survive round-trips).
//
// Security headers (OWASP ASVS L1) are applied globally by next.config.ts for
// "/(.*)" — the helpers below only set Content-Type / Content-Disposition and
// never override them.

import { NextResponse } from 'next/server';

const UTF8_BOM = '\ufeff';
const CRLF = '\r\n';

/** Quote a single CSV field per RFC 4180 (null/undefined → empty field). */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (typeof value === 'number') {
    s = Number.isFinite(value) ? String(value) : '';
  } else if (typeof value === 'boolean') {
    s = value ? 'true' : 'false';
  } else {
    s = String(value);
  }
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Serialize rows to RFC 4180 CSV with an exact header row (`headers` must be
 * the field names of the row objects, in order). Generic over the row shape:
 * missing keys render as empty fields.
 */
export function rowsToCsv<T>(headers: string[], rows: T[]): string {
  const lines: string[] = [headers.map(csvField).join(',')];
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    lines.push(headers.map((h) => csvField(record[h])).join(','));
  }
  return lines.join(CRLF) + CRLF;
}

/** File-stamp for export filenames: `YYYYMMDD-HHmmss` (UTC, deterministic). */
export function exportTimestamp(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

/** CSV download response (UTF-8 with BOM, attachment disposition). */
export function csvAttachment<T>(
  headers: string[],
  rows: T[],
  filename: string,
): NextResponse {
  const body = UTF8_BOM + rowsToCsv(headers, rows);
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

/** JSON download response (bare payload, attachment disposition). */
export function jsonAttachment(data: unknown, filename: string): NextResponse {
  const body = JSON.stringify(data, null, 2);
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
