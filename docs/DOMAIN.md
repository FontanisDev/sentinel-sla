# DOMAIN — Money, Contracts & Availability 

> This document is the single source of truth for every financial number
> Sentinel-SLA v2.0.0 produces. The pure implementation lives in `src/domain/`
> (no database, no HTTP, no clock). A reader can reproduce any
> number below **by hand**; the machine-checkable forms of the same scenarios
> live in `tests/golden/*.json` and are asserted on every test run.

---

## 1. Units and rounding policy

1. **Money is an integer number of Iranian Rials (IRR).** No float ever stores
   or carries money. Toman is a presentation unit only: `1 Toman = 10 Rials`,
   exactly. Contracts and fees are authored in Tomans and stored as Rials ×10.
2. **Percentages are integer basis points internally** (1 bp = 0.01 %). A
   percentage value with more than two decimal places is rejected at the
   boundary — carry it in basis points instead.
3. **Banker-neutral rounding at the final step only.** Every formula rounds at
   most once, half-to-even (`2.5 → 2`, `7.5 → 8`), implemented exactly in
   integer/BigInt arithmetic (`divRoundHalfEven`, `applyBps`,
   `lostValueRials`). Long sums are sums of already-rounded integers — the
   sum itself is exact, so no rounding can accumulate.
4. **Safe-integer envelope.** Every returned amount satisfies
   `Number.isSafeInteger` (±9 007 199 254 740 991). Inputs whose *result*
   would leave the envelope throw a named `DomainError` instead of silently
   losing precision. Intermediate products never constrain the envelope —
   they are computed in BigInt.
5. **Order of operations** (each step is an evidence line, each line rounds
   once):
   ```
   gross      = tps × seconds × avgTicket (exact, BigInt, one rounding)
   attributed = gross × failureAttribution%
   credit     = attributed × recoveryFactor%
   net        = attributed − credit
   final      = net × grossMarginOrFee%      ← shown to executives
   ```
6. **Basis labelling.** `basis: 'revenue'` shows the lost revenue value of the
   transactions; `basis: 'fee'` shows the lost fee/commission. The UI and the
   PDF always print which basis a number uses. `grossMarginOrFeePct`
   expresses that share (default 100 % = the full transaction value).

## 2. Money model (per service, versioned)

| Field | Meaning | Default |
|---|---|---|
| `avgTicketRials` | average value of one transaction, integer Rials | — |
| `txPerSecond` | transaction-rate source: `static`, `hourOfWeekProfile` (168 buckets, timezone-aware; Tehran = UTC+03:30, i.e. +210 min) or `promql` (resolved via injected query, with optional offline `fallbackTps`) | — |
| `failureAttributionPct` | share of outage minutes that truly lose transactions | 100 % |
| `recoveryFactorPct` | share of failed transactions customers retry successfully later | 0 % |
| `basis` | `revenue` or `fee` — what the money represents | `revenue` |
| `grossMarginOrFeePct` | margin/fee share applied to the net number | 100 % |
| `version` / `effectiveFrom` | amendment creates a new version; old incidents keep the version they were computed with | — |

The tps of a merged outage segment is resolved **at the segment start**
instant. For a static source this is trivially uniform; for a profile source
the bucket of the start instant is used for the whole segment (documented
approximation, visible in the evidence line).

### 2.1 Transaction profile — Shaparak/PSP hourly counts (live money)

The live money path (`resolveLiveIncident`) resolves the service tps at the
incident start instant through `resolveServiceTps`: with no profile stored it
uses the service's flat `tps` column; with a profile it uses the wall-clock
hour-of-week bucket (Tehran, UTC+03:30, no DST since 2022) of the incident
start. The profile is produced by the Shaparak/PSP import:
hourly transaction counts are parsed from CSV (Persian or English headers,
Jalali or Gregorian dates, Latin/Persian/Arabic-Indic digits) and aggregated
per bucket as the **mean count of that hour across the report ÷ 3600** —
one half-even-free division, no float accumulation on money (the tps is an
input, not a money figure). Buckets with no samples stay 0 and are reported
honestly via `coveredBuckets` (the UI shows the coverage percentage; it
never fills gaps by guessing). Commit is all-or-nothing: any rejected CSV
row aborts the import, so money inputs are never silently partial. The
resolution (source, bucket, value, or a corrupt-profile fallback to flat)
is recorded in the incident's resolution event — a corrupt profile degrades
visibly, never silently. The demo engine keeps its flat rate; the profile
drives live money only.

## 3. Contract model (per client/service, versioned)

