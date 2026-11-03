# Sentinel-SLA Design System ("Foundry")

This document defines how Sentinel-SLA looks and behaves: design tokens, typography,
layout, components, right-to-left (RTL) and Persian rules, accessibility and UX
behaviour. Tokens live in `src/app/globals.css`; components live in `src/components/ui`
and `src/components/sentinel`.

## 1. Direction

The visual reference is the enterprise data-platform console (Databricks, Grafana
Enterprise style). The system takes its attitude, not its logos, icons, colours or layouts.

- Calm, dense, serious. The UI is a control room for money, not a gaming dashboard.
- Neutral graphite surfaces and **one** accent colour. Colour carries meaning, never decoration.
- High information density with clear order: left navigation, breadcrumb bar, tables first, charts second.
- No glow, neon, surface gradients, glassmorphism, emoji or large rounded "playful" cards.
- Minimal motion: 120–160 ms fades and focus transitions. No bouncing or parallax. `prefers-reduced-motion` is respected.

## 2. Colour tokens

Tokens are CSS variables defined in `src/app/globals.css` (Tailwind v4 `@theme`).
Components use tokens only. Hex literals are allowed only in `palette.ts` for chart
strokes, which read the same tokens.

### Dark theme (default)

| Token | Value | Use |
|---|---|---|
| `--bg-app` | `#0D1215` | page background |
| `--bg-nav` | `#0A0F11` | left sidebar |
| `--bg-surface` | `#131A1E` | cards, tables |
| `--bg-raised` | `#1A2327` | table header, popovers, hover rows |
| `--bg-inset` | `#0F1519` | inputs, code blocks |
| `--line` | `#26323A` | 1 px borders, dividers |
| `--line-strong` | `#3A4953` | focused containers |
| `--text-1` | `#E8EDEF` | primary text |
| `--text-2` | `#9FB0B8` | secondary text |
| `--text-3` | `#7D8F99` | tertiary text, placeholders (4.5:1 or better on surface) |
| `--accent` | `#F2562B` | the single brand accent: primary buttons, active nav marker, key money figure underline |
| `--accent-hover` | `#FF6A40` | accent hover state |
| `--accent-subtle` | `#2B1812` | accent-tinted background |
| `--accent-contrast` | `#0D1215` | text and icons on the accent (5.51:1) |
| `--info` | `#3FA9C9` | links, informational chips |
| `--ok` | `#38B57A` | healthy, SLA met |
| `--warn` | `#E6A532` | degraded, budget burning |
| `--crit` | `#F77B7F` | down, SLA breached, penalty (5.13:1 on tinted rows) |
| `--ok-subtle`, `--warn-subtle`, `--crit-subtle`, `--info-subtle` | 14 % alpha of the base on `--bg-surface` | chip and row backgrounds |

### Light theme ("oat paper")

| Token | Value |
|---|---|
| `--bg-app` | `#EFEDE8` |
| `--bg-nav` | `#E6E3DC` |
| `--bg-surface` | `#FAF9F6` |
| `--bg-raised` | `#F2F0EB` |
| `--bg-inset` | `#FFFFFF` |
| `--line` | `#D6D2C8` |
| `--line-strong` | `#B9B4A7` |
| `--text-1` | `#14201F` |
| `--text-2` | `#4A5A5C` |
| `--text-3` | `#56646A` |
| `--accent` | `#C33712` |
| `--info` | `#17718F` |
| `--ok` | `#125C3A` |
| `--warn` | `#7A5408` |
| `--crit` | `#B3272C` |

The light values are tuned so that text and status colours reach at least 4.5:1 on
their surfaces (for example `--ok` 7.62:1, `--warn` 6.44:1, `--crit` 6.15:1 on tinted rows).

Colour rules:

