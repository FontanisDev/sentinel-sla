// Sentinel-SLA — notification templates (pure module).
//
// The product "speaks two languages": technical messages for engineers are
// English (matching runbooks/dashboards), executive messages are formal
// Persian with Jalali timestamps and Persian digits — the money-and-contract
// identity of the product. Every template is a pure function of its
// variables: no db, no clock, no network — golden-testable.
//
// Variable interpolation uses {name} placeholders resolved from the vars
// record; unknown placeholders render as an empty string (never "{name}"
// leaking into a real page). Messages are plain text (no markup) so the same
// render is safe for Telegram, Bale, webhook JSON and email bodies alike.
//
// Ack links: when the instance has SENTINEL_ACK_SECRET (or the ackSecret
// integration setting), the engine passes an ackUrl into detection/escalation
// templates; when absent the URL placeholder collapses to empty string and
// the message simply offers the UI path instead (honest degradation).

export type NotifyTopic = 'detection' | 'recovery' | 'escalation' | 'rule' | 'test' | 'digest' | 'selftest';
export type NotifyAudience = 'technical' | 'executive';
export type NotifySeverity = 'critical' | 'warning' | 'info';

export type NotifyVars = Record<string, string | number | null | undefined>;

/** 1,234,567 (EN grouping) — Latin digits for the technical audience. */
function fmtIntEn(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** ۱٬۲۳۴٬۵۶۷ — Persian digits with the Persian thousands separator. */
function fmtIntFa(n: number): string {
  return Math.round(n).toLocaleString('fa-IR');
}

function fmtTomans(n: number, lang: 'en' | 'fa'): string {
  const v = lang === 'fa' ? fmtIntFa(n) : fmtIntEn(n);
  return lang === 'fa' ? `${v} تومان` : `${v} Tomans`;
}

function fmtDur(sec: number | null, lang: 'en' | 'fa'): string {
  if (sec === null || !Number.isFinite(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return lang === 'fa' ? `${fmtIntFa(s)} ثانیه` : `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (lang === 'fa') return r > 0 ? `${fmtIntFa(m)} دقیقه و ${fmtIntFa(r)} ثانیه` : `${fmtIntFa(m)} دقیقه`;
  return r > 0 ? `${m}m ${r}s` : `${m}m`;
}

/** Jalali wall-clock for FA (Asia/Tehran), HH:MM 24h for EN (server tz). */
function fmtClock(d: Date, lang: 'en' | 'fa'): string {
  if (lang === 'fa') {
    try {
      return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Tehran',
      }).format(d);
    } catch {
      return d.toISOString();
    }
  }
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function interpolate(template: string, vars: NotifyVars): string {
  return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_m, key: string) => {
    const v = vars[key];
    if (v === null || v === undefined) return '';
    return String(v);
  });
}
void interpolate;

/** Per-minute transaction/money loss — the honest arithmetic executives see. */
function perMinuteLoss(vars: NotifyVars, lang: 'en' | 'fa'): { tx: number; money: string } {
  const tps = Number(vars.tps ?? 0);
  const ticket = Number(vars.avgTransactionValue ?? 0);
  return { tx: tps * 60, money: fmtTomans(tps * 60 * ticket, lang) };
}

function penaltyExposure(vars: NotifyVars, lang: 'en' | 'fa'): string {
  const base = Number(vars.penaltyBase ?? 0);
  const perMin = Number(vars.penaltyPerMinute ?? 0);
  return fmtTomans(base + perMin, lang);
}

// ── EN technical templates (engineer audience) ───────────────────────────────

type Sev = 'critical' | 'warning' | 'info';
type Render = (v: NotifyVars) => { title: string; body: string };

function recoveryEn(v: NotifyVars): { title: string; body: string } {
  const mttr = v.mttrSec === null || v.mttrSec === undefined ? null : Number(v.mttrSec);
  const mttd = v.mttdSec === null || v.mttdSec === undefined ? null : Number(v.mttdSec);
  return {
    title: `[RECOVERY] ${v.serviceName} is back up`,
    body:
      `Total downtime ${fmtDur(mttr, 'en')}, MTTD ${mttd === null ? '—' : `${mttd.toFixed(1)}s`}, MTTR ${mttr === null ? '—' : `${mttr.toFixed(1)}s`}. ` +
      `Impact: ${fmtIntEn(Number(v.lostTransactions ?? 0))} transactions (${fmtTomans(Number(v.revenueLossTomans ?? 0), 'en')}) lost, SLA penalty ${fmtTomans(Number(v.penaltyTomans ?? 0), 'en')}.`,
  };
}

function ruleEn(v: NotifyVars): { title: string; body: string } {
  return {
    title: `[${String(v.severity ?? 'warning').toUpperCase()}] Rule "${v.ruleName}" fired on ${v.serviceName}`,
    body:
      `${v.ruleName}: ${v.metric} ${v.operator} ${v.threshold} — measured ${v.measuredValue} on ${v.serviceName}. ` +
      (v.ackUrl ? `Acknowledge: ${v.ackUrl}` : 'See the Sentinel dashboard. '),
  };
}

function testEn(v: NotifyVars): { title: string; body: string } {
  return {
    title: `[TEST] Sentinel delivery check — ${v.channelName}`,
    body: `This is a test delivery from Sentinel-SLA to channel "${v.channelName}". If you can read this, the ${v.kind} adapter works. Sent ${fmtClock(new Date(String(v.sentAt ?? Date.now())), 'en')}.`,
  };
}

function digestEn(v: NotifyVars): { title: string; body: string } {
  return {
    title: `Sentinel digest — ${v.windowLabel}`,
    body: `${v.incidentsCount} incident(s), ${fmtTomans(Number(v.revenueLossTomans ?? 0), 'en')} revenue loss, SLA penalties ${fmtTomans(Number(v.penaltyTomans ?? 0), 'en')}. Worst service: ${v.worstService}.`,
  };
}

/** self-test gate miss: the product's own promise broke. */
function selfTestEn(v: NotifyVars): { title: string; body: string } {
  const mttd = v.mttdSec === null || v.mttdSec === undefined ? 'never detected' : `${fmtDur(Number(v.mttdSec), 'en')} to detect`;
  return {
    title: `[SELF-TEST FAILED] detection gate missed (gate ${v.gateSec}s)`,
    body:
      `The weekly self-test injected a controlled outage on its own synthetic target and the ` +
      `detection pipeline did NOT meet the ${v.gateSec}s promise: ${mttd}` +
      `${v.selfTestError && v.selfTestError !== 'unknown' ? ` (stage: ${v.selfTestError})` : ''}. ` +
      `Every customer SLA report inherits this measurement — verify monitoring health ` +
      `and re-run from /resilience. Run id: ${v.runId}.`,
  };
}

const EN: Record<NotifyTopic, Record<Sev, Render>> = {
  detection: {
    critical: (v) => ({
      title: `[CRITICAL] ${v.serviceName} is DOWN`,
      body:
        `Probes failed from ${v.probeLabel}. Endpoint ${v.endpoint} timing out. ` +
        `Losing ~${fmtIntEn(Number(v.tps ?? 0) * 60)} tx and ${fmtTomans(Number(v.tps ?? 0) * 60 * Number(v.avgTransactionValue ?? 0), 'en')} per minute. ` +
        `SLA penalty exposure: ${penaltyExposure(v, 'en')}. ` +
        `Down since ${fmtClock(new Date(String(v.startedAt)), 'en')}. ` +
        (v.ackUrl ? `Acknowledge: ${v.ackUrl}` : 'Acknowledge in the Sentinel dashboard.'),
    }),
    warning: (v) => ({
      title: `[WARNING] ${v.serviceName} is DEGRADED`,
      body:
        `Signal degraded per ${v.probeLabel}. Endpoint ${v.endpoint} — latency ${v.latencyMs}ms, error rate ${v.errorRate}%. ` +
        `Losing ~${fmtIntEn(Math.round(0.325 * Number(v.tps ?? 0) * 60))} tx and ${fmtTomans(0.325 * Number(v.tps ?? 0) * 60 * Number(v.avgTransactionValue ?? 0), 'en')} per minute (~32.5% partial-loss model). ` +
        `SLA penalty exposure (warning weight 30%): ${penaltyExposure(v, 'en')}. ` +
        (v.ackUrl ? `Acknowledge: ${v.ackUrl}` : 'Acknowledge in the Sentinel dashboard.'),
    }),
    info: (v) => ({ title: `[INFO] ${v.serviceName}`, body: String(v.body ?? '') }),
  },
  recovery: { critical: recoveryEn, warning: recoveryEn, info: recoveryEn },
  escalation: {
    critical: (v) => ({
      title: `[ESCALATION] ${v.serviceName} unacknowledged ${fmtDur(Number(v.unackedSec ?? 0), 'en')}`,
      body:
        `Primary did not acknowledge within the ${v.timeoutMin}-minute policy window. Paging ${v.who}. ` +
        `Incident ${v.serviceKey} ongoing since ${fmtClock(new Date(String(v.startedAt)), 'en')}. ` +
        (v.ackUrl ? `Acknowledge: ${v.ackUrl}` : 'Acknowledge to stop further pages in the dashboard.'),
    }),
    warning: (v) => ({
      title: `Escalation: ${v.serviceName} still unacknowledged`,
      body:
        `${v.serviceName} has been down ${fmtDur(Number(v.unackedSec ?? 0), 'en')} without an on-call acknowledgement. ` +
        `The ${v.timeoutMin}-minute escalation policy fired — ${v.who} was paged. ` +
        `Current exposure: ${perMinuteLoss(v, 'en').money} per minute plus SLA penalties.`,
    }),
    info: (v) => ({ title: `[INFO] ${v.serviceName}`, body: String(v.body ?? '') }),
  },
  rule: { critical: ruleEn, warning: ruleEn, info: ruleEn },
  test: { critical: testEn, warning: testEn, info: testEn },
  digest: { critical: digestEn, warning: digestEn, info: digestEn },
  selftest: { critical: selfTestEn, warning: selfTestEn, info: selfTestEn },
};

// ── FA executive templates (formal Persian, Jalali, Persian digits) ─────────

function recoveryFa(v: NotifyVars): { title: string; body: string } {
  return {
    title: `بازگشت به سرویس عادی: ${v.serviceName}`,
    body:
      `خدمت «${v.serviceName}» پس از ${fmtDur(v.mttrSec === null || v.mttrSec === undefined ? null : Number(v.mttrSec), 'fa')} به حالت عادی بازگشت. ` +
      `خسارت نهایی: ${fmtIntFa(Number(v.lostTransactions ?? 0))} تراکنش معادل ${fmtTomans(Number(v.revenueLossTomans ?? 0), 'fa')}، ` +
      `جریمه قراردادی SLA: ${fmtTomans(Number(v.penaltyTomans ?? 0), 'fa')}. ` +
      `گزارش کامل در داشبورد مدیریتی سنتیل قابل مشاهده است.`,
  };
}

function ruleFa(v: NotifyVars): { title: string; body: string } {
  return {
    title: `هشدار قانون «${v.ruleName}»: ${v.serviceName}`,
    body:
      `قانون «${v.ruleName}» فعال شد: ${v.metric} ${v.operator === 'gt' ? 'بیش از' : 'کمتر از'} ${v.threshold} — مقدار اندازه‌گیری‌شده ${v.measuredValue}. ` +
      `جزئیات در داشبورد سنتیل.`,
  };
}

function testFa(v: NotifyVars): { title: string; body: string } {
  return {
    title: `آزمایش ارسال سنتیل — ${v.channelName}`,
    body: `این یک پیام آزمایشی از سامانه سنتیل به کانال «${v.channelName}» است. در صورت دریافت، اتصال ${v.kindFa} سالم است. زمان ارسال: ${fmtClock(new Date(String(v.sentAt ?? Date.now())), 'fa')}.`,
  };
}

function digestFa(v: NotifyVars): { title: string; body: string } {
  return {
    title: `گزارش خلاصه سنتیل — ${v.windowLabelFa}`,
    body:
      `در بازه ${v.windowLabelFa}: ${fmtIntFa(Number(v.incidentsCount ?? 0))} مورد اختلال ثبت شد؛ ` +
      `خسارت درآمدی ${fmtTomans(Number(v.revenueLossTomans ?? 0), 'fa')} و جریمه قراردادی ${fmtTomans(Number(v.penaltyTomans ?? 0), 'fa')}. ` +
      `بیشترین تأثیر: ${v.worstServiceFa}.`,
  };
}

/** فاز ۶ — شکست خودسنجی: وعده شناسایی زیر ۶۰ ثانیه محقق نشد. */
function selfTestFa(v: NotifyVars): { title: string; body: string } {
  const mttd = v.mttdSec === null || v.mttdSec === undefined
    ? 'اختلال اصلاً شناسایی نشد'
    : `شناسایی پس از ${fmtDur(Number(v.mttdSec), 'fa')} انجام شد`;
  return {
    title: `شکست خودسنجی سنتیل — سقف ${fmtIntFa(Number(v.gateSec ?? 60))} ثانیه محقق نشد`,
    body:
      `خودسنجی دوره‌ای، یک اختلال کنترل‌شده روی هدف آزمایشی داخلی ایجاد کرد و خط شناسایی سامانه ` +
      `از سقف ${fmtIntFa(Number(v.gateSec ?? 60))} ثانیه فراتر رفت: ${mttd}. ` +
      `این سنجه مبنای گزارش‌های SLA مشتریان است؛ لطفاً سلامت پایش را بررسی و از صفحه تاب‌آوری در داشبورد، خودسنجی را دوباره اجرا کنید. ` +
      `شناسه اجرا: ${v.runId}.`,
  };
}

const FA: Record<NotifyTopic, Record<Sev, Render>> = {
  detection: {
    critical: (v) => ({
      title: `اختلال بحرانی: ${v.serviceName}`,
      body:
        `خدمت «${v.serviceName}» از ساعت ${fmtClock(new Date(String(v.startedAt)), 'fa')} در دسترس نیست. ` +
        `برآورد خسارت: حدود ${fmtIntFa(Number(v.tps ?? 0) * 60)} تراکنش معادل ${perMinuteLoss(v, 'fa').money} در هر دقیقه. ` +
        `سقف جریمه طبق قرارداد SLA: ${penaltyExposure(v, 'fa')}. ` +
        `جزئیات فنی در داشبورد سنتیل در دسترس تیم فنی است.` +
        (v.ackUrl ? `\nلینک تأیید و پیگیری: ${v.ackUrl}` : ''),
    }),
    warning: (v) => ({
      title: `کاهش کیفیت خدمت: ${v.serviceName}`,
      body:
        `خدمت «${v.serviceName}» از ساعت ${fmtClock(new Date(String(v.startedAt)), 'fa')} با افت کیفیت کار می‌کند. ` +
        `برآورد خسارت: حدود ${perMinuteLoss(v, 'fa').money} در هر دقیقه (مدل خسارت جزئی ۳۲٫۵ درصد). ` +
        `جریمه قراردادی در سناریوی هشدار (وزن ۳۰ درصد): ${fmtTomans(0.3 * (Number(v.penaltyBase ?? 0) + Number(v.penaltyPerMinute ?? 0)), 'fa')}. ` +
        `تیم فنی در جریان است و پیگیری می‌شود.`,
    }),
    info: (v) => ({ title: `اطلاعیه: ${v.serviceName}`, body: String(v.body ?? '') }),
  },
  recovery: { critical: recoveryFa, warning: recoveryFa, info: recoveryFa },
  escalation: {
    critical: (v) => ({
      title: `تشدید پیگیری: ${v.serviceName}`,
      body:
        `اختلال «${v.serviceName}» پس از ${fmtDur(Number(v.unackedSec ?? 0), 'fa')} تأیید نشد. ` +
        `طبق سیاست ${fmtIntFa(Number(v.timeoutMin ?? 0))} دقیقه‌ای، پیگیری به ${v.whoFa} واگذار شد. ` +
        `خسارت جاری: ${perMinuteLoss(v, 'fa').money} در هر دقیقه به‌علاوه جریمه قراردادی.` +
        (v.ackUrl ? `\nلینک تأیید: ${v.ackUrl}` : ''),
    }),
    warning: (v) => ({
      title: `تشدید پیگیری: ${v.serviceName}`,
      body:
        `اختلال «${v.serviceName}» ${fmtDur(Number(v.unackedSec ?? 0), 'fa')} است بدون تأیید مسئول ادامه دارد؛ ` +
        `پیگیری به ${v.whoFa} واگذار شد. خسارت جاری: ${perMinuteLoss(v, 'fa').money} در هر دقیقه.`,
    }),
    info: (v) => ({ title: `اطلاعیه: ${v.serviceName}`, body: String(v.body ?? '') }),
  },
  rule: { critical: ruleFa, warning: ruleFa, info: ruleFa },
  test: { critical: testFa, warning: testFa, info: testFa },
  digest: { critical: digestFa, warning: digestFa, info: digestFa },
  selftest: { critical: selfTestFa, warning: selfTestFa, info: selfTestFa },
};

// ── public surface ───────────────────────────────────────────────────────────

/**
 * Render one notification. Audience decides the language: technical → EN,
 * executive → formal FA. Returns title + body ready for the outbox row.
 */
export function renderNotification(
  topic: NotifyTopic,
  severity: NotifySeverity,
  audience: NotifyAudience,
  vars: NotifyVars,
): { title: string; body: string } {
  const table = audience === 'executive' ? FA : EN;
  const sevTable = table[topic];
  const render: Render = sevTable[severity] ?? sevTable.info;
  const out = render(vars);
  // control-char pass: strip chars that break message transports
  const clean = (s: string): string => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return { title: clean(out.title), body: clean(out.body) };
}

/** Who escalation pages — EN phrasing for the technical message. */
export function escalationWhoEn(secondaryName: string, secondaryHandle: string, nobodyOnDuty: boolean): string {
  return nobodyOnDuty ? 'NOBODY IS ON DUTY — escalation gap' : `${secondaryName} (${secondaryHandle})`;
}

/** Who escalation pages — formal Persian for the executive message. */
export function escalationWhoFa(secondaryName: string, secondaryHandle: string, nobodyOnDuty: boolean): string {
  return nobodyOnDuty ? 'مسئول پشتیبانی در دسترس نیست' : `${secondaryName} (${secondaryHandle})`;
}

/**
 * The template catalog for the UI preview (GET /api/notifications/templates):
 * every topic × severity pair with SAMPLE variables rendered in place, so the
 * settings page can show exactly what a Telegram/webhook page will look like
 * before anything real fires. Sample vars are realistic and labelled as
 * samples in the UI — never presented as live product data.
 */
export const TEMPLATE_CATALOG: Array<{ topic: NotifyTopic; severity: NotifySeverity }> = [
  { topic: 'detection', severity: 'critical' },
  { topic: 'detection', severity: 'warning' },
  { topic: 'recovery', severity: 'info' },
  { topic: 'escalation', severity: 'critical' },
  { topic: 'rule', severity: 'warning' },
  { topic: 'digest', severity: 'info' },
  { topic: 'selftest', severity: 'critical' },
  { topic: 'test', severity: 'info' },
];

/** Realistic sample variables for previews. */
export function sampleVars(topic: NotifyTopic, _severity: NotifySeverity): NotifyVars {
  const base: NotifyVars = {
    serviceName: 'Payment Gateway',
    serviceKey: 'payment-gateway',
    endpoint: 'https://pay.example.ir/health',
    probeLabel: 'sentinel/blackbox',
    startedAt: new Date('2026-10-08T09:30:00Z').toISOString(),
    tps: 10,
    avgTransactionValue: 250_000,
    penaltyBase: 5_000_000,
    penaltyPerMinute: 1_000_000,
    latencyMs: 1840,
    errorRate: '12.4',
    mttdSec: 7.7,
    mttrSec: 95.2,
    lostTransactions: 997,
    revenueLossTomans: 75_000_000,
    penaltyTomans: 29_700_000,
    unackedSec: 180,
    timeoutMin: 5,
    who: 'Sara Karimi (@sara_oncall)',
    whoFa: 'سارا کریمی (@sara_oncall)',
    ruleName: 'Error rate ceiling',
    metric: 'errorRate',
    operator: 'gt',
    threshold: 0.05,
    measuredValue: 0.124,
    channelName: 'SRE War Room',
    kind: 'telegram',
    kindFa: 'تلگرام',
    sentAt: new Date('2026-10-08T09:35:00Z').toISOString(),
    windowLabel: 'last 24 hours',
    windowLabelFa: '۲۴ ساعت گذشته',
    incidentsCount: 3,
  };
  if (topic === 'digest') {
    base.revenueLossTomans = 210_000_000;
    base.penaltyTomans = 84_000_000;
    base.worstService = 'Payment Gateway';
    base.worstServiceFa = 'درگاه پرداخت';
  }
  if (topic === 'selftest') {
    base.gateSec = 60;
    base.runId = 'clr0sample0run0id';
    base.mttdSec = null;
    base.mttrSec = null;
    base.selfTestError = 'detection-timeout';
  }
  return base;
}
