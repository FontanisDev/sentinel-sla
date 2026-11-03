'use client'

// Sentinel-SLA — FormulaPopover (design system §6.7).
//
// Shows the formula, the concrete inputs and the evidence links behind any
// money or percent figure. "Every money figure in the app must use MoneyValue
// + FormulaPopover" — the inputs passed here are REAL row values, never
// illustrative samples (truthful-numbers rule).

import { Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useLang } from '@/hooks/use-language'
import { MoneyValue } from './money-value'

export interface FormulaInput {
  label: string
  /** Pre-formatted display value (already localized by the caller). */
  value: string
}

export interface FormulaEvidence {
  label: string
  /** Optional in-app link target; when absent the item is plain text. */
  href?: string
}

export function FormulaPopover({
  formula,
  inputs,
  evidence,
  className,
}: {
  /** The formula in symbolic form, e.g. "lost tx × avg tx value". */
  formula: string
  /** The actual inputs behind THIS figure. */
  inputs: FormulaInput[]
  /** Where the numbers and the policy come from. */
  evidence?: FormulaEvidence[]
  className?: string
}) {
  const { t } = useLang()

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={
            'size-5 shrink-0 text-muted-foreground hover:bg-raised hover:text-info focus-visible:ring-1 ' +
            (className ?? '')
          }
          aria-label={t('formula.show')}
          // rows are clickable — the popover trigger must not open the row's
          // detail view underneath the popover
          onClick={(e) => e.stopPropagation()}
        >
          <Info className="size-3.5" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-80 border-line bg-surface p-0 shadow-lg"
        role="dialog"
        aria-label={t('formula.title')}
      >
        <div className="space-y-3 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-text-2">
            {t('formula.title')}
          </p>

          {/* the formula itself — mono, inset */}
          <p
            dir="ltr"
            className="rounded-sm border border-line bg-inset px-2.5 py-1.5 font-mono text-[12px] leading-relaxed text-text-1"
          >
            {formula}
          </p>

          {/* concrete inputs behind this figure */}
          <dl className="space-y-1.5">
            {inputs.map((inp) => (
              <div key={inp.label} className="flex items-baseline justify-between gap-3">
                <dt className="text-[12px] text-text-2">{inp.label}</dt>
                <dd
                  dir="ltr"
                  className="whitespace-nowrap font-mono text-[12px] tabular-nums text-text-1"
                >
                  {inp.value}
                </dd>
              </div>
            ))}
          </dl>

          {evidence && evidence.length > 0 ? (
            <div className="border-t border-line pt-2.5">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-3">
                {t('formula.evidence')}
              </p>
              <ul className="space-y-1">
                {evidence.map((ev) => (
                  <li key={ev.label} className="text-[12px] leading-snug">
                    {ev.href ? (
                      <a
                        href={ev.href}
                        className="text-info underline-offset-2 hover:underline"
                      >
                        {ev.label}
                      </a>
                    ) : (
                      <span className="text-text-2">{ev.label}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Money figure + its formula popover, composed the way every table uses it. */
export function MoneyWithFormula({
  tomans,
  tone,
  formula,
  inputs,
  evidence,
  className,
}: {
  tomans: number
  tone?: 'default' | 'crit' | 'warn' | 'ok'
  formula: string
  inputs: FormulaInput[]
  evidence?: FormulaEvidence[]
  className?: string
}) {
  return (
    <span className={('inline-flex max-w-full items-center justify-end gap-1 ') + (className ?? '')}>
      <MoneyValue tomans={tomans} tone={tone} className="min-w-0" />
      <FormulaPopover formula={formula} inputs={inputs} evidence={evidence} />
    </span>
  )
}
