'use client';

// Shared sub-navigation strip for the /alerting/* pages (alerting IA consolidation):
// channels ↔ rules ↔ on-call ↔ maintenance. Mirrors SettingsNav.

import Link from 'next/link';
import { cn } from '@/lib/utils';
import { useLang } from '@/hooks/use-language';
import type { TranslationKey } from '@/lib/i18n';

export type AlertingNavActive = 'channels' | 'rules' | 'oncall' | 'maintenance';

export function AlertingNav({ active }: { active: AlertingNavActive }) {
  const { t } = useLang();
  const items: Array<{ href: string; label: TranslationKey; id: AlertingNavActive }> = [
    { href: '/alerting/channels', label: 'alerting.nav.channels', id: 'channels' },
    { href: '/alerting/rules', label: 'alerting.nav.rules', id: 'rules' },
    { href: '/alerting/oncall', label: 'alerting.nav.oncall', id: 'oncall' },
    { href: '/alerting/maintenance', label: 'alerting.nav.maintenance', id: 'maintenance' },
  ];

  return (
    <nav aria-label={t('alerting.nav.title')} className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {t('alerting.nav.title')}
      </span>
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              isActive
                ? 'border-primary/40 text-brand-ink'
                : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground',
            )}
          >
            {t(item.label)}
          </Link>
        );
      })}
    </nav>
  );
}
