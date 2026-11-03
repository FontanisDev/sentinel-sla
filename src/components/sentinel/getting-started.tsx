'use client'

// guided setup — the getting-started checklist on the command center.
// Fetches /api/onboarding (read-only real counts) and shows the operator
// what is configured and what to do next. Dismissal is per-browser
// (localStorage) and stated as such in the hint — no hidden server state.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Circle, CircleCheck, X } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useLang } from '@/hooks/use-language'
import type { TranslationKey } from '@/lib/i18n'

const DISMISS_KEY = 'sentinel.onboarding.dismissed'

interface OnboardingStep {
  id: 'prometheus' | 'tenants' | 'services' | 'clients' | 'channels' | 'report'
  done: boolean
  count: number | null
  href: string
  demoSignalSource: boolean
}

interface OnboardingStatus {
  steps: OnboardingStep[]
  done: number
  total: number
  allDone: boolean
  mode: 'demo' | 'live'
}

const STEP_LABEL: Record<OnboardingStep['id'], TranslationKey> = {
  prometheus: 'onboarding.step.prometheus',
  tenants: 'onboarding.step.tenants',
  services: 'onboarding.step.services',
  clients: 'onboarding.step.clients',
  channels: 'onboarding.step.channels',
  report: 'onboarding.step.report',
}

export function GettingStartedCard() {
  const { t } = useLang()
  const [status, setStatus] = useState<OnboardingStatus | null>(null)
  const [dismissed, setDismissed] = useState(true) // hidden until the fetch decides

  useEffect(() => {
    let cancelled = false
    const stored = window.localStorage.getItem(DISMISS_KEY) === '1'
    fetch('/api/onboarding')
      .then((r) => (r.ok ? (r.json() as Promise<OnboardingStatus>) : null))
      .then((s) => {
        if (cancelled) return
        setDismissed(stored)
        setStatus(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const dismiss = useCallback(() => {
    window.localStorage.setItem(DISMISS_KEY, '1')
    setDismissed(true)
  }, [])

  if (!status || status.allDone || dismissed) return null

  return (
    <Card data-testid="getting-started">
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">
            {t('onboarding.title')}
            <span className="ms-2 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {t('onboarding.progress', { done: String(status.done), total: String(status.total) })}
            </span>
          </CardTitle>
          <CardDescription>{t('onboarding.desc')}</CardDescription>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t('onboarding.dismiss')}
          className="rounded-[4px] p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-1.5">
          {status.steps.map((step) => (
            <li key={step.id}>
              <Link
                href={step.href}
                className="flex items-center gap-2.5 rounded-[4px] px-2 py-1.5 transition-colors hover:bg-muted/40"
              >
                {step.done ? (
                  <CircleCheck className="size-4 shrink-0 text-ok" aria-hidden="true" />
                ) : (
                  <Circle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
                <span className={step.done ? 'text-sm text-muted-foreground line-through' : 'text-sm'}>
                  {t(STEP_LABEL[step.id])}
                </span>
                {step.id === 'prometheus' ? (
                  <span
                    className={
                      'ms-auto rounded-full border px-2 py-0.5 text-[10px] font-medium ' +
                      (step.demoSignalSource
                        ? 'border-warn/40 bg-warn-subtle text-warn'
                        : 'border-ok/25 bg-ok-subtle text-ok')
                    }
                  >
                    {step.demoSignalSource ? t('onboarding.demo') : t('onboarding.live')}
                  </span>
                ) : (
                  <span className="ms-auto font-mono text-xs tabular-nums text-muted-foreground">
                    {step.count ?? '—'}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">{t('onboarding.hint')}</p>
      </CardContent>
    </Card>
  )
}
