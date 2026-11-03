'use client';

// Shared navigation strip for the /settings/* pages and the
// /resilience page. Keeps the workspace-settings area discoverable:
// services & integrations ↔ audit ↔ resilience. Alerting lives at /alerting/*
// since the alerting IA consolidation .

import Link from 'next/link';
import { cn } from '@/lib/utils';
import { useLang } from '@/hooks/use-language';

export type SettingsNavActive = 'services' | 'integrations' | 'audit' | 'resilience';

export function SettingsNav({ active }: { active: SettingsNavActive }) {
  const { t } = useLang();
  const items: Array<{ href: string; label: string; id: SettingsNavActive }> = [
    { href: '/settings/services', label: t('settings.nav.services'), id: 'services' },
    { href: '/settings/integrations', label: t('settings.integrations.title'), id: 'integrations' },
    { href: '/resilience', label: t('settings.nav.resilience'), id: 'resilience' },
    { href: '/settings/audit', label: t('settings.nav.audit'), id: 'audit' },
  ];

  return (
    <nav aria-label={t('settings.nav.title')} className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {t('settings.nav.title')}
      </span>
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              isActive
                ? 'border-primary/40 text-brand-ink'
                : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