1. Status is never colour-only. Every status shows an icon shape or text label next to the colour (WCAG 1.4.1).
2. The accent appears in at most **two** places per screen.
3. Loss and penalty money uses `--crit` text only on the single headline figure. Table money cells stay `--text-1`.
4. Charts use a six-colour series palette that stays distinguishable in both themes and under colour-blind simulation: `#3FA9C9`, `#F2562B`, `#38B57A`, `#E6A532`, `#9B8CE8`, `#C97BB2` (dark), with darker 600-level versions for light. Down and breach areas always use `--crit`.

## 3. Typography

| Role | Font | Notes |
|---|---|---|
| UI text | **Inter** (Latin) + **Vazirmatn** (Persian) | Bundled as local files in `public/fonts/` (OFL). No Google Fonts or CDN calls; the product works offline. |
| Numbers, IDs, code | **JetBrains Mono** or `IBM Plex Mono` | Tabular figures wherever money or time is shown. |

Scale (px / line-height): 12/16 caption, 13/20 table and dense body (default), 14/20
body, 16/24 section title, 20/28 page title, 28/32 hero figure. Weights: 400, 500, 600 only.

## 4. Layout

```
+------+--------------------------------------------------------------+
| NAV  | TOP BAR: breadcrumb | tenant switcher | time range | lang | user|
| 56/  +--------------------------------------------------------------+
| 232  | PAGE HEADER: title, description, primary action              |
| px   +--------------------------------------------------------------+
|      | CONTENT: 12-column grid, 16 px gutters, max width 1680 px    |
+------+--------------------------------------------------------------+
```

- The left navigation collapses (232 px expanded, 56 px icons-only). Groups: **Overview**, **Services**, **Incidents**, **Contracts & SLA**, **Reports**, **Alerting** (channels, rules, on-call, maintenance), **Resilience** (chaos), **Settings** (users, tenants, integrations, license, audit log).
- Navigation items and the default home page depend on the signed-in role. The Executive home is a separate page, not a toggle.
- Radius: 4 px for controls, 6 px for cards. Nothing larger.
- Spacing: 4 px grid. Card padding 16 px. Table row height 36 px (compact option 28 px).
- Elevation: borders, not shadows. Only popovers and dialogs carry a shadow.

## 5. RTL and Persian rules

- In RTL the navigation sits on the right, tables start on the right, and directional arrows flip.
- Use CSS logical properties everywhere (`margin-inline-start`, `ps-*`, `ms-*`). Do not use physical `left`/`right` utilities in new code.
- Charts keep time running left to right in both directions.
- Persian mode uses Vazirmatn at the same scale with line-height +2 px.
- Digits are Persian (۰–۹) through the formatter. Latin digits appear only in IDs and code.
- Dates follow the user's setting: Jalali or Gregorian (`JalaliDatePicker`, `DateText`).
- The language switch applies instantly and persists per user, not per browser.

## 6. Pages (information architecture)

| Route | Content | Primary user |
|---|---|---|
| `/` (role-aware) | Executive: money KPIs, SLA compliance by client, last incident cost, report button. Engineer: active incidents, service health table, burn rates, MTTD/MTTR. | all |
| `/services`, `/services/[key]` | Table with sort, filter and column picker. Detail: health, latency, error rate, money model, contract, recent incidents, evidence. | engineer |
| `/incidents`, `/incidents/[id]` | Table. Detail: timeline, financial breakdown with formula, acknowledge/resolve, post-mortem, evidence panel. | engineer, executive |
| `/contracts` | Client contracts: target, credit tiers, exclusions, current-month compliance, projected penalty. | executive, admin |
| `/reports` | Generated PDFs, schedules, preview, download, Persian/English. | executive |
| `/alerting/*` | Channels (test-send button and delivery log), rules, on-call, escalation, maintenance windows. | engineer |
| `/resilience` | Chaos experiments, weekly self-test history, MTTD trend. | engineer |
| `/settings/*` | Users and roles, tenants, API tokens, integrations (Prometheus URL, Alertmanager webhook, Grafana link), money model defaults, license, audit log, backup. | admin |
| `/login`, `/setup` | First-run wizard (create admin, choose Live or Demo mode) and login. | all |

