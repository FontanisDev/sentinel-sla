#!/usr/bin/env python3
"""Generate tests/scenarios/iranian-fintech-synthetic.json .

Synthetic Iranian-fintech traffic scenario built from the money-model shape:
hour-of-week profile (Tehran +210) with the 20:00-23:00 daily peak, Thu-Fri
weekend ramp-down, plus a calendar-events layer (Yalda night, Nowruz week,
month-end salary days). Everything here is SYNTHETIC and scaled by declared
constants — the JSON is the single source of truth, the unit test validates
internal consistency and the hand-computed loss expectations.
"""
import json
import os
from datetime import datetime, timedelta, timezone

TZ = timezone(timedelta(minutes=210))

# ── profile rules (Tehran local) ────────────────────────────────────────────
WEEKDAY = [(0, 7, 90), (7, 10, 110), (10, 17, 150), (17, 20, 250), (20, 23, 420), (23, 24, 100)]
THURSDAY = [(0, 7, 90), (7, 10, 110), (10, 14, 130), (14, 17, 60), (17, 20, 60), (20, 23, 40), (23, 24, 40)]
FRIDAY = [(0, 20, 35), (20, 23, 60), (23, 24, 35)]

profile = []
for day in range(7):  # 0 = Sunday … 6 = Saturday (money-model convention)
    if day == 4:      # Thursday
        rules = THURSDAY
    elif day == 5:    # Friday
        rules = FRIDAY
    else:
        rules = WEEKDAY
    for hour in range(24):
        value = next(v for lo, hi, v in rules if lo <= hour < hi)
        profile.append(value)
assert len(profile) == 168

# ── calendar events ─────────────────────────────────────────────────────────
def tehran_iso(s: str) -> str:
    return datetime.fromisoformat(s).replace(tzinfo=TZ).isoformat().replace('+03:30', '+03:30')

events = {
    'yalda': {
        'label': 'Yalda night (winter-solstice eve) — late-night shopping spike',
        'windowStartTehran': '2026-12-21T18:00:00',
        'windowEndTehran': '2026-12-22T06:00:00',
        'scale': 1.8,
    },
    'nowruz': {
        'label': 'Nowruz week (Farvardin 1-7) — holiday trough',
        'windowStartTehran': '2026-03-20T00:00:00',
        'windowEndTehran': '2026-03-28T00:00:00',
        'scale': 0.25,
    },
    'salaryDays': {
        'label': 'Month-end salary day — representative 1404/1405 pay-day evenings '
                 '(explicit Gregorian samples; not a full Jalali calendar)',
        'daysTehran': ['2026-01-21', '2026-02-19', '2026-03-19', '2026-04-20', '2026-05-20'],
        'dailyStartHourTehran': 17,
        'dailyEndHourTehran': 24,
        'scale': 1.35,
    },
}

# ── loss cases (start-bucket convention, as the golden runner uses) ─────────
def epoch(utc_iso: str) -> int:
    return int(datetime.fromisoformat(utc_iso).timestamp())

cases = [
    {
        'id': 'weekday-peak',
        'title': 'Ordinary Sunday-evening peak outage (20:15, 90 min)',
        'human': 'Bucket Sunday 20-23 = 420 tx/s. 5400 s × 420 × 850 000 IRR = 1 927 800 000 000 IRR gross; attribution 100 %, recovery 0 %, margin 100 % → final equals gross.',
        'startUtc': '2026-01-04T16:45:00Z',
        'seconds': 5400,
        'eventScale': None,
        'expectFinalRials': 1927800000000,
    },
    {
        'id': 'yalda-night',
        'title': 'Yalda-night outage (22:00, 6 h) at ×1.8 spike',
        'human': 'Bucket Monday 20-23 = 420 × 1.8 = 756 tx/s. 21600 s × 756 × 850 000 IRR = 13 880 160 000 000 000 IRR.',
        'startUtc': '2026-12-21T18:30:00Z',
        'seconds': 21600,
        'eventScale': 1.8,
        'expectFinalRials': 13880160000000000,
    },
    {
        'id': 'nowruz-trough',
        'title': 'Nowruz-week outage (11:00, 1 h) at ×0.25 trough',
        'human': 'Bucket Monday 10-17 = 150 × 0.25 = 37.5 tx/s. 3600 s × 37.5 × 850 000 IRR = 114 750 000 000 IRR.',
        'startUtc': '2026-03-23T07:30:00Z',
        'seconds': 3600,
        'eventScale': 0.25,
        'expectFinalRials': 114750000000,
    },
    {
        'id': 'salary-day-thursday',
        'title': 'Salary-day outage on a Thursday evening (19:30, 1 h) at ×1.35',
        'human': 'Bucket Thursday 17-20 = 60 × 1.35 = 81 tx/s. 3600 s × 81 × 850 000 IRR = 247 860 000 000 IRR.',
        'startUtc': '2026-03-19T16:00:00Z',
        'seconds': 3600,
        'eventScale': 1.35,
        'expectFinalRials': 247860000000,
    },
    {
        'id': 'friday-weekend',
        'title': 'Friday-weekend outage (14:00, 1 h)',
        'human': 'Bucket Friday 00-20 = 35 tx/s. 3600 s × 35 × 850 000 IRR = 107 100 000 000 IRR.',
        'startUtc': '2026-01-09T10:30:00Z',
        'seconds': 3600,
        'eventScale': None,
        'expectFinalRials': 107100000000,
    },
]

doc = {
    'id': 'iranian-fintech-synthetic',
    'synthetic': True,
    'syntheticNotice': 'SYNTHETIC — written by the Sentinel-SLA project from its money model '
                       'No real provider data: shape (peak 20:00-23:00, '
                       'Thu-Fri weekend, Yalda, Nowruz, salary days) is directionally modelled '
                       'on public knowledge of Iranian fintech rhythms; every number is invented '
                       'and must never be used as market data. Never use as money input — '
                       'validation scenarios only.',
    'title': 'Iranian-fintech synthetic traffic profile and outage valuations',
    'moneyModel': {
        'version': 1,
        'effectiveFrom': '2026-01-01T00:00:00.000Z',
        'currency': 'IRR',
        'avgTicketRials': 850000,
        'txPerSecond': {'kind': 'hourOfWeekProfile', 'tzOffsetMinutes': 210, 'profile': profile},
        'failureAttributionPct': 100,
        'recoveryFactorPct': 0,
        'basis': 'revenue',
        'grossMarginOrFeePct': 100,
    },
    'profileRules': {
        'note': 'Bucket index = day-of-week × 24 + Tehran hour; Sunday = 0 (money-model convention).',
        'weekday': [{'fromHour': a, 'toHour': b, 'tps': v} for a, b, v in WEEKDAY],
        'thursday': [{'fromHour': a, 'toHour': b, 'tps': v} for a, b, v in THURSDAY],
        'friday': [{'fromHour': a, 'toHour': b, 'tps': v} for a, b, v in FRIDAY],
    },
    'calendarEvents': events,
    'resolverConvention': 'Like the golden runner: the tps is taken at the outage START bucket '
                          '(Tehran local), then the matching calendar-event scale (if any) applies.',
    'lossCases': cases,
}

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tests', 'scenarios', 'iranian-fintech-synthetic.json')
open(out, 'w').write(json.dumps(doc, indent=2, ensure_ascii=False) + '\n')
print(f'wrote {out} ({len(profile)} profile buckets, {len(cases)} loss cases)')
