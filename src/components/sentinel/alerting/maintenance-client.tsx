'use client';

// /alerting/maintenance — alerting IA: planned-work windows. While a
// window is ACTIVE, alert delivery for the covered scope is suppressed;
// incidents are still detected and recorded (SLA truth untouched).
// Reuses the proven MaintenancePanel from the engineer home (single source).

import { useCallback, useEffect, useState } from 'react';
import { useLang } from '@/hooks/use-language';
import type { MaintenanceWindowDTO, ServiceDTO } from '@/lib/types';
import { MaintenancePanel } from '@/components/sentinel/maintenance-panel';
import { AlertingPage } from './alerting-page';

export function MaintenanceClient({
  user,
}: {
  user: { name: string; email: string; role: string; locale?: string | null };
}) {
  const { t } = useLang();
  const [services, setServices] = useState<ServiceDTO[]>([]);
  const [windows, setWindows] = useState<MaintenanceWindowDTO[] | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    const [svcRes, winRes] = await Promise.allSettled([
      fetch('/api/services', { cache: 'no-store' }),
      fetch('/api/maintenance', { cache: 'no-store' }),
    ]);
    if (winRes.status === 'fulfilled' && winRes.value.ok) {
      setWindows((await winRes.value.json()) as MaintenanceWindowDTO[]);
    } else {
      setWindows([]);
      setPageError(`HTTP ${winRes.status === 'fulfilled' ? winRes.value.status : '—'}`);
    }
    if (svcRes.status === 'fulfilled' && svcRes.value.ok) {
      const body = (await svcRes.value.json()) as { services: ServiceDTO[] };
      setServices(body.services ?? []);
    }
  }, []);

  useEffect(() => {
    const boot = setTimeout(() => void loadAll(), 0);
    const iv = setInterval(() => void loadAll(), 10000);
    return () => {
      clearTimeout(boot);
      clearInterval(iv);
    };
  }, [loadAll]);

  return (
    <AlertingPage
      user={user}
      active="maintenance"
      title={t('maint.title')}
      description={t('maint.desc')}
    >
      {pageError ? (
        <div
          className="rounded-[4px] border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical"
          role="alert"
        >
          HTTP — {pageError}
        </div>
      ) : null}
      {windows === null ? (
        <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground">…</div>
      ) : (
        <MaintenancePanel services={services} windows={windows} onChanged={loadAll} />
      )}
    </AlertingPage>
  );
}
