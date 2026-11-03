'use client'

// Sentinel-SLA — language toggle (English ⇆ فارسی).
// The product's identity: one dashboard, two languages, RTL-aware.

import { Languages } from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { setLang, useLang } from '@/hooks/use-language'

export function LanguageToggle({ className }: { className?: string }) {
  const { lang, t } = useLang()

  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={lang}
      onValueChange={(v) => {
        if (v === 'en' || v === 'fa') setLang(v)
      }}
      aria-label={t('lang.toggle')}
      className={cn('bg-surface-2 font-medium', className)}
    >
      <ToggleGroupItem value="en" className="gap-1 px-2 text-[11px] tracking-wide">
        <Languages className="hidden size-3 sm:block" aria-hidden="true" />
        {t('lang.en')}
      </ToggleGroupItem>
      <ToggleGroupItem value="fa" className="px-2 text-[11px]" lang="fa">
        {t('lang.fa')}
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
