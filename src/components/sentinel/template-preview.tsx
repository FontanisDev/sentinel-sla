'use client';

// TemplatePreview — "Message templates in English and
// Persian, technical audience and executive audience, with variables,
// preview in the UI."
//
// Renders the server-side template catalog (sample vars included, clearly
// labelled) EN-technical and FA-executive side by side. FA blocks get dir="rtl"
// so the preview mirrors what a Persian executive actually receives.

import { useEffect, useState } from 'react';
import { useLang } from '@/hooks/use-language';
import type { TranslationKey } from '@/lib/i18n';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

interface TemplateEntry {
  topic: string;
  severity: string;
  technical: { title: string; body: string };
  executive: { title: string; body: string };
}

export function TemplatePreview() {
  const { t } = useLang();
  const [templates, setTemplates] = useState<TemplateEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/notifications/templates', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { templates: TemplateEntry[] };
        if (alive) setTemplates(data.templates ?? []);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  const topicLabel = (topic: string): string => t(`settings.notif.tpl.topic.${topic}` as TranslationKey);
  const sevLabel = (severity: string): string => t(`settings.notif.tpl.sev.${severity}` as TranslationKey);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('settings.notif.tpl.title')}</CardTitle>
        <CardDescription>{t('settings.notif.tpl.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <p role="alert" className="rounded-[4px] border border-critical/40 bg-critical/10 px-3 py-2 text-xs text-critical">
            HTTP — {error}
          </p>
        ) : templates === null ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : templates.length === 0 ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : (
          templates.map((tpl) => (
            <div key={`${tpl.topic}-${tpl.severity}`} className="rounded-[4px] border border-border">
              <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
                <span className="text-xs font-semibold">{topicLabel(tpl.topic)}</span>
                <span
                  className={
                    'rounded-full border px-2 py-0.5 text-[10px] font-medium ' +
                    (tpl.severity === 'critical'
                      ? 'border-critical/40 bg-critical/10 text-critical'
                      : tpl.severity === 'warning'
                        ? 'border-warning/40 bg-warning/10 text-warning'
                        : 'border-border bg-muted/40 text-muted-foreground')
                  }
                >
                  {sevLabel(tpl.severity)}
                </span>
              </div>
              <div className="grid gap-0 md:grid-cols-2">
                <div className="border-b border-border p-3 md:border-b-0 md:border-e">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('settings.notif.tpl.technical')}
                  </p>
                  <p className="text-xs font-medium" dir="ltr">
                    {tpl.technical.title}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground" dir="ltr">
                    {tpl.technical.body}
                  </p>
                </div>
                <div className="p-3">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('settings.notif.tpl.executive')}
                  </p>
                  <p className="text-xs font-medium" dir="rtl">
                    {tpl.executive.title}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground" dir="rtl">
                    {tpl.executive.body}
                  </p>
                </div>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
