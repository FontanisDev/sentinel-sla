'use client';

// /alerting/rules — Grafana alert-rule import card (integrations:
// "Grafana/Zabbix alert import"). Paste or upload the JSON export of Grafana
// unified alerting → dry-run (maps every rule onto Sentinel's four metrics,
// writes nothing, reports unmapped rules with the exact reason) → commit
// (all-or-nothing — the server aborts if ANY rule did not map). After a
// successful commit the parent refreshes the registry so the new rules join
// the engine's tick evaluation immediately.

import { useCallback, useRef, useState } from 'react';
import { useLang } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface ImportRowResult {
  index: number;
  title?: string;
  ok: boolean;
  error?: string;
  rule?: {
    name: string;
    metric: string;
    operator: string;
    threshold: number;
    severity: string;
    cooldownMin?: number;
    serviceLabel?: string;
    notes?: string[];
  };
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

const SAMPLES = {
  grafana: '/templates/grafana-alerts-sample.json',
  zabbix: '/templates/zabbix-triggers-sample.json',
} as const;

export function ImportGrafanaCard({ onImported }: { onImported: () => void }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<'grafana' | 'zabbix'>('grafana');
  const [json, setJson] = useState('');
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
        const res = await fetch('/api/rules/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ json, mode, source }),
        });
        const body = (await res.json().catch(() => ({}))) as ImportReport & { error?: string };
        if (!res.ok && typeof body.total !== 'number') {
          setError(body.error ?? `HTTP ${res.status}`);
          return;
        }
        setReport(body);
        if (body.committed) {
          setJson('');
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
    [json, source, onImported],
  );

  const onFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setError(null);
    setReport(null);
    const text = await file.text();
    setJson(text);
  }, []);

  const allOk = report ? report.total > 0 && report.failed === 0 : false;

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t('alerting.import.open')}
      </Button>
    );
  }

  return (
    <Card data-testid="import-grafana">
      <CardHeader>
        <CardTitle className="text-base">{t('alerting.import.title')}</CardTitle>
        <CardDescription>{t('alerting.import.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-xs space-y-2">
          <Label htmlFor="import-rules-source">{t('alerting.import.sourceLabel')}</Label>
          <Select
            value={source}
            onValueChange={(v) => {
              setSource(v === 'zabbix' ? 'zabbix' : 'grafana');
              setReport(null);
              setFileName(null);
              setJson('');
            }}
          >
            <SelectTrigger id="import-rules-source" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="grafana">{t('alerting.import.sourceGrafana')}</SelectItem>
              <SelectItem value="zabbix">{t('alerting.import.sourceZabbix')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Label htmlFor="import-grafana-file" className="sr-only">
            {t('alerting.import.file')}
          </Label>
          <input
            ref={fileRef}
            id="import-grafana-file"
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          <Button variant="outline" onClick={() => fileRef.current?.click()}>
            {t('alerting.import.file')}
          </Button>
          {fileName ? (
            <span className="font-mono text-xs text-muted-foreground">{fileName}</span>
          ) : null}
          <a
            href={SAMPLES[source]}
            download
            className="text-sm text-brand-ink underline-offset-4 hover:underline"
          >
            {t('alerting.import.sample')}
          </a>
        </div>

        <div className="space-y-2">
          <Label htmlFor="import-grafana-text">{t('alerting.import.paste')}</Label>
          <Textarea
            id="import-grafana-text"
            value={json}
            onChange={(e) => {
              setJson(e.target.value);
              setReport(null);
            }}
            rows={8}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => void run('dryRun')}
            disabled={running || json.trim() === ''}
          >
            {running ? t('alerting.import.working') : t('alerting.import.dryRun')}
          </Button>
          <Button
            onClick={() => void run('commit')}
            disabled={running || !allOk}
            title={allOk ? undefined : t('alerting.import.dryRun')}
          >
            {t('alerting.import.commit', { count: report?.ok ?? 0 })}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setOpen(false);
              setReport(null);
              setError(null);
            }}
          >
            {t('esc.cancel')}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">{t('alerting.import.hint')}</p>

        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical"
          >
            {t('alerting.import.failed', { msg: error })}
          </div>
        ) : null}

        {!json && !report ? (
          <p className="text-sm text-muted-foreground">{t('alerting.import.empty')}</p>
        ) : null}

        {report && !report.committed ? (
          <div className="space-y-2">
            <p className="text-sm">
              {report.failed === 0 ? (
                <span className="text-ok">{t('alerting.import.ready')}</span>
              ) : (
                t('alerting.import.summary', {
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
                    <th className="px-3 py-2 text-start font-medium">{t('alerting.import.colRule')}</th>
                    <th className="px-3 py-2 text-start font-medium">{t('alerting.import.colMaps')}</th>
                    <th className="px-3 py-2 text-start font-medium">{t('alerting.import.colStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={r.index} className="border-b last:border-0 align-top">
                      <td className="px-3 py-1.5">
                        <span className="font-medium">{r.rule?.name ?? r.title ?? '—'}</span>
                      </td>
                      <td className="px-3 py-1.5 font-mono text-xs">
                        {r.rule
                          ? `${r.rule.metric} ${r.rule.operator} ${r.rule.threshold}`
                          : '—'}
                      </td>
                      <td className="px-3 py-1.5">
                        {r.ok ? (
                          <span className="text-ok">{t('alerting.import.rowOk')}</span>
                        ) : (
                          <span className="text-critical">{r.error}</span>
                        )}
                        {r.rule && r.rule.notes && r.rule.notes.length > 0 ? (
                          <ul className="mt-1 list-disc space-y-0.5 ps-4 text-xs text-muted-foreground">
                            {r.rule.notes.map((n, i) => (
                              <li key={i}>{n}</li>
                            ))}
                          </ul>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.error ? (
              <div className="rounded-lg border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical">
                {t('alerting.import.aborted', { msg: report.error })}
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