Every list page provides search, filters, sortable columns, pagination or virtual
scroll, an empty state with an action, a loading skeleton, an error state with retry,
and CSV export where it applies.

## 7. Components

1. `AppShell` (nav + top bar + content), `NavItem`, `Breadcrumbs`.
2. `PageHeader` (title, subtitle, actions).
3. `DataTable`: sticky header, optional column resize, sort, column visibility, row selection, density toggle, keyboard navigation, RTL-safe, sticky first column.
4. `StatCard`: label, large figure (mono, tabular), delta with arrow and sign, optional sparkline, optional "how is this calculated?" popover.
5. `StatusChip`: `healthy | degraded | down | maintenance | unknown` — icon, label and colour.
6. `MoneyValue`: formats Tomans or Rials, Persian or Latin digits, compact form (`2.4B`) with the full value in a tooltip, never wraps.
7. `FormulaPopover`: shows the formula, inputs and evidence links behind a money or percent figure. Every money figure uses `MoneyValue` with `FormulaPopover`.
8. `TimeRange` picker (last 1h, 24h, 7d, 30d, custom) with Jalali or Gregorian display per user setting.
9. `Timeline` (incident events) and `EvidencePanel` (raw probe results, PromQL, timestamps).
10. `Chart` wrappers on Recharts: line, area, bar, heatmap, ring. Shared axis style, 1 px grid at 8 % opacity, mono tick labels, crosshair tooltip, legend toggles, accessible data-table fallback.
11. `Toast`, `ConfirmDialog` (destructive actions always confirm and name the object), `EmptyState`, `ErrorState`, `Skeleton`.
12. `CommandPalette` (⌘K / Ctrl+K): jump to a service, incident or page.
13. `JalaliDatePicker` and `DateText` with calendar switch.

## 8. Behaviour and UX rules

1. Each page has one primary action, drawn as an accent button. Secondary buttons are outlined. Destructive actions are `--crit` outlined and require confirmation.
2. Forms: label above input, helper text below, inline validation on blur. Error text is plain language and states the fix ("Chat id must be a number such as 123456789"). Disabled buttons explain why in a tooltip.
3. Live data shows "updated 3 s ago" and a pause/resume control. A paused view never changes under the cursor.
4. The UI never shows a raw stack trace or JSON error. It shows the human message and a copyable request id.
5. Every destructive or financial setting change writes an audit log entry visible in Settings.
6. In Demo mode a permanent slim banner reads "Demo data — simulation". Live mode never shows simulated numbers.
7. Keyboard: every interactive element is reachable by Tab. `g` then `i` opens incidents, `g` then `s` opens services, `/` focuses search, `?` shows shortcuts.
8. Printing a page produces clean light-theme output.

## 9. Accessibility

- Target: WCAG 2.2 AA. Text contrast ≥ 4.5:1. Large text and UI borders ≥ 3:1. Both themes.
- Visible focus ring: 2 px `--info` with a 2 px offset.
- Charts have text alternatives and a "view as table" toggle.
- Interactive targets are at least 24×24 px. Compact tables are the exception and provide a keyboard alternative.
- `axe-core` runs in Playwright against every page, in both themes and both languages, and must report zero serious or critical violations.

## 10. Visual checks

- Every page renders correctly in four variants: dark/light × English/Persian.
- Persian pages are fully mirrored: navigation on the right, tables start on the right, arrows flipped, charts keep time left to right.
- No horizontal page scroll at 1280, 1440 and 1920 px. The UI stays usable down to 1024 px. The mobile view covers Executive home, Incident detail and Acknowledge.
- No hex colour literal appears outside tokens and `palette.ts`.
- The browser network tab shows only the app origin at runtime. No external fonts or CDNs.
