// Sentinel-SLA — CSV import of contracts and services (customer
// onboarding: "data import (CSV of contracts and services)").
//
// One CSV row = one monitored service WITH its SLA contract terms (target,
// penalty base, penalty per minute, tier) — the exact fields the onboarding
// wizard and POST /api/services accept. A contract in Sentinel lives on the
// service, so a services+contracts sheet is one flat table.
//
// The parser mirrors src/server/export.ts rowsToCsv() so an exported sheet
// round-trips: RFC 4180 quoting (double quotes, "" escapes, commas and line
// breaks inside quoted fields), CRLF or LF rows, optional UTF-8 BOM (Excel
// Persian names survive) and keeps blank lines as empty rows (the sheet
// layer — parseServiceSheet — is what skips them).
//
// Everything here is PURE: no db, no engine, no clock. The route composes
// these helpers with tenant resolution, authz and the transaction — and a
// dry-run is literally the same pipeline with the write step removed.

import { z } from 'zod';
import { createServiceSchema } from '@/server/validation';

/** Import caps (DoS guard; also keeps the per-row report readable). */
export const IMPORT_MAX_ROWS = 200;
export const IMPORT_MAX_BYTES = 512 * 1024;

/** Physical CSV line number of the first data row (row 1 is the header). */
export const IMPORT_FIRST_DATA_LINE = 2;

// ── RFC 4180 parser ──────────────────────────────────────────────────────

/**
 * Parse CSV text into rows of fields. Accepts CRLF and LF, strips a leading
 * UTF-8 BOM, honors RFC 4180 quoting (`"a, b"`, `"say ""hi"""`, quotes with
 * embedded line breaks) and skips empty trailing lines. A row with fewer
 * fields than the header yields `undefined` entries (mapped to '' by the
 * row mapper); extra fields are kept (the mapper ignores unknown columns
 * but the header check decides what "unknown" means).
 */
export function parseCsv(input: string): string[][] {
  let text = input;
  if (text.startsWith('\ufeff')) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  let fieldWasQuoted = false;

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === '' && !fieldWasQuoted) {
      inQuotes = true;
      fieldWasQuoted = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      fieldWasQuoted = false;
      i += 1;
      continue;
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldWasQuoted = false;
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  // Last field/row without a trailing newline (only when non-empty).
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ── Header handling ──────────────────────────────────────────────────────

/** Canonical column names (lowercase) → accepted aliases. */
const HEADER_ALIASES: Record<string, string> = {
  key: 'key',
  service: 'key',
  slug: 'key',
  name: 'name',
  servicename: 'name',
  'name-fa': 'nameFa',
  namefa: 'nameFa',
  'persian-name': 'nameFa',
  tenant: 'tenant',
  tenantkey: 'tenant',
  client: 'tenant',
  tier: 'tier',
  endpoint: 'endpoint',
  url: 'endpoint',
  baselatencyms: 'baseLatencyMs',
  latency: 'baseLatencyMs',
  tps: 'tps',
  throughput: 'tps',
  avgtransactionvalue: 'avgTransactionValue',
  ticket: 'avgTransactionValue',
  slatarget: 'slaTarget',
  target: 'slaTarget',
  penaltybase: 'penaltyBase',
  'penalty-base': 'penaltyBase',
  penaltyperminute: 'penaltyPerMinute',
  'penalty-per-minute': 'penaltyPerMinute',
  criticality: 'criticality',
  severity: 'criticality',
};

/**
 * Map a header row to canonical field indexes. Returns the map plus the
 * unknown column names so the route can decide strictness. Matching is
 * case-insensitive; `-`/`_`/spaces are ignored (Name-FA, name_fa, NAME FA
 * all work — sheets come from customers, not compilers).
 */
export function mapHeaders(
  headerRow: string[],
): { index: Record<string, number>; unknown: string[] } {
  const index: Record<string, number> = {};
  const unknown: string[] = [];
  headerRow.forEach((raw, i) => {
    const norm = raw
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '');
    const canonical = HEADER_ALIASES[norm];
    if (canonical) {
      if (!(canonical in index)) index[canonical] = i; // first occurrence wins
    } else {
      unknown.push(raw.trim());
    }
  });
  return { index, unknown };
}

// ── Row schema ───────────────────────────────────────────────────────────

/**
 * One CSV data row. Reuses createServiceSchema's field rules (the import
 * must accept exactly what the wizard accepts — one validation truth) minus
 * probeSource (JSON config is out of CSV scope; the wizard owns probes) and
 * tenantId (the CSV has a `tenant` column holding key OR id, resolved by
 * the route). Numbers arrive as strings and are coerced here.
 */