| Field | Meaning |
|---|---|
| `targetAvailabilityPct` | promised availability, e.g. 99.9 |
| `windowKind` | `jalali-month` or `gregorian-month`; the caller supplies concrete window bounds |
| `minChargeableOutageSec` | outages shorter than this never count (per merged segment) |
| `penalty` | either `tiers` (percentage of the monthly fee per breach band) or `fixedPerMinute` (base + per-minute) |
| `monthlyFeeRials` | the fee the tiers multiply |
| `penaltyCapRials` | hard ceiling applied at the very end; `null` = uncapped |
| `graceMinutes` | downtime forgiven **once per window** (never per outage, never below zero) |
| `excludePlanned` / `excludeExternal` | when `true`, planned / external-cause outages are excluded from the contractual metric |

**Tier selection.** Tiers are evaluated ascending; the *deepest* band still
above the achieved availability wins: availability 99.4 % breaches both
"below 99.9 → 5 %" and "below 99.5 → 15 %", so the 15 % tier applies.

**Fixed + per-minute.** Minutes are `ceil(seconds / 60)` with a 1-minute
minimum (`0 s` bills one minute) — the same rule the v1.5 engine used.
A per-incident `weightPct` scales the total (warning severity = 30 %).

## 4. Availability math

1. Clip every outage to the window, then **merge overlaps** with the winner
   rule below.
2. **Overlap winner — the category that counts against the provider wins:**
   `chargeable > external > planned`. A provider may not launder a genuine
   outage by parking a maintenance window or an "external cause" claim on top
   of it. When the two non-chargeable categories overlap, the label `external`
   wins (more specific cause) — money-wise they are equivalent once their
   exclusion flags apply. A contract flag that is `false` turns that category
   *into* chargeable before merging.
3. **Naive availability** counts *every* outage second (no exclusions, no
   minimum-duration filter, no grace): `1 − downSec/windowSec`.
4. **Contractual availability** counts only effective-chargeable seconds that
   survive the minimum-duration filter, minus the grace allowance:
   `1 − (chargeableSec − graceSec)/windowSec`.
5. **Difference** = contractual − naive ≥ 0: exactly what the exclusions,
   filters and grace bought the provider. Both numbers and their difference
   are always reported.

## 5. Evidence

Every evaluation produces an `Evidence` object: contract version, money-model
version, window, and ordered formula lines with the concrete inputs and
results of every step (including the cap line when a cap binds). The
`FormulaPopover` in the UI and the executive PDF print these lines verbatim —
no number reaches an executive without a formula behind it.

## 6. Golden scenarios (hand-verifiable)

Each scenario below is machine-checked against `tests/golden/<id>.json`.
Window for g01–g11, g13–g18 = 30 days = 2 592 000 s; monthly fee
1 000 000 000 IRR unless stated; money model: static 40 tx/s, ticket
2 500 000 IRR (250 000 Tomans) unless stated; contract: target 99.9 %, tiers
below 99.9 → 5 %, below 99.5 → 15 %, below 99.0 → 30 %, planned/external
excluded, no grace, no cap, no minimum.

### g01-tier-basic — one chargeable hour breaches the promise
A service promised 99.9 % uptime is down for exactly 1 hour inside a 30-day
month. Availability = 1 − 3600/2 592 000 = 99.8611 %, below the 99.9 %
promise, so the 5 % tier applies: 5 % of the 1 000 000 000 IRR monthly fee =
50 000 000 IRR. No exclusions or grace apply. Lost-transaction value:
40 × 3600 × 2 500 000 = 360 000 000 000 IRR.

### g02-fixed-per-minute — base + per-minute billing
A contract without tiers charges 50 000 000 IRR base plus 7 500 000 IRR per
charged minute. A 10-minute outage bills 50 000 000 + 10 × 7 500 000 =
125 000 000 IRR.

### g03-grace — grace is subtracted once per window
The contract forgives the first 15 minutes of downtime per month. A 20-minute
outage is charged only for the remaining 5 minutes: 10 000 000 base +
5 × 1 000 000 = 15 000 000 IRR. Grace is never per outage and never pushes
downtime below zero.

### g04-min-duration — short blips never count (but the naive metric sees them)
The contract ignores outages shorter than 60 seconds. Three outages
(2400 s, 30 s, 6000 s) count as 2400 + 6000 = 8400 chargeable seconds;
availability 99.6759 % breaches 99.9 % but not 99.5 % → the 5 % tier applies
= 50 000 000 IRR. The NAIVE metric still counts the 30-second blip
(99.6748 %) — the 0.0012 % difference is exactly what the minimum-duration
rule bought the provider.

### g05-merge-winner — maintenance cannot hide an outage
A planned maintenance window (10:30–12:00) overlaps a real outage
(10:00–11:00). The provider may not launder a genuine outage behind
maintenance: the overlap 10:30–11:00 stays chargeable. Chargeable = 3600 s,
planned = 3600 s. Contractual availability 99.8611 % (naive 99.7222 %,
difference 0.1389 %) → 5 % tier = 50 000 000 IRR.

