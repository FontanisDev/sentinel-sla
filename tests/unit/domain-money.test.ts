// Domain unit tests — money core (integer Rials, half-even, bps).
// These are behavioural, not characterisation: they pin the POLICY of the new
// domain layer (docs/DOMAIN.md), not the v1.5 float-Tomans behaviour.

import { describe, expect, it } from 'vitest';
import {
  DomainError,
  applyBps,
  applyPct,
  assertMoney,
  divRoundHalfEven,
  formatRials,
  lostValueRials,
  pctToBps,
  rialToToman,
  sumRials,
  tomanToRial,
} from '@/domain/money';

describe('divRoundHalfEven', () => {
  it('rounds exact halves to even', () => {
    expect(divRoundHalfEven(5, 2)).toBe(2); // 2.5 → 2 (even)
    expect(divRoundHalfEven(15, 2)).toBe(8); // 7.5 → 8 (even)
    expect(divRoundHalfEven(25, 2)).toBe(12); // 12.5 → 12 (even)
    expect(divRoundHalfEven(35, 2)).toBe(18); // 17.5 → 18 (even)
  });
  it('rounds non-halves to nearest', () => {
    expect(divRoundHalfEven(7, 2)).toBe(4); // 3.5? no — 7/2=3.5 → 4 (even)
    expect(divRoundHalfEven(10, 3)).toBe(3); // 3.33 → 3
    expect(divRoundHalfEven(11, 3)).toBe(4); // 3.67 → 4
    expect(divRoundHalfEven(1, 3)).toBe(0);
    expect(divRoundHalfEven(2, 3)).toBe(1);
  });
  it('is exact when divisible', () => {
    expect(divRoundHalfEven(9, 3)).toBe(3);
    expect(divRoundHalfEven(0, 7)).toBe(0);
  });
  it('rejects zero/negative denominators and float inputs', () => {
    expect(() => divRoundHalfEven(1, 0)).toThrow(DomainError);
    expect(() => divRoundHalfEven(1, -2)).toThrow(DomainError);
    expect(() => divRoundHalfEven(1.5, 2)).toThrow(DomainError);
  });
});

describe('applyBps / applyPct', () => {
  it('applies 100 % unchanged', () => {
    expect(applyBps(12345, 10_000)).toBe(12345);
  });
  it('applies fractions with one final half-even rounding', () => {
    expect(applyBps(5, 5000)).toBe(2); // 2.5 → 2
    expect(applyBps(15, 5000)).toBe(8); // 7.5 → 8
    expect(applyBps(36_000_000_000, 3250)).toBe(11_700_000_000); // 32.5 %
  });
  it('rounds half-even, so it can reach the amount itself but never exceed it', () => {
    expect(applyBps(100, 9999)).toBe(100); // 99.99 → 100 (≤ amount ✓)
    expect(applyBps(10_000, 9999)).toBe(9_999); // exact
  });
  it('rejects >100 % and negative bps', () => {
    expect(() => applyBps(100, 10_001)).toThrow(DomainError);
    expect(() => applyBps(100, -1)).toThrow(DomainError);
  });
  it('applyPct maps percentage → bps', () => {
    expect(applyPct(200, 32.5)).toBe(65);
    expect(applyPct(1_000_000, 0.01)).toBe(100);
  });
});

describe('pctToBps', () => {
  it('converts with 2-decimal precision', () => {
    expect(pctToBps(100)).toBe(10_000);
    expect(pctToBps(99.9)).toBe(9990);
    expect(pctToBps(0.01)).toBe(1);
  });
  it('rejects out-of-range or over-precise values', () => {
    expect(() => pctToBps(101)).toThrow(DomainError);
    expect(() => pctToBps(-0.1)).toThrow(DomainError);
    expect(() => pctToBps(33.333)).toThrow(DomainError);
    expect(() => pctToBps(Number.NaN)).toThrow(DomainError);
  });
});

describe('sumRials / assertions / formatting', () => {
  it('sums integers and guards overflow', () => {
    expect(sumRials(1, 2, 3)).toBe(6);
    expect(() => sumRials(1.5 as 1, 2)).toThrow(DomainError);
    expect(() => sumRials(-1 as 1, 5)).toThrow(DomainError);
    expect(() => sumRials(Number.MAX_SAFE_INTEGER, 1)).toThrow(/safe-integer envelope/);
  });
  it('assertMoney rejects floats and negatives', () => {
    expect(() => assertMoney(0.1, 'x')).toThrow(DomainError);
    expect(() => assertMoney(-5, 'x')).toThrow(DomainError);
    expect(() => assertMoney(Number.MAX_SAFE_INTEGER + 1, 'x')).toThrow(DomainError);
  });
  it('formats with thousands separators', () => {
    expect(formatRials(1_234_567)).toBe('1,234,567 IRR');
  });
});

describe('Toman ⇄ Rial', () => {
  it('1 Toman = 10 Rials exactly', () => {
    expect(tomanToRial(25_000)).toBe(250_000);
    expect(rialToToman(250_000)).toBe(25_000);
    expect(rialToToman(tomanToRial(9_999_999))).toBe(9_999_999);
  });
  it('non-multiples of 10 round half-even at presentation', () => {
    expect(rialToToman(25)).toBe(2); // 2.5 → 2
    expect(rialToToman(35)).toBe(4); // 3.5 → 4
  });
  it('rejects float Tomans', () => {
    expect(() => tomanToRial(1.5)).toThrow(DomainError);
  });
});

describe('lostValueRials (BigInt-exact tps × seconds × ticket)', () => {
  it('integer tps is exact', () => {
    expect(lostValueRials(40, 3600, 250_000)).toBe(36_000_000_000);
  });
  it('fractional tps rounds half-even once', () => {
    // 0.5 tps × 3 s × 5 IRR = 7.5 → 8 (even)
    expect(lostValueRials(0.5, 3, 5)).toBe(8);
    // 0.5 tps × 1 s × 5 IRR = 2.5 → 2 (even)
    expect(lostValueRials(0.5, 1, 5)).toBe(2);
  });
  it('large products stay exact (BigInt core)', () => {
    // 1000 tps × 86 400 s × 10^9 IRR = 8.64e19 — beyond 2^53 handled in BigInt…
    // but the result must stay inside the safe envelope for the return type.
    expect(() => lostValueRials(1000, 86_400, 1_000_000_000)).toThrow(/safe-integer envelope/);
  });
  it('rejects invalid inputs', () => {
    expect(() => lostValueRials(-1, 10, 100)).toThrow(DomainError);
    expect(() => lostValueRials(10, -1, 100)).toThrow(DomainError);
    expect(() => lostValueRials(Number.NaN, 10, 100)).toThrow(DomainError);
    expect(() => lostValueRials(10, 1.5, 100)).toThrow(DomainError);
    expect(() => lostValueRials(10, 10, 100.5)).toThrow(DomainError);
  });
});
