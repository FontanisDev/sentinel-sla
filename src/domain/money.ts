// ═══════════════════════════════════════════════════════════════════════════
// Sentinel-SLA domain — money core (pure, no I/O, no db, no HTTP)
//
// Units and rounding policy (normative — full text in docs/DOMAIN.md):
//   • Every monetary amount is an INTEGER number of Iranian Rials (IRR).
//   • No float ever carries money across statements: each public function
//     performs its arithmetic in a single expression (or BigInt) and rounds
//     at most ONCE, at the final step, half-to-even ("banker-neutral").
//   • Percentages are carried as integer basis points (1 bp = 0.01 %) so
//     percentage arithmetic is itself integer-exact.
//   • Safe-integer envelope: every returned amount satisfies
//     Number.isSafeInteger. Inputs outside the envelope throw DomainError
//     instead of silently losing precision.
//   • Toman is a presentation unit: 1 Toman = 10 Rials, exactly.
// ═══════════════════════════════════════════════════════════════════════════

/** Domain rule violation with a human-readable, field-named message. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

/** Integer Rials amount. Runtime guarantee: Number.isSafeInteger ≥ 0. */
export type Rials = number;

/** Integer basis points. 10_000 bp = 100 %, 1 bp = 0.01 %. */
export type Bps = number;

export const BPS_ONE_HUNDRED_PERCENT = 10_000;

/** Throws unless `n` is a safe non-negative integer. */
export function assertMoney(n: number, label: string): void {
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) {
    throw new DomainError(`${label}: expected a safe integer amount of Rials, got ${String(n)}`);
  }
  if (n < 0) {
    throw new DomainError(`${label}: money amounts must be non-negative, got ${n}`);
  }
}

/** Throws unless `n` is a safe integer (sign allowed — used for deltas). */
export function assertSafeInteger(n: number, label: string): void {
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) {
    throw new DomainError(`${label}: expected a safe integer, got ${String(n)}`);
  }
}

/** Sum of integer Rials amounts with overflow guard. */
export function sumRials(...amounts: Rials[]): Rials {
  let acc = 0;
  for (const a of amounts) {
    assertMoney(a, 'sumRials operand');
    acc += a;
    if (!Number.isSafeInteger(acc)) {
      throw new DomainError(`sumRials: intermediate sum ${acc} exceeded the safe-integer envelope`);
    }
  }
  return acc;
}

/**
 * Exact integer division with half-to-even rounding.
 * `num` / `den`, both non-negative safe integers, `den > 0`.
 * The ONLY rounding step in every money formula in this package.
 */
export function divRoundHalfEven(num: number, den: number): number {
  assertSafeInteger(num, 'divRoundHalfEven numerator');
  assertSafeInteger(den, 'divRoundHalfEven denominator');
  if (den <= 0) throw new DomainError(`divRoundHalfEven: denominator must be > 0, got ${den}`);
  const q = Math.floor(num / den);
  const r = num - q * den;
  if (r * 2 < den) return q;
  if (r * 2 > den) return q + 1;
  // exact half — round to even
  return q % 2 === 0 ? q : q + 1;
}

/**
 * `amount × bps / 10_000`, rounded half-to-even once.
 * Result ≤ amount whenever bps ≤ 10_000 (tenant money can only shrink).
 * The intermediate product is computed in BigInt so the safe-integer
 * envelope holds for the RESULT, never silently broken by the product.
 */
export function applyBps(amount: Rials, bps: Bps): Rials {
  assertMoney(amount, 'applyBps amount');
  if (!Number.isSafeInteger(bps) || bps < 0) {
    throw new DomainError(`applyBps: basis points must be a non-negative safe integer, got ${String(bps)}`);
  }
  if (bps > BPS_ONE_HUNDRED_PERCENT) {
    throw new DomainError(`applyBps: bps ${bps} exceeds 100 %; split the formula instead`);
  }
  const product = BigInt(amount) * BigInt(bps); // exact
  const BPS = BigInt(BPS_ONE_HUNDRED_PERCENT);
  const q = product / BPS;
  const r = product % BPS;
  const qn = Number(q);
  const rn = Number(r);
  if (!Number.isSafeInteger(qn)) {
    throw new DomainError(`applyBps: result ${q} Rials exceeds the safe-integer envelope`);
  }
  if (rn * 2 < 10_000) return qn;
  if (rn * 2 > 10_000) return qn + 1;
  return qn % 2 === 0 ? qn : qn + 1;
}

