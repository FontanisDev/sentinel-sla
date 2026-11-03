'use client';

// Shared page shell for the /alerting/* pages: AppShell + sub-nav strip
// + PageHeader + content. Keeps the four alerting routes visually identical
// and gives them the full chrome (nav, palette, tenant switcher).

import { AppShell, type AppShellUser } from '@/components/sentinel/app-shell';
import { AlertingNav, type AlertingNavActive } from './alerting-nav';
import { PageHeader } from '@/components/sentinel/page-header';
import { useLang } from '@/hooks/use-language';

export function AlertingPage({
  user,
  active,
  title,
  description,
  actions,
  children,
}: {
  user: AppShellUser;
  active: AlertingNavActive;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t } = useLang();
  return (
    <AppShell
      user={user}
      crumbs={[
        { label: t('crumb.home'), href: '/' },
        { label: t('alerting.nav.title') },
        { label: title },
      ]}
    >
      <div className="mx-auto w-full max-w-5xl">
        <AlertingNav active={active} />
        <div className="mt-6">
          <PageHeader title={title} description={description} actions={actions} />
        </div>
        <div className="mt-6 space-y-6">{children}</div>
      </div>
    </AppShell>
  );
}
