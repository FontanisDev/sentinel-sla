'use client';

// /settings/services — CSV import card (customer onboarding:
// "data import (CSV of contracts and services)"). One row = one service with
// its SLA contract terms (target, penalties, tier) — the same fields the
// onboarding wizard posts, in bulk.
//
// Journey: load/paste a customer sheet → dry-run (validates every row,
// writes nothing, reports each failing row by physical CSV line) → commit
// (all-or-nothing; the server aborts if ANY row fails). After a successful
// commit the parent refreshes the registry so the new services appear
// immediately; the engine picks them up on its next tick.

import { useCallback, useRef, useState } from 'react';
import { useLang } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface ImportRowResult {
  line: number;
  key?: string;
  name?: string;
  ok: boolean;
  error?: string;
}

interface ImportReport {
  mode: 'dryRun' | 'commit';
  total: number;
  ok: number;
  failed: number;
  rows: ImportRowResult[];
  committed?: boolean;
  error?: string;
}

const TEMPLATE_URL = '/templates/services-import-template.csv';

export function ImportCsvCard({ onImported }: { onImported: () => void }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState('');
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const run = useCallback(
    async (mode: 'dryRun' | 'commit') => {
      setRunning(true);
      setError(null);
      try {
        const res = await fetch('/api/services/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csv, mode }),
        });
        const body = (await res.json().catch(() => ({}))) as ImportReport & { error?: string };
        if (!res.ok && typeof body.total !== 'number') {
          setError(body.error ?? `HTTP ${res.status}`);
          return;
        }
        setReport(body);
        if (body.committed) {
          setCsv('');
          setFileName(null);
          setReport(null);
          setOpen(false);
          onImported();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunning(false);
      }
    },
    [csv, onImported],
  );

  const onFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setError(null);
    setReport(null);
    const text = await file.text();
    setCsv(text);
  }, []);

  const allOk = report ? report.total > 0 && report.failed === 0 : false;

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        {t('settings.import.open')}
      </Button>
    );
  }

  return (
    <Card data-testid="import-csv">
      <CardHeader>
        <CardTitle className="text-base">{t('settings.import.title')}</CardTitle>
        <CardDescription>{t('settings.import.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Label htmlFor="import-csv-file" className="sr-only">
            {t('settings.import.file')}
          </Label>
          <input
            ref={fileRef}
            id="import-csv-file"
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          <Button variant="outline" onClick={() => fileRef.current?.click()}>
            {t('settings.import.file')}
          </Button>
          {fileName ? (
            <span className="font-mono text-xs text-muted-foreground">{fileName}</span>
          ) : null}
          <a
            href={TEMPLATE_URL}
            download
            className="text-sm text-brand-ink underline-offset-4 hover:underline"
          >
            {t('settings.import.template')}
          </a>
        </div>

        <div className="space-y-2">
          <Label htmlFor="import-csv-text">{t('settings.import.paste')}</Label>
          <Textarea
            id="import-csv-text"
            value={csv}
            onChange={(e) => {
              setCsv(e.target.value);
              setReport(null);
            }}
            rows={7}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => void run('dryRun')}
            disabled={running || csv.trim() === ''}
          >
            {running ? t('settings.import.importing') : t('settings.import.dryRun')}
          </Button>
          <Button
            onClick={() => void run('commit')}
            disabled={running || !allOk}
            title={allOk ? undefined : t('settings.import.dryRun')}
          >
            {t('settings.import.commit', { count: report?.ok ?? 0 })}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setOpen(false);
              setReport(null);
              setError(null);
            }}
          >
            {t('settings.wizard.back')}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">{t('settings.import.hint')}</p>

        {error ? (
          <div className="rounded-lg border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical">
            {t('settings.import.failed', { msg: error })}
          </div>
        ) : null}

        {!csv && !report ? (
          <p className="text-sm text-muted-foreground">{t('settings.import.empty')}</p>
        ) : null}

        {report && !report.committed ? (
          <div className="space-y-2">
            <p className="text-sm">
              {report.failed === 0 ? (
                <span className="text-ok">{t('settings.import.ready')}</span>
              ) : (
                t('settings.import.summary', {
                  ok: report.ok,
                  total: report.total,
                  failed: report.failed,
                })
              )}
            </p>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-3 py-2 text-start font-medium">{t('settings.import.colLine')}</th>
                    <th className="px-3 py-2 text-start font-medium">{t('settings.import.colService')}</th>
                    <th className="px-3 py-2 text-start font-medium">{t('settings.import.colStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={r.line} className="border-b last:border-0">
                      <td className="px-3 py-1.5 font-mono text-xs">{r.line}</td>
                      <td className="px-3 py-1.5">
                        <span className="font-medium">{r.name ?? '—'}</span>{' '}
                        <span className="font-mono text-xs text-muted-foreground">{r.key ?? ''}</span>
                      </td>
                      <td className="px-3 py-1.5">
                        {r.ok ? (
                          <span className="text-ok">{t('settings.import.rowOk')}</span>
                        ) : (
                          <span className="text-critical">
                            {t('settings.import.rowError', { msg: r.error ?? '' })}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.error ? (
              <div className="rounded-lg border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical">
                {t('settings.import.aborted', { msg: report.error })}
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