/** Convert a percentage (0..100, ≤ 2 decimal places) to integer basis points. */
export function pctToBps(pct: number): Bps {
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new DomainError(`pctToBps: expected a percentage in [0, 100], got ${String(pct)}`);
  }
  const bps = Math.round(pct * 100);
  if (Math.abs(bps / 100 - pct) > 1e-9) {
    throw new DomainError(`pctToBps: ${pct} has more than 2 decimal places — carry it as basis points instead`);
  }
  return bps;
}

/** Multiply a percentage into an amount (the one-stop percentage helper). */
export function applyPct(amount: Rials, pct: number): Rials {
  return applyBps(amount, pctToBps(pct));
}

/**
 * Presentation conversion. Requires the Rial amount to be a multiple of 10
 * (true for every amount at rest — contracts and fees are authored in Tomans
 * and stored ×10). Computed amounts that are not divisible by 10 are rounded
 * half-to-even; the property "Toman = Rial / 10 exactly" is asserted only for
 * multiples of 10 (see property tests).
 */
export function rialToToman(r: Rials): number {
  assertMoney(r, 'rialToToman');
  return r % 10 === 0 ? r / 10 : divRoundHalfEven(r, 10);
}

/** Authoring conversion: Tomans → Rials (×10, exact). */
export function tomanToRial(t: number): Rials {
  if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < 0) {
    throw new DomainError(`tomanToRial: expected a safe non-negative integer Toman amount, got ${String(t)}`);
  }
  return t * 10;
}

/** Thousands-separated formatting for evidence formula lines. */
export function formatRials(r: Rials): string {
  assertMoney(r, 'formatRials');
  return `${r.toLocaleString('en-US')} IRR`;
}

/**
 * Exact value of `tps × seconds × ticketRials` without float accumulation:
 * tps is carried as fixed-point 1e-6 (micro-tps) inside BigInt, the product is
 * exact in BigInt, then ONE half-to-even rounding back to integer Rials.
 * Fractional tps (e.g. 37.5) and long windows are both exact.
 * `lossBps` (optional, default 10 000 = full loss) is folded into the same
 * BigInt division so partial-loss outages still round at most once.
 */
export function lostValueRials(tps: number, seconds: number, ticketRials: Rials, lossBps = BPS_ONE_HUNDRED_PERCENT): Rials {
  if (typeof tps !== 'number' || !Number.isFinite(tps) || tps < 0 || tps > 1_000_000) {
    throw new DomainError(`lostValueRials: tps must be a finite number in [0, 1e6], got ${String(tps)}`);
  }
  assertSafeInteger(seconds, 'lostValueRials seconds');
  if (seconds < 0) throw new DomainError(`lostValueRials: seconds must be ≥ 0, got ${seconds}`);
  assertMoney(ticketRials, 'lostValueRials ticketRials');
  if (!Number.isSafeInteger(lossBps) || lossBps < 0 || lossBps > BPS_ONE_HUNDRED_PERCENT) {
    throw new DomainError(`lostValueRials: lossBps must be an integer in [0, 10000], got ${String(lossBps)}`);
  }
  const microTps = BigInt(Math.round(tps * 1_000_000));
  // numerator unit: rials × 1e6 × 1e4 ; denominator: 1e6 × 1e4
  const product = microTps * BigInt(seconds) * BigInt(ticketRials) * BigInt(lossBps);
  const DEN = BigInt(1_000_000) * BigInt(BPS_ONE_HUNDRED_PERCENT);
  const q = product / DEN;
  const r = product % DEN;
  const rn = Number(r);
  const qn = Number(q);
  if (!Number.isSafeInteger(qn)) {
    throw new DomainError(`lostValueRials: result ${q} Rials exceeds the safe-integer envelope`);
  }
  if (rn * 2 < Number(DEN)) return qn;
  if (rn * 2 > Number(DEN)) return qn + 1;
  return qn % 2 === 0 ? qn : qn + 1;
}
