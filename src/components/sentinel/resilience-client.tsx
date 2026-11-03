'use client';

// /resilience — "the system tests itself" made visible.
//
// The page renders the weekly self-test schedule, its result ledger (every
// run's MTTD/MTTR against the 60 s gate), the recent chaos experiments, and
// the live-mode chaos-hook inventory. Numbers come from GET /api/resilience
// (server-side authz — this page is only the lens) and every MTTD figure is
// the real measurement from the run, never an estimate.
//
// A run takes ~40–60 s (fault window + detection + recovery), so "Run now"
// POSTs (202) and the page polls while a run is `running`.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLang } from '@/hooks/use-language';
import type { TranslationKey } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AppShell } from '@/components/sentinel/app-shell';
import { PageHeader } from '@/components/sentinel/page-header';
import type { AppShellUser } from '@/components/sentinel/app-shell';

interface SelfTestRunRow {
  id: string;
  trigger: string;
  mode: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  mttdSec: number | null;
  mttrSec: number | null;
  gateSec: number;
  gatePassed: boolean | null;
  error: string | null;
}

interface ChaosRow {
  id: string;
  serviceId: string;
  serviceName: string;
  type: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  plannedDurationSec: number;
  mttdSec: number | null;
  mttrSec: number | null;
  gatePassed: boolean | null;
}

interface ResilienceView {
  mode: 'demo' | 'live';
  config: { enabled: boolean; hour: number; dayOfWeek: number };
  nextRunAt: string | null;
  stats: {
    lastRun: {
      id: string;
      trigger: string;
      status: string;
      startedAt: string;
      mttdSec: number | null;
      mttrSec: number | null;
      gatePassed: boolean | null;
    } | null;
    windowRuns: number;
    windowPasses: number;
    avgMttdSec: number | null;
    consecutivePasses: number;
  };
  running: { id: string; startedAt: string } | null;
  runs: SelfTestRunRow[];
  chaosExperiments: ChaosRow[];
  chaosHooks: { servicesWithHook: number; servicesTotal: number };
}

const DAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_FA = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtSec(n: number | null): string {
  return n === null || n === undefined ? '—' : `${n.toFixed(1)}s`;
}

