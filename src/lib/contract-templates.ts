// Sentinel-SLA — contract template library (wrong-money
// prevention: "contract template library (common Iranian PSP/bank SLA
// shapes)").
//
// Each template is a REFERENCE SHAPE for one common Iranian fintech service
// archetype: the availability target and the fixed + per-minute penalty
// pair an operator typically sees in that kind of signed SLA. Picking a
// template in the onboarding wizard (step 4 — money/SLA) pre-fills the
// three money fields so operators start from a realistic shape instead of
// typing arbitrary numbers.
//
// HONESTY RULES (binding):
//   • These are EXAMPLE values for common contract SHAPES, not legal or
//     commercial advice and not anyone's actual signed contract — the UI
//     shows a standing note telling the operator to replace them with the
//     real contract's numbers.
//   • Money is integer Tomans (the service money model's unit) — never
//     floats; the unit tests pin safe-integer-ness and the exact penalty
//     each template produces for canonical outages (golden fingerprints).
//   • No customer names: archetypes describe infrastructure kinds
//     ("Shaparak-style switching"), never companies.
//
// The list is ordered strictest → most lenient (availability descending) —
// the tests pin it.

export interface ContractTemplateTerms {
  /** Contractual availability target, (0, 1) — e.g. 0.9995 = 99.95 %. */
  slaTarget: number;
  /** Fixed penalty per chargeable incident, integer Tomans. */
  penaltyBase: number;
  /** Penalty per chargeable minute (1-minute minimum), integer Tomans. */
  penaltyPerMinute: number;
}

export interface ContractTemplate {
  /** Stable id for the wizard select and tests. */
  key: string;
  /** English archetype name. */
  name: string;
  /** Formal Persian archetype name. */
  nameFa: string;
  /** English description (one or two formal sentences). */
  desc: string;
  /** Formal Persian description. */
  descFa: string;
  terms: ContractTemplateTerms;
}

export const CONTRACT_TEMPLATES: readonly ContractTemplate[] = [
  {
    key: 'psp-switching',
    name: 'Payment switching gateway (Shaparak-style)',
    nameFa: 'درگاه سوئیچ پرداخت (شاپرک‌محور)',
    desc:
      'Strictest shape: a transaction-switching gateway between PSPs and Shaparak, where every minute of downtime is settlement-impacting and penalties scale steeply.',
    descFa:
      'سخت‌گیرانه‌ترین الگو: درگاه سوئیچ تراکنش میان پرداخت‌سازها و شاپرک که هر دقیقه اختلال بر تسویه اثر می‌گذارد و جریمه‌ها با شیب تندی رشد می‌کنند.',
    terms: { slaTarget: 0.9995, penaltyBase: 100_000_000, penaltyPerMinute: 15_000_000 },
  },
  {
    key: 'core-banking',
    name: 'Core banking / ledger service',
    nameFa: 'هستهٔ بانکداری و دفتر کل',
    desc:
      'Core ledger and account services where availability directly stops customer money movement; high base penalty per incident plus a heavy per-minute rate.',
    descFa:
      'سرویس‌های دفتر کل و حساب که دسترس‌پذیری آن‌ها مستقیماً جابه‌جایی پول مشتری را متوقف می‌کند؛ جریمهٔ پایهٔ بالا به‌همراه نرخ سنگین هر دقیقه.',
    terms: { slaTarget: 0.999, penaltyBase: 80_000_000, penaltyPerMinute: 12_000_000 },
  },
  {
    key: 'mobile-wallet',
    name: 'Mobile wallet',
    nameFa: 'کیف پول موبایل',
    desc:
      'Consumer wallet apps: strict availability with moderate per-incident penalties, reflecting high visibility but shorter per-incident revenue impact.',
    descFa:
      'اپلیکیشن‌های کیف پول: دسترس‌پذیری سخت‌گیرانه با جریمه‌های متوسط هر رخداد؛ متناسب با دیده‌شدن بالا اما اثر درآمدی کوتاه‌تر هر رخداد.',
    terms: { slaTarget: 0.9975, penaltyBase: 30_000_000, penaltyPerMinute: 4_000_000 },
  },
  {
    key: 'ipg-merchant',
    name: 'Internet payment gateway (IPG)',
    nameFa: 'درگاه پرداخت اینترنتی (IPG)',
    desc:
      'Merchant-facing IPG: mid-tier target and penalties — outages cost merchant transactions but the settlement cycle tolerates brief windows.',
    descFa:
      'درگاه پرداخت اینترنتی رو به پذیرندگان: هدف و جریمه‌های میانی؛ اختلال‌ها هزینهٔ تراکنش دارند اما چرخهٔ تسویه بازه‌های کوتاه را تحمل می‌کند.',
    terms: { slaTarget: 0.995, penaltyBase: 20_000_000, penaltyPerMinute: 2_500_000 },
  },
  {
    key: 'kyc-onboarding',
    name: 'KYC / onboarding and identity',
    nameFa: 'احراز هویت و پذیرش مشتری',
    desc:
      'Identity verification and customer onboarding flows: mid-tier availability, penalties sized to onboarding revenue rather than settlement.',
    descFa:
      'فرایندهای احراز هویت و پذیرش مشتری: دسترس‌پذیری میانی و جریمه‌هایی متناسب با درآمد پذیرش، نه تسویه.',
    terms: { slaTarget: 0.995, penaltyBase: 15_000_000, penaltyPerMinute: 1_500_000 },
  },
  {
    key: 'notify-panel',
    name: 'SMS / notification panel',
    nameFa: 'پنل اطلاع‌رسانی پیامکی',
    desc:
      'Supporting notification delivery: the most lenient shape — delays annoy customers but rarely stop money movement.',
    descFa:
      'ارسال اعلان‌های پشتیبان: منعطف‌ترین الگو؛ تأخیر برای مشتری آزاردهنده است اما به‌ندرت جابه‌جایی پول را متوقف می‌کند.',
    terms: { slaTarget: 0.99, penaltyBase: 5_000_000, penaltyPerMinute: 500_000 },
  },
] as const;

/** Look a template up by key (case-sensitive; keys are lowercase slugs). */
export function findContractTemplate(key: string): ContractTemplate | undefined {
  return CONTRACT_TEMPLATES.find((tpl) => tpl.key === key);
}
