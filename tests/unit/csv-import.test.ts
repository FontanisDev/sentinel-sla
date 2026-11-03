// Unit tests for the CSV import core (CSV of contracts and
// services). The parser is characterised against the RFC 4180 writer in
// src/server/export.ts: anything rowsToCsv emits must parse back to the
// same rows (fast-check round-trip), plus hand-picked edge cases — BOM,
// CRLF/LF, quoted commas/quotes/newlines, header aliases, row validation
// errors with field paths, caps.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { rowsToCsv } from '@/server/export';
import {
  IMPORT_MAX_ROWS,
  mapHeaders,
  mapServiceRow,
  parseCsv,
  parseServiceSheet,
} from '@/server/csv-import';

describe('parseCsv — RFC 4180', () => {
  it('parses plain LF rows and keeps a trailing row without newline', () => {
    expect(parseCsv('a,b\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseCsv('a,b\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('accepts CRLF and emits no \\r residue', () => {
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('strips a leading UTF-8 BOM from the first cell', () => {
    expect(parseCsv('\ufeffkey,name\nx,y')[0]).toEqual(['key', 'name']);
  });

  it('honors quoted commas, doubled quotes and embedded newlines', () => {
    const rows = parseCsv('name,note\n"Shaparak, PSP","say ""hi"""\n"line1\nline2",ok');
    expect(rows[1]).toEqual(['Shaparak, PSP', 'say "hi"']);
    expect(rows[2]).toEqual(['line1\nline2', 'ok']);
  });

  it('keeps an empty last field ("a,\n" style rows)', () => {
    expect(parseCsv('a,\nb,c')).toEqual([
      ['a', ''],
      ['b', 'c'],
    ]);
  });

  it('keeps a blank line as an empty row (the sheet layer skips it)', () => {
    expect(parseCsv('a,b\nc,d\n\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      [''],
    ]);
  });

  it('treats a mid-field quote literally (Excel-like, not RFC-strict error)', () => {
    expect(parseCsv('a,b\nabc"def,x')).toEqual([
      ['a', 'b'],
      ['abc"def', 'x'],
    ]);
  });
});

describe('round-trip with rowsToCsv (fast-check)', () => {
  // CSV-safe text: rowsToCsv only escapes what RFC 4180 needs, so any
  // string without NUL round-trips. Keep the alphabet modest but include
  // commas, quotes, spaces, Persian letters and (escaped) newlines.
  const csvText = fc.string({
    minLength: 0,
    maxLength: 24,
  }).filter((s) => !s.includes('\u0000'));

  // rowsToCsv takes rows as OBJECTS keyed by the header names and pads
  // missing keys — a round-trip is only identity for RECTANGULAR grids
  // (every row carrying all four columns), which is what a real sheet is.
  const rowArb = fc.tuple(csvText, csvText, csvText, csvText);
  const sheetArb = fc.array(rowArb, { minLength: 1, maxLength: 8 });

  it('rowsToCsv → parseCsv returns the identical grid', () => {
    const prop = fc.property(sheetArb, (rows) => {
      const csv = rowsToCsv(['c0', 'c1', 'c2', 'c3'], rows.map((r) => ({ c0: r[0], c1: r[1], c2: r[2], c3: r[3] })));
      // The writer always emits a header line — parse and drop it.
      const parsed = parseCsv(csv).slice(1);
      expect(parsed).toEqual(rows);
    });
    expect(fc.assert(prop, { numRuns: 300 })).toBeUndefined();
  });

  it('parseServiceSheet accepts a writer-produced sheet with physical line numbers', () => {
    const prop = fc.property(
      fc.array(rowArb, { minLength: 1, maxLength: 6 }),
      (rows) => {
        // First column is the key (required), second the name (required).
        const body = rows.map((r, i) => [`svc-${i}`, ...r.slice(1, 4)]);
        const csv = rowsToCsv(['key', 'name', 'c2', 'c3'], body.map((r) => ({ key: r[0], name: r[1], c2: r[2], c3: r[3] })));
        const sheet = parseServiceSheet(csv);
        expect(sheet.ok).toBe(true);
        if (sheet.ok) {
          expect(sheet.rows.map((r) => r.fields)).toEqual(body);
          // Physical lines: 1 (header) + 1..n — no embedded newlines here
          // because rowsToCsv quotes them only when present, and the first
          // cell never carries one… but other cells may, so only assert the
          // monotone + >= 2 invariant.
          for (let i = 1; i < sheet.rows.length; i += 1) {
            expect(sheet.rows[i].line).toBeGreaterThanOrEqual(sheet.rows[i - 1].line + 1);
          }
          expect(sheet.rows[0].line).toBeGreaterThanOrEqual(2);
        }
      },
    );
    expect(fc.assert(prop, { numRuns: 200 })).toBeUndefined();
  });
});

describe('mapHeaders — customer-friendly aliases', () => {
  it('matches case, spaces, hyphens and underscores', () => {
    const { index, unknown } = mapHeaders(['Key', 'Service Name', 'name-fa', 'TENANT KEY', 'Penalty Per Minute']);
    expect(index.key).toBe(0);
    expect(index.name).toBe(1);
    expect(index.nameFa).toBe(2);
    expect(index.tenant).toBe(3);
    expect(index.penaltyPerMinute).toBe(4);
    expect(unknown).toEqual([]);
  });

  it('reports unknown columns for the UI hint', () => {
    const { index, unknown } = mapHeaders(['key', 'name', 'notes from vendor']);
    expect(index.key).toBe(0);
    expect(unknown).toEqual(['notes from vendor']);
  });
});

describe('mapServiceRow — validation', () => {
  const idx = mapHeaders(['key', 'name', 'nameFa', 'tenant', 'slaTarget', 'penaltyBase', 'criticality']).index;

  it('accepts a full contract row and coerces numbers', () => {
    const m = mapServiceRow(['psp-gate', 'درگاه پرداخت', 'درگاه شاپرک', 'acme', '0.999', '50000000', 'critical'], idx);
    expect(m.ok).toBe(true);
    if (m.ok) {
      expect(m.row.key).toBe('psp-gate');
      expect(m.row.nameFa).toBe('درگاه شاپرک');
      expect(m.row.slaTarget).toBe(0.999);
      expect(m.row.penaltyBase).toBe(50000000);
      expect(m.row.criticality).toBe('critical');
    }
  });

  it('accepts an identity-only row (all contract terms default downstream)', () => {
    const m = mapServiceRow(['ledger-core', 'Ledger Core'], idx);
    expect(m.ok).toBe(true);
    if (m.ok) {
      expect(m.row.slaTarget).toBeUndefined();
      expect(m.row.tenant).toBeUndefined();
    }
  });

  it('rejects a bad key slug with the field path in the error', () => {
    const m = mapServiceRow(['Bad Key!', 'Name'], idx);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.error).toContain('key');
  });

  it('rejects slaTarget outside (0,1) and unknown criticality', () => {
    const bad = mapServiceRow(['a1', 'Ab', '', '', '1.5'], idx);
    expect(bad.ok).toBe(false);
    const badCrit = mapServiceRow(['a1', 'Ab', '', '', '0.999', '100', 'urgent'], idx);
    expect(badCrit.ok).toBe(false);
    if (!badCrit.ok) expect(badCrit.error).toContain('criticality');
  });

  it('flags a fully empty (comma-only) row as empty', () => {
    const m = mapServiceRow(['', '', '', '', '', '', ''], idx);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.error).toBe('empty row');
  });
});

describe('parseServiceSheet — whole-sheet rules', () => {
  const HEADER = 'key,name,nameFa,tenant,slaTarget,penaltyBase,penaltyPerMinute,criticality\n';

  it('parses a two-row sheet with physical line numbers starting at 2', () => {
    const sheet = parseServiceSheet(HEADER + 'psp-gate,درگاه پرداخت,,,0.999,50000000,7500000,critical\nwallet,کیف پول,,,0.995,20000000,3000000,high\n');
    expect(sheet.ok).toBe(true);
    if (sheet.ok) {
      expect(sheet.rows.map((r) => r.line)).toEqual([2, 3]);
      expect(sheet.unknownColumns).toEqual([]);
    }
  });

  it('fails without key/name headers and names the problem', () => {
    const r = parseServiceSheet('a,b\n1,2\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("'key' and 'name'");
  });

  it('fails on an empty file, header-only file and blank-line-only data', () => {
    expect(parseServiceSheet('').ok).toBe(false);
    expect(parseServiceSheet(HEADER).ok).toBe(false);
    expect(parseServiceSheet(`${HEADER}\n\n`).ok).toBe(false);
  });

  it('skips blank lines inside the sheet but keeps physical line numbers', () => {
    const sheet = parseServiceSheet(`${HEADER}a-one,A\n\nb-two,B\n`);
    expect(sheet.ok).toBe(true);
    if (sheet.ok) {
      expect(sheet.rows.map((r) => r.fields[0])).toEqual(['a-one', 'b-two']);
      expect(sheet.rows[1].line).toBe(4); // line 3 was blank
    }
  });

  it('keeps quoted newlines inside a field and advances physical lines', () => {
    const sheet = parseServiceSheet(`${HEADER}"multi\nline",N\nb-two,B\n`);
    expect(sheet.ok).toBe(true);
    if (sheet.ok) {
      expect(sheet.rows[0].fields[0]).toBe('multi\nline');
      expect(sheet.rows[0].line).toBe(2);
      expect(sheet.rows[1].line).toBe(4);
    }
  });

  it('rejects sheets beyond the 200-row cap', () => {
    const many = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `svc-${i},S${i}`).join('\n');
    const r = parseServiceSheet(HEADER + many + '\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('limit');
  });
});
