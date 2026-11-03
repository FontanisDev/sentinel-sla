'use client';

// /services/[key] — Shaparak/PSP transaction-profile card (
// "Shaparak/PSP-style transaction-count sources"). Shows which money source
// is live for the service — the flat tps column or an imported 168-bucket
// hour-of-week profile — and imports a new profile from a PSP/Shaparak
// hourly CSV: paste or upload → dry-run (parses, aggregates, previews the
// buckets, writes nothing, reports every rejected line) → commit
// (all-or-nothing — the server aborts when ANY row was rejected). Removing
// a profile is a confirmed destructive action that falls money back to the
// flat rate.

import { useCallback, useRef, useState } from 'react';
import { AreaChart, DatabaseZap, Trash2 } from 'lucide-react';
import { useLang } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import type { TpsProfileSummary } from '@/lib/types';

const SAMPLE = '/templates/shaparak-tx-counts-sample.csv';

interface ProfileReport {
  mode: 'dryRun' | 'commit';
  committed: boolean;
  shape: 'timestamped' | 'calendar';
  rowsUsed: number;
  rowsRejected: number;
  rejected: { line: number; reason: string }[];
  window: { from: string; to: string } | null;
  coverage: { coveredBuckets: number; of: number; percent: number };
  meanTps: number | null;
  peak: { bucket: number; tps: number } | null;
  trough: { bucket: number; tps: number } | null;
  /** The 168 aggregated buckets (dry-run preview = commit payload). */
  buckets: number[];
  error?: string;
}

/** bucket (0..167) → "Sunday 21:00" pieces; dow names come from i18n vars. */
const DAY_KEYS = [
  'tps.profile.dow.sun',
  'tps.profile.dow.mon',
  'tps.profile.dow.tue',
  'tps.profile.dow.wed',
  'tps.profile.dow.thu',
  'tps.profile.dow.fri',
  'tps.profile.dow.sat',
] as const;

