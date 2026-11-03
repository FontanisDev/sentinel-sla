// Generate public/templates/shaparak-tx-counts-sample.csv — a SYNTHETIC
// one-week hourly transaction-count sheet in the shape domestic PSP/Shaparak
// reports export (Jalali dates, Persian headers, Persian digits in counts).
// Shape mirrors docs/DOMAIN.md's Iranian fintech scenario: weekday service
// peak 20:00–23:00, Thursday–Friday weekend, Friday morning trough.
// Clearly marked synthetic — never real customer data.
import { writeFileSync } from 'node:fs';

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const fa = (n) => String(n).replace(/\d/g, (d) => FA_DIGITS[Number(d)]);

// Jalali 1404 week: 1404/07/07 … 1404/07/13 (Mon-Sun 2025, covers all 7 weekdays).
const start = { jy: 1404, jm: 7, jd: 7 }; // Monday
const JALALI_MONTH_LEN = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29]; // 1404 is not leap

function nextJalali({ jy, jm, jd }) {
  jd += 1;
  if (jd > JALALI_MONTH_LEN[jm - 1]) { jd = 1; jm += 1; }
  if (jm > 12) { jm = 1; jy += 1; }
  return { jy, jm, jd };
}

// Weekday multipliers (bucket dow: 0=Sunday … 5=Friday, 6=Saturday).
// Monday=1 … Thursday=4 are the strong days; Friday (5) the trough.
const DOW_FACTOR = [0.95, 1.05, 1.1, 1.12, 1.15, 0.55, 0.9];

let day = start;
const rows = [];
for (let d = 0; d < 7; d++) {
  const dow = d; // 1404/07/07 is a Monday → dow 1 … 1404/07/13 Sunday → dow 0
  for (let h = 0; h < 24; h++) {
    // base ~30k tx/hour overnight, business ramp, Iranian evening peak 20–23
    const night = 28_000 + 4_000 * Math.sin((h / 24) * Math.PI);
    const morning = h >= 8 && h < 12 ? 60_000 + 5_000 * (h - 8) : 0;
    const midday = h >= 12 && h < 17 ? 95_000 + 3_000 * (h - 12) : 0;
    const evening = h >= 17 && h < 24 ? 110_000 + 6_000 * (h - 17) * (h >= 20 && h <= 23 ? 1.6 : 1) : 0;
    const count = Math.round((night + morning + midday + evening) * DOW_FACTOR[dow]);
    const dateStr = `${day.jy}/${String(day.jm).padStart(2, '0')}/${String(day.jd).padStart(2, '0')}`;
    rows.push(`${dateStr},${fa(String(h).padStart(2, '0'))}:00,${fa(count.toLocaleString('en-US'))}`);
  }
  day = nextJalali(day);
}

const header = 'تاریخ,ساعت,تعداد تراکنش';
writeFileSync('public/templates/shaparak-tx-counts-sample.csv', '\ufeff' + header + '\n' + rows.join('\n') + '\n');
console.log(`wrote public/templates/shaparak-tx-counts-sample.csv (${rows.length} rows)`);