### g06-external-not-excluded — upstream failures are chargeable by default
The contract does not exclude external causes, so a 2-hour upstream failure
counts like any other outage: availability 99.7222 % → 5 % tier =
50 000 000 IRR.

### g07-external-excluded — the same failure, excluded
Same 30-minute upstream failure, but this contract excludes external causes.
Nothing is chargeable: contractual availability 100 %, no tier hit, penalty
0. The naive metric still shows 99.9306 %.

### g08-recovery — successful retries are credited
1 hour down at 40 tx/s with a 2 500 000 IRR ticket loses 144 000 transactions
worth 360 000 000 000 IRR gross. The model credits 20 % successful retries
(72 000 000 000 IRR), so the net lost money shown to the executive is
288 000 000 000 IRR.

### g09-attribution — only part of the outage loses transactions
The money model says 60 % of outage minutes actually lose transactions (the
rest is read-only traffic). Gross 360 000 000 000 IRR × 60 % =
216 000 000 000 IRR attributed, net and final the same.

### g10-margin-fee-basis — the fee/commission view
The tenant earns a commission, not the full transaction value: gross
360 000 000 000 IRR × 25 % margin = 90 000 000 000 IRR final loss, labelled
"fee basis" in the UI and PDF.

### g11-cap — the cap wins over the formula
A 2 000 000 000 IRR fee with the 5 % tier would cost 100 000 000 IRR, but the
contract caps the penalty at 50 000 000 IRR — the payable number is the cap.

### g12-hour-of-week — traffic profiles drive the money
The money model follows a weekly traffic profile in Tehran time. The outage
starts Saturday 22:30 UTC = Sunday 02:00 Tehran, which sits in the 40 tx/s
bucket. The resolver takes the tps at the segment start, so the whole 2-hour
outage is valued at 40 tx/s: 7200 s × 40 × 2 500 000 IRR =
720 000 000 000 IRR gross; availability 99.7222 % → 5 % tier = 50 000 000 IRR.

### g13-warning-weight — warnings bill 30 %
A degraded (warning-severity) incident of 10 minutes under a base 0 +
1 000 000 IRR/min scheme would be 10 000 000 IRR when critical; warnings bill
30 %: 3 000 000 IRR. The engine passes the 30 % weight per incident; the
domain applies one half-even rounding.

### g14-degraded-money — partial loss depth
A degraded hour keeps 67.5 % of throughput, so the transaction loss depth is
32.5 %. Money: 360 000 000 000 × 32.5 % = 117 000 000 000 IRR. Availability
still counts the full hour: 99.8611 % → 5 % tier = 50 000 000 IRR penalty.

### g15-touching-merge — consecutive outages are one outage
Two consecutive one-minute outages (10:00:00–10:01:00 and
10:01:00–10:02:00) are one 120-second outage for availability: 99.9954 % —
still above the 99.9 % promise, so no penalty.

### g16-half-even-down — banker-neutral rounding, down
A tiny 1-second outage at 1 tx/s with a 5 IRR ticket loses 5 IRR. Attribution
50 % gives 2.5 IRR; half-to-even rounds to 2 (2 is even). One rounding, at
the final step.

### g17-half-even-up — banker-neutral rounding, up
Same tiny outage with a 15 IRR ticket: 50 % attribution gives 7.5 IRR;
half-to-even rounds to 8 (8 is even). The even rule keeps long sums unbiased.

### g18-full-chain — every knob at once
Gross 360 000 000 000 → attribution 60 % = 216 000 000 000 → recovery credit
20 % = 43 200 000 000 → net 172 800 000 000 → margin 25 % =
43 200 000 000 IRR final (fee basis). Every step is a separate evidence line;
each line rounds at most once.

## 7. Property invariants (fast-check, run on every `bun run check`)

1. Overlap merging never exceeds the window length; merged output is sorted,
   non-overlapping and minimal; merging is idempotent and order-independent
   (coverage-preserving).
2. Availability ∈ [0, 1]; contractual ≥ naive always.
3. Adding excluded maintenance never increases the penalty.
4. The penalty never exceeds its cap.
5. Money is monotonic in outage duration (longer outage → availability not
   higher, penalty and lost money not lower).
6. Toman = Rial / 10 exactly (for multiples of 10, across the envelope).
7. `applyBps(a, b) ≤ a` for b ≤ 100 %, within half a unit of the exact value.
8. Attribution is monotone up, recovery is monotone down (one knob at a
   time); final money never exceeds gross.

---

<p dir="rtl" align="right"><sub>پول را با عدد صحیح حساب کنید، نه با اعتماد به اعشار.</sub></p>