export function TpsProfileCard({
  serviceKey,
  profile,
  flatTps,
  onChanged,
}: {
  serviceKey: string;
  profile: TpsProfileSummary | null;
  /** The service's flat tps column — shown even when no profile exists. */
  flatTps: number;
  onChanged: () => void;
}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState('');
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<ProfileReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const bucketLabel = useCallback(
    (bucket: number): string => {
      const dow = Math.floor(bucket / 24);
      const hour = bucket % 24;
      return `${t(DAY_KEYS[dow])} ${String(hour).padStart(2, '0')}:00`;
    },
    [t],
  );

  const run = useCallback(
    async (mode: 'dryRun' | 'commit') => {
      setRunning(true);
      setError(null);
      try {
        const res = await fetch(`/api/services/${encodeURIComponent(serviceKey)}/tps-profile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csv, mode }),
        });
        const body = (await res.json().catch(() => ({}))) as ProfileReport & { error?: string };
        if (!res.ok && typeof body.rowsUsed !== 'number') {
          setError(body.error ?? `HTTP ${res.status}`);
          return;
        }
        setReport(body);
        if (body.committed) {
          setCsv('');
          setFileName(null);
          setReport(null);
          setOpen(false);
          onChanged();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunning(false);
      }
    },
    [csv, serviceKey, onChanged],
  );

  const remove = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/services/${encodeURIComponent(serviceKey)}/tps-profile`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setOpen(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [serviceKey, onChanged]);

  const onFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setError(null);
    setReport(null);
    setCsv(await file.text());
  }, []);

  const allOk = report ? report.rowsUsed > 0 && report.rowsRejected === 0 : false;
  const active = profile?.active === true;

  return (
    <Card data-testid="tps-profile" className="gap-3 rounded-[6px] shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AreaChart className="size-4 text-warn" aria-hidden="true" />
          {t('tps.profile.title')}
          {active ? (
            <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-ok">
              {t('tps.profile.active')}
            </span>
          ) : null}
        </CardTitle>
        <CardDescription>{t('tps.profile.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ── current source ─────────────────────────────────────────── */}
        {active && profile ? (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">{t('tps.profile.mean')}</dt>
                <dd className="font-mono tabular-nums">
                  {profile.meanTps !== null
                    ? `${profile.meanTps.toFixed(2)} tx/s`
                    : t('tps.profile.notConfigured')}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('tps.profile.flat')}</dt>
                <dd className="font-mono tabular-nums">{profile.tps.toFixed(2)} tx/s</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('tps.profile.peak')}</dt>
                <dd className="font-mono tabular-nums">
                  {profile.peak
                    ? `${bucketLabel(profile.peak.bucket)} · ${profile.peak.tps.toFixed(2)}`
                    : t('tps.profile.notConfigured')}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('tps.profile.coverage')}</dt>
                <dd className="font-mono tabular-nums">
                  {profile.coveredBuckets !== null
                    ? t('tps.profile.coverageValue', {
                        covered: profile.coveredBuckets,
                        percent: Math.round((profile.coveredBuckets / 168) * 1000) / 10,
                      })
                    : t('tps.profile.notConfigured')}
                </dd>
              </div>
            </dl>
            <p className="text-xs text-muted-foreground">{t('tps.profile.activeNote')}</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('tps.profile.flatNote', { tps: flatTps.toFixed(2) })}
          </p>
        )}

        {/* ── import form (collapsed by default) ─────────────────────── */}
        {!open ? (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <DatabaseZap className="size-3.5" aria-hidden="true" />
            {t('tps.profile.import.open')}
          </Button>
        ) : (
          <div className="space-y-4 rounded-lg border p-3" data-testid="tps-import-form">
            <div className="flex flex-wrap items-center gap-3">
              <Label htmlFor="tps-import-file" className="sr-only">
                {t('tps.profile.import.file')}
              </Label>
              <input
                ref={fileRef}
                id="tps-import-file"
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => void onFile(e.target.files?.[0])}
              />
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                {t('tps.profile.import.file')}
              </Button>
              {fileName ? (
                <span className="font-mono text-xs text-muted-foreground">{fileName}</span>
              ) : null}
              <a
                href={SAMPLE}
                download
                className="text-sm text-brand-ink underline-offset-4 hover:underline"
              >
                {t('tps.profile.import.sample')}
              </a>
            </div>

            <div className="space-y-2">
              <Label htmlFor="tps-import-text">{t('tps.profile.import.paste')}</Label>
              <Textarea
                id="tps-import-text"
                value={csv}
                onChange={(e) => {
                  setCsv(e.target.value);
                  setReport(null);
                }}
                rows={7}
                spellCheck={false}
                dir="ltr"
                className="font-mono text-xs"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void run('dryRun')}
                disabled={running || csv.trim() === ''}
              >
                {running ? t('tps.profile.import.working') : t('tps.profile.import.dryRun')}
              </Button>
              <Button size="sm" onClick={() => void run('commit')} disabled={running || !allOk}>
                {t('tps.profile.import.commit')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOpen(false);
                  setReport(null);
                  setError(null);
                }}
              >
                {t('esc.cancel')}
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">{t('tps.profile.import.hint')}</p>

            {error ? (
              <div
                role="alert"
                className="rounded-lg border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical"
              >
                {t('tps.profile.import.failed', { msg: error })}
              </div>
            ) : null}

            {report && !report.committed ? (
              <div className="space-y-3" data-testid="tps-import-report">
                <p className="text-sm">
                  {allOk ? (
                    <span className="text-ok">{t('tps.profile.import.ready')}</span>
                  ) : (
                    t('tps.profile.import.summary', {
                      used: report.rowsUsed,
                      rejected: report.rowsRejected,
                    })
                  )}
                </p>
                <BucketStrip buckets={report.buckets} />
                <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('tps.profile.mean')}</dt>
                    <dd className="font-mono tabular-nums">
                      {report.meanTps !== null ? `${report.meanTps.toFixed(2)} tx/s` : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('tps.profile.peak')}</dt>
                    <dd className="font-mono tabular-nums">
                      {report.peak
                        ? `${bucketLabel(report.peak.bucket)} · ${report.peak.tps.toFixed(2)}`
                        : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('tps.profile.shape')}</dt>
                    <dd>{t(report.shape === 'calendar' ? 'tps.profile.shapeCalendar' : 'tps.profile.shapeTimestamped')}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{t('tps.profile.coverage')}</dt>
                    <dd className="font-mono tabular-nums">
                      {t('tps.profile.coverageValue', {
                        covered: report.coverage.coveredBuckets,
                        percent: report.coverage.percent,
                      })}
                    </dd>
                  </div>
                </dl>
                {report.rowsRejected > 0 ? (
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                          <th className="px-3 py-2 text-start font-medium">{t('tps.profile.import.colLine')}</th>
                          <th className="px-3 py-2 text-start font-medium">{t('tps.profile.import.colReason')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.rejected.map((r) => (
                          <tr key={r.line} className="border-b last:border-0">
                            <td className="px-3 py-1.5 font-mono text-xs">{r.line}</td>
                            <td className="px-3 py-1.5 text-critical">{r.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                {report.error ? (
                  <div className="rounded-lg border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical">
                    {t('tps.profile.import.aborted', { msg: report.error })}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        {/* ── remove (destructive, confirmed) ────────────────────────── */}
        {active ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5 text-critical hover:text-critical">
                <Trash2 className="size-3.5" aria-hidden="true" />
                {t('tps.profile.remove')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent dir="auto">
              <AlertDialogHeader>
                <AlertDialogTitle>{t('tps.profile.removeTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('tps.profile.removeDesc')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('esc.cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void remove()}>
                  {t('tps.profile.removeConfirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** 168 micro-bars, time axis left-to-right in both languages (design §9). */
function BucketStrip({ buckets }: { buckets: number[] | null }) {
  if (!buckets) return null;
  const max = Math.max(...buckets, 0.0001);
  return (
    <div dir="ltr" className="flex h-12 items-end gap-px" aria-hidden="true">
      {buckets.map((v, i) => (
        <div
          key={i}
          className="min-w-[2px] flex-1 rounded-t-[1px] bg-info/70"
          style={{ height: `${Math.max((v / max) * 100, 2)}%` }}
        />
      ))}
    </div>
  );
}