export function ResilienceClient({ user }: { user: AppShellUser }) {
  const { t, lang } = useLang();

  const [view, setView] = useState<ResilienceView | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (): Promise<ResilienceView | null> => {
    try {
      const res = await fetch('/api/resilience', { cache: 'no-store' });
      if (!res.ok) {
        setPageError(`HTTP ${res.status}`);
        return null;
      }
      const data = (await res.json()) as ResilienceView;
      setView(data);
      setPageError(null);
      return data;
    } catch {
      setPageError('network');
      return null;
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  // Poll while a run is in flight (and briefly after starting one).
  useEffect(() => {
    const busy = view?.running !== null && view?.running !== undefined;
    if (busy && pollRef.current === null) {
      pollRef.current = setInterval(() => void load(), 5000);
    }
    if (!busy && pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [view?.running, load]);

  const showFlash = (msg: string): void => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 4000);
  };

  const runNow = async (): Promise<void> => {
    setStarting(true);
    try {
      const res = await fetch('/api/resilience', { method: 'POST' });
      if (res.status === 202) {
        showFlash(t('resilience.flash.started'));
        await load();
      } else if (res.status === 409) {
        showFlash(t('resilience.flash.alreadyRunning'));
      } else if (res.status === 403) {
        showFlash(t('resilience.flash.forbidden'));
      } else {
        showFlash(`${t('resilience.flash.error')} HTTP ${res.status}`);
      }
    } finally {
      setStarting(false);
    }
  };

  const stats = view?.stats;
  const gate = stats?.lastRun?.gatePassed;
  const lastMttd = stats?.lastRun?.mttdSec ?? null;
  const passRate = stats && stats.windowRuns > 0 ? Math.round((stats.windowPasses / stats.windowRuns) * 100) : null;

  return (
    <AppShell
      user={user}
      crumbs={[
        { label: t('crumb.home'), href: '/' },
        { label: t('resilience.title') },
      ]}
    >
      <div className="mx-auto w-full max-w-5xl">
      <PageHeader title={t('resilience.title')} description={t('resilience.desc')} />

      {flash ? (
        <div className="mt-4 rounded-[4px] border border-success/40 bg-success/10 px-3 py-2 text-sm text-success" role="status">
          {flash}
        </div>
      ) : null}
      {pageError ? (
        <div className="mt-4 rounded-[4px] border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical" role="alert">
          HTTP — {pageError}
        </div>
      ) : null}

      <div className="mt-6 space-y-6">
        {/* ── promise hero: last result against the gate ─────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between gap-3">
              <span>{t('resilience.hero.title')}</span>
              {gate === true ? (
                <Badge className="border-success/40 bg-success/10 text-success">{t('resilience.gate.pass')}</Badge>
              ) : gate === false ? (
                <Badge className="border-critical/40 bg-critical/10 text-critical">{t('resilience.gate.fail')}</Badge>
              ) : (
                <Badge variant="outline">{t('resilience.gate.noRuns')}</Badge>
              )}
            </CardTitle>
            <CardDescription>{t('resilience.hero.desc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t('resilience.metric.mttd')}</p>
                <p className="mt-1 font-mono text-xl font-semibold">{fmtSec(lastMttd)}</p>
                <p className="text-xs text-muted-foreground">{t('resilience.metric.mttdFormula')}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t('resilience.metric.mttr')}</p>
                <p className="mt-1 font-mono text-xl font-semibold">{fmtSec(stats?.lastRun?.mttrSec ?? null)}</p>
                <p className="text-xs text-muted-foreground">{t('resilience.metric.mttrFormula')}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t('resilience.metric.avgMttd')}</p>
                <p className="mt-1 font-mono text-xl font-semibold">{fmtSec(stats?.avgMttdSec ?? null)}</p>
                <p className="text-xs text-muted-foreground">{t('resilience.metric.window30')}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{t('resilience.metric.passRate')}</p>
                <p className="mt-1 font-mono text-xl font-semibold">
                  {passRate === null ? '—' : `${passRate}%`}
                  <span className="ms-1 text-xs font-normal text-muted-foreground">
                    ({stats?.windowPasses ?? 0}/{stats?.windowRuns ?? 0})
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">{t('resilience.metric.window30')}</p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>
                {t('resilience.streak')}: <span className="font-mono">{stats?.consecutivePasses ?? 0}</span>
              </span>
              <span aria-hidden>·</span>
              <span>
                {t('resilience.modeLabel')}: <span className="font-mono uppercase">{view?.mode ?? '—'}</span>
              </span>
            </div>
          </CardContent>
        </Card>

        {/* ── schedule card ──────────────────────────────────────────────── */}
        <ScheduleCard view={view} lang={lang} onChanged={load} onFlash={showFlash} onRunNow={runNow} starting={starting} t={t} />

        {/* ── runs ledger ────────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>{t('resilience.runs.title')}</CardTitle>
            <CardDescription>{t('resilience.runs.desc')}</CardDescription>
          </CardHeader>
          <CardContent>
            {view === null ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('resilience.loading')}</p>
            ) : view.runs.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('resilience.runs.empty')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pe-4">{t('resilience.runs.col.started')}</TableHead>
                    <TableHead className="pe-4">{t('resilience.runs.col.trigger')}</TableHead>
                    <TableHead className="pe-4">{t('resilience.runs.col.mode')}</TableHead>
                    <TableHead className="pe-4">{t('resilience.metric.mttd')}</TableHead>
                    <TableHead className="pe-4">{t('resilience.metric.mttr')}</TableHead>
                    <TableHead>{t('resilience.runs.col.gate')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.runs.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="pe-4 font-mono text-xs">{fmtTime(r.startedAt)}</TableCell>
                      <TableCell className="pe-4 text-xs">{t(r.trigger === 'weekly' ? 'resilience.trigger.weekly' : 'resilience.trigger.manual')}</TableCell>
                      <TableCell className="pe-4 font-mono text-xs uppercase">{r.mode}</TableCell>
                      <TableCell className="pe-4 font-mono text-xs">{fmtSec(r.mttdSec)}</TableCell>
                      <TableCell className="pe-4 font-mono text-xs">{fmtSec(r.mttrSec)}</TableCell>
                      <TableCell>
                        {r.status === 'running' ? (
                          <Badge variant="outline" className="animate-pulse">{t('resilience.status.running')}</Badge>
                        ) : r.gatePassed === true ? (
                          <Badge className="border-success/40 bg-success/10 text-success">{t('resilience.status.passed')}</Badge>
                        ) : (
                          <Badge className="border-critical/40 bg-critical/10 text-critical" title={r.error ?? undefined}>
                            {t('resilience.status.failed')}
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* ── chaos experiments ──────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>{t('resilience.chaos.title')}</CardTitle>
            <CardDescription>{t('resilience.chaos.desc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-4 rounded-[4px] border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              {view?.mode === 'live' ? (
                <>
                  {t('resilience.chaos.liveHookNote')}{' '}
                  <span className="font-mono">
                    {view.chaosHooks.servicesWithHook}/{view.chaosHooks.servicesTotal}
                  </span>{' '}
                  {t('resilience.chaos.hooksConfigured')}
                </>
              ) : (
                t('resilience.chaos.demoNote')
              )}
            </div>
            {view === null ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('resilience.loading')}</p>
            ) : view.chaosExperiments.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('resilience.chaos.empty')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pe-4">{t('resilience.runs.col.started')}</TableHead>
                    <TableHead className="pe-4">{t('resilience.chaos.col.service')}</TableHead>
                    <TableHead className="pe-4">{t('resilience.chaos.col.type')}</TableHead>
                    <TableHead className="pe-4">{t('resilience.metric.mttd')}</TableHead>
                    <TableHead>{t('resilience.runs.col.gate')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.chaosExperiments.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="pe-4 font-mono text-xs">{fmtTime(c.startedAt)}</TableCell>
                      <TableCell className="pe-4 text-xs">{c.serviceName}</TableCell>
                      <TableCell className="pe-4 font-mono text-xs">{c.type}</TableCell>
                      <TableCell className="pe-4 font-mono text-xs">{fmtSec(c.mttdSec)}</TableCell>
                      <TableCell>
                        {c.status === 'running' ? (
                          <Badge variant="outline">{t('resilience.status.running')}</Badge>
                        ) : c.gatePassed === true ? (
                          <Badge className="border-success/40 bg-success/10 text-success">{t('resilience.status.passed')}</Badge>
                        ) : c.gatePassed === false ? (
                          <Badge className="border-critical/40 bg-critical/10 text-critical">{t('resilience.status.failed')}</Badge>
                        ) : (
                          <Badge variant="outline">{c.status}</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
    </AppShell>
  );
}

// ── schedule card (admin config + engineer run-now) ─────────────────────────

type TFn = (key: TranslationKey, vars?: Record<string, string | number>) => string;

function ScheduleCard({
  view,
  lang,
  onChanged,
  onFlash,
  onRunNow,
  starting,
  t,
}: {
  view: ResilienceView | null;
  lang: 'en' | 'fa';
  onChanged: () => Promise<unknown>;
  onFlash: (msg: string) => void;
  onRunNow: () => Promise<void>;
  starting: boolean;
  t: TFn;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [hour, setHour] = useState<number>(3);
  const [dayOfWeek, setDayOfWeek] = useState<number>(5);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (view && enabled === null) {
      setEnabled(view.config.enabled);
      setHour(view.config.hour);
      setDayOfWeek(view.config.dayOfWeek);
    }
  }, [view, enabled]);

  const days = lang === 'fa' ? DAYS_FA : DAYS_EN;
  const dirty = view !== null && enabled !== null && (enabled !== view.config.enabled || hour !== view.config.hour || dayOfWeek !== view.config.dayOfWeek);

  const save = async (): Promise<void> => {
    if (enabled === null) return;
    setSaving(true);
    try {
      const res = await fetch('/api/resilience', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, hour, dayOfWeek }),
      });
      if (res.ok) {
        onFlash(t('resilience.flash.saved'));
        await onChanged();
      } else if (res.status === 403) {
        onFlash(t('resilience.flash.forbidden'));
      } else {
        onFlash(`${t('resilience.flash.error')} HTTP ${res.status}`);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>{t('resilience.schedule.title')}</CardTitle>
        <CardDescription>{t('resilience.schedule.desc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex items-center gap-2">
            <Switch
              id="selftest-enabled"
              checked={enabled ?? false}
              onCheckedChange={(v) => setEnabled(v)}
              disabled={enabled === null}
              aria-label={t('resilience.schedule.enabled')}
            />
            <Label htmlFor="selftest-enabled" className="text-sm">
              {t('resilience.schedule.enabled')}
            </Label>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{t('resilience.schedule.day')}</Label>
            <Select value={String(dayOfWeek)} onValueChange={(v) => setDayOfWeek(Number(v))}>
              <SelectTrigger className="w-[150px]" aria-label={t('resilience.schedule.day')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {days.map((d, i) => (
                  <SelectItem key={d} value={String(i)}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">{t('resilience.schedule.hour')} (UTC)</Label>
            <Input
              type="number"
              min={0}
              max={23}
              value={hour}
              onChange={(e) => setHour(Math.min(23, Math.max(0, Number(e.target.value) || 0)))}
              className="w-[90px]"
              aria-label={t('resilience.schedule.hour')}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void save()} disabled={saving || !dirty || enabled === null}>
              {t('resilience.schedule.save')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void onRunNow()} disabled={starting || view?.running !== null && view?.running !== undefined}>
              {t('resilience.schedule.runNow')}
            </Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>
            {t('resilience.schedule.next')}:{' '}
            <span className="font-mono">{view?.config.enabled ? fmtTime(view.nextRunAt) : '—'}</span>
          </span>
          {view?.running ? (
            <span className="flex items-center gap-1.5 text-warning">
              <span className="size-1.5 animate-pulse rounded-full bg-warning" aria-hidden />
              {t('resilience.schedule.runningSince')} <span className="font-mono">{fmtTime(view.running.startedAt)}</span>
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