export const csvRowSchema = z.object({
  key: createServiceSchema.shape.key,
  name: createServiceSchema.shape.name,
  nameFa: createServiceSchema.shape.nameFa,
  tenant: z.string().trim().max(64).optional(),
  tier: createServiceSchema.shape.tier,
  endpoint: createServiceSchema.shape.endpoint,
  baseLatencyMs: z.coerce.number().positive().max(10000).optional(),
  tps: z.coerce.number().positive().max(100000).optional(),
  avgTransactionValue: z.coerce.number().positive().max(1e12).optional(),
  slaTarget: z.coerce.number().gt(0).lt(1).optional(),
  penaltyBase: z.coerce.number().positive().max(1e13).optional(),
  penaltyPerMinute: z.coerce.number().positive().max(1e12).optional(),
  criticality: createServiceSchema.shape.criticality,
});

export type CsvRow = z.infer<typeof csvRowSchema>;

export type MappedRow =
  | { ok: true; row: CsvRow }
  | { ok: false; error: string };

/** Blank/placeholder cell → undefined so zod `.optional()` semantics hold. */
function cell(fields: string[], idx: number | undefined): string | undefined {
  if (idx === undefined) return undefined;
  const v = (fields[idx] ?? '').trim();
  return v === '' ? undefined : v;
}

/**
 * Convert one CSV data row (raw strings) into a validated CsvRow using the
 * header index map. Returns ok:false with a human-readable error (field
 * path + zod message) so the per-row report tells the operator exactly
 * which cell to fix.
 */
export function mapServiceRow(fields: string[], index: Record<string, number>): MappedRow {
  const raw = {
    key: cell(fields, index.key),
    name: cell(fields, index.name),
    nameFa: cell(fields, index.nameFa),
    tenant: cell(fields, index.tenant),
    tier: cell(fields, index.tier),
    endpoint: cell(fields, index.endpoint),
    baseLatencyMs: cell(fields, index.baseLatencyMs),
    tps: cell(fields, index.tps),
    avgTransactionValue: cell(fields, index.avgTransactionValue),
    slaTarget: cell(fields, index.slaTarget),
    penaltyBase: cell(fields, index.penaltyBase),
    penaltyPerMinute: cell(fields, index.penaltyPerMinute),
    criticality: cell(fields, index.criticality),
  };
  // A completely empty line is skipped by the caller, but a row of commas
  // (`,,,`) still lands here — treat rows with no key AND no name as empty.
  if (!raw.key && !raw.name && !raw.tenant && !raw.endpoint) {
    return { ok: false, error: 'empty row' };
  }
  const parsed = csvRowSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.map(String).join('.') || '(row)';
    return { ok: false, error: `${path}: ${issue.message}` };
  }
  return { ok: true, row: parsed.data };
}

// ── Full-sheet parse (header + data rows, physical line numbers) ─────────

export interface SheetRow {
  /** Physical 1-based CSV line number (header = 1; first data row = 2). */
  line: number;
  /** Raw fields (post RFC 4180 unquoting). */
  fields: string[];
}

export type SheetParseResult =
  | { ok: true; headerIndex: Record<string, number>; unknownColumns: string[]; rows: SheetRow[] }
  | { ok: false; error: string };

/**
 * Parse a whole CSV sheet: BOM, header aliases, data rows with physical
 * line numbers (quoted line breaks make physical lines ≠ logical rows —
 * the report uses physical lines so operators can find the cell in their
 * editor). Fully blank lines (all cells empty) are skipped silently.
 */
export function parseServiceSheet(text: string): SheetParseResult {
  if (text.length > IMPORT_MAX_BYTES) {
    return { ok: false, error: `CSV exceeds ${IMPORT_MAX_BYTES} bytes` };
  }
  const all = parseCsv(text);
  if (all.length === 0) return { ok: false, error: 'CSV is empty' };

  const header = all[0];
  // Strip a UTF-8 BOM that survived in the first header cell (some tools
  // quote the header row as a whole).
  header[0] = header[0].replace(/^\ufeff/, '').trim();
  if (header.every((h) => h.trim() === '')) {
    return { ok: false, error: 'CSV header row is missing' };
  }
  const { index, unknown } = mapHeaders(header);
  if (!('key' in index) || !('name' in index)) {
    return {
      ok: false,
      error: `CSV header must contain at least 'key' and 'name' columns (got: ${header
        .map((h) => h.trim())
        .filter(Boolean)
        .join(', ') || 'none'})`,
    };
  }

  const rows: SheetRow[] = [];
  // Physical line accounting: each logical row consumes the lines its text
  // spanned (embedded line breaks inside quoted fields).
  let line = 1;
  for (let r = 1; r < all.length; r += 1) {
    const fields = all[r];
    const newlines = fields.reduce(
      (acc, f) => acc + (f.match(/\r\n|\n|\r/g)?.length ?? 0),
      0,
    );
    line += 1;
    const thisLine = line;
    line += newlines;
    if (fields.every((f) => f.trim() === '')) continue; // blank line
    rows.push({ line: thisLine, fields });
  }
  if (rows.length === 0) {
    return { ok: false, error: 'CSV has a header but no data rows' };
  }
  if (rows.length > IMPORT_MAX_ROWS) {
    return { ok: false, error: `CSV has ${rows.length} data rows; the limit is ${IMPORT_MAX_ROWS}` };
  }
  return { ok: true, headerIndex: index, unknownColumns: unknown, rows };
}
