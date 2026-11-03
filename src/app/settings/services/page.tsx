'use client';

// /settings/services — service registry + onboarding wizard.
//
// The wizard walks identity → signal source → preview → money/SLA and posts
// to /api/services (probe source included). The preview step exercises
// POST /api/services/preview (a 1-hour range query against the configured
// Prometheus); when no connection is saved it shows setup guidance instead
// of pretending. Alertmanager sources cannot be polled — the preview states
// that plainly rather than fabricating a chart.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLang } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sparkline } from '@/components/sentinel/sparkline';
import { SettingsNav } from '@/components/sentinel/settings-nav';
import { ImportCsvCard } from '@/components/sentinel/settings/import-csv-card';
import { CONTRACT_TEMPLATES, findContractTemplate } from '@/lib/contract-templates';
import { SERVICE_STATUS } from '@/components/sentinel/status';
import type { TranslationKey } from '@/lib/i18n';
import type { ProbeSourceDTO, ServiceDTO, TenantDTO } from '@/lib/types';

type SourceKind = 'blackbox' | 'promql' | 'alertmanager';

interface RangePoint {
  tsMs: number;
  value: number;
}

interface ProbePreview {
  kind: SourceKind;
  query: string;
  windowMinutes: number;
  series: RangePoint[];
  okRatio: number | null;
  lastValue: number | null;
  note: string | null;
}

const STEPS = ['step1', 'step2', 'step3', 'step4'] as const;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function probeSummary(source: ProbeSourceDTO | null): { key: 'blackbox' | 'promql' | 'alertmanager' | 'synthetic' | 'none'; label: string } {
  if (!source) return { key: 'none', label: '' };
  if (source.kind === 'blackbox') return { key: 'blackbox', label: source.job };
  if (source.kind === 'promql') return { key: 'promql', label: '' };
  if (source.kind === 'synthetic') return { key: 'synthetic', label: 'selftest' };
  return { key: 'alertmanager', label: source.alert };
}

export default function ServicesSettingsPage() {
  const { t, lang } = useLang();

  // registry
  const [services, setServices] = useState<ServiceDTO[]>([]);
  const [tenants, setTenants] = useState<TenantDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // wizard open + fields
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [nameFa, setNameFa] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [tier, setTier] = useState('tier-2');
  const [tenantId, setTenantId] = useState<string>('none');
  const [endpoint, setEndpoint] = useState('');
  const [sourceKind, setSourceKind] = useState<SourceKind>('blackbox');
  const [job, setJob] = useState('');
  const [instance, setInstance] = useState('');
  const [good, setGood] = useState('');
  const [total, setTotal] = useState('');
  const [alert, setAlert] = useState('');
  const [matcher, setMatcher] = useState('');

  // preview
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<ProbePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  // money & creation
  const [tps, setTps] = useState('50');
  const [ticket, setTicket] = useState('250000');
  const [slaTarget, setSlaTarget] = useState('0.999');
  const [penaltyBase, setPenaltyBase] = useState('50000000');
  const [penaltyPerMinute, setPenaltyPerMinute] = useState('7500000');
  // contract template library : pre-fills the money/SLA fields
  // from a common Iranian fintech contract shape; 'none' = custom terms.
  const [templateKey, setTemplateKey] = useState('none');
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [svcRes, tenRes] = await Promise.all([
        fetch('/api/services', { cache: 'no-store' }),
        fetch('/api/tenants', { cache: 'no-store' }).catch(() => null),
      ]);
      if (!svcRes.ok) {
        setLoadError(`HTTP ${svcRes.status}`);
        return;
      }
      const data = (await svcRes.json()) as { services: ServiceDTO[] };
      setServices(data.services);
      if (tenRes && tenRes.ok) {
        const tData = (await tenRes.json()) as TenantDTO[];
        setTenants(Array.isArray(tData) ? tData : []);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resetWizard = () => {
    setStep(0);
    setName('');
    setNameFa('');
    setKey('');
    setKeyTouched(false);
    setTier('tier-2');
    setTenantId('none');
    setEndpoint('');
    setTemplateKey('none');
    setSourceKind('blackbox');
    setJob('');
    setInstance('');
    setGood('');
    setTotal('');
    setAlert('');
    setMatcher('');
    setPreview(null);
    setPreviewError(null);
    setNotConfigured(false);
    setCreateMsg(null);
  };

  const step1Valid = name.trim().length >= 2 && key.trim().length >= 2;
  const step2Valid =
    sourceKind === 'blackbox'
      ? job.trim().length > 0
      : sourceKind === 'promql'
        ? good.trim().length > 0 && total.trim().length > 0
        : alert.trim().length > 0;
  const step4Valid =
    Number(tps) > 0 && Number(ticket) > 0 && Number(slaTarget) > 0 && Number(slaTarget) < 1 &&
    Number(penaltyBase) > 0 && Number(penaltyPerMinute) > 0;

  /** Pick a contract template → pre-fill the three money/SLA fields. */
  const applyTemplate = (nextKey: string) => {
    setTemplateKey(nextKey);
    const tpl = findContractTemplate(nextKey);
    if (!tpl) return; // 'none' — keep whatever the operator typed
    setSlaTarget(String(tpl.terms.slaTarget));
    setPenaltyBase(String(tpl.terms.penaltyBase));
    setPenaltyPerMinute(String(tpl.terms.penaltyPerMinute));
  };

  const selectedTemplate = findContractTemplate(templateKey);

  const canNext = step === 0 ? step1Valid : step === 1 ? step2Valid : step === 2 ? true : step4Valid;

  const buildProbeSource = (): ProbeSourceDTO | undefined => {
    if (sourceKind === 'blackbox') {
      return instance.trim()
        ? { kind: 'blackbox', job: job.trim(), instance: instance.trim() }
        : { kind: 'blackbox', job: job.trim() };
    }
    if (sourceKind === 'promql') {
      return { kind: 'promql', good: good.trim(), total: total.trim() };
    }
    return matcher.trim()
      ? { kind: 'alertmanager', alert: alert.trim(), matcher: matcher.trim() }
      : { kind: 'alertmanager', alert: alert.trim() };
  };

  const runPreview = async () => {
    setPreviewing(true);
    setPreviewError(null);
    setNotConfigured(false);
    setPreview(null);
    try {
      const res = await fetch('/api/services/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          probeSource: buildProbeSource(),
          endpoint: endpoint.trim() || undefined,
          slaTarget: Number(slaTarget) || undefined,
          tenantId: tenantId !== 'none' ? tenantId : undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { preview?: ProbePreview; error?: string };
      if (!res.ok) {
        if (String(body.error ?? '').includes('prometheus-not-configured')) {
          setNotConfigured(true);
        } else {
          setPreviewError(body.error ?? `HTTP ${res.status}`);
        }
        return;
      }
      if (body.preview) setPreview(body.preview);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  };

  const create = async () => {
    setCreating(true);
    setCreateMsg(null);
    try {
      const res = await fetch('/api/services', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: key.trim(),
          name: name.trim(),
          nameFa: nameFa.trim() || undefined,
          tier,
          tenantId: tenantId !== 'none' ? tenantId : undefined,
          endpoint: endpoint.trim() || undefined,
          tps: Number(tps),
          avgTransactionValue: Number(ticket),
          slaTarget: Number(slaTarget),
          penaltyBase: Number(penaltyBase),
          penaltyPerMinute: Number(penaltyPerMinute),
          probeSource: buildProbeSource(),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setCreateMsg({ ok: false, text: t('settings.wizard.createFailed', { msg: body.error ?? `HTTP ${res.status}` }) });
        return;
      }
      setCreateMsg({ ok: true, text: t('settings.wizard.created') });
      setOpen(false);
      resetWizard();
      await load();
    } catch (err) {
      setCreateMsg({ ok: false, text: t('settings.wizard.createFailed', { msg: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setCreating(false);
    }
  };

  const previewValues = useMemo(() => preview?.series.map((p) => p.value) ?? [], [preview]);

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
      <SettingsNav active="services" />
      <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('settings.services.title')}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('settings.services.desc')}</p>
        </div>
        <Button
          onClick={() => {
            resetWizard();
            setOpen(true);
          }}
        >
          {t('settings.services.add')}
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <ImportCsvCard onImported={() => void load()} />
      </div>

      {createMsg && !createMsg.ok ? (
        <div className="mt-4 rounded-lg border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical">
          {createMsg.text}
        </div>
      ) : null}

      {/* ── registry table ─────────────────────────────────────────────────── */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">{t('settings.services.title')}</CardTitle>
          <CardDescription>
            {loading ? '…' : `${services.length}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <div className="rounded-lg border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical">
              HTTP — {loadError}
            </div>
          ) : !loading && services.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('settings.services.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-start text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="py-2 pe-4 text-start font-medium">{t('settings.services.col.service')}</th>
                    <th className="py-2 pe-4 text-start font-medium">{t('settings.services.col.tenant')}</th>
                    <th className="py-2 pe-4 text-start font-medium">{t('settings.services.col.tier')}</th>
                    <th className="py-2 pe-4 text-start font-medium">{t('settings.services.col.status')}</th>
                    <th className="py-2 pe-4 text-start font-medium">{t('settings.services.col.live')}</th>
                    <th className="py-2 text-start font-medium">{t('settings.services.col.probe')}</th>
                  </tr>
                </thead>
                <tbody>
                  {services.map((s) => {
                    const style = SERVICE_STATUS[s.status];
                    const probe = probeSummary(s.probeSource);
                    const liveLabel =
                      s.liveStatus === 'up'
                        ? t('settings.live.up')
                        : s.liveStatus === 'down'
                          ? t('settings.live.down')
                          : s.liveStatus === 'stale'
                            ? t('settings.live.stale')
                            : t('settings.live.none');
                    const liveTone =
                      s.liveStatus === 'up'
                        ? 'text-ok'
                        : s.liveStatus === 'down'
                          ? 'text-critical'
                          : s.liveStatus === 'stale'
                            ? 'text-warning'
                            : 'text-muted-foreground';
                    return (
                      <tr key={s.id} className="border-b last:border-0">
                        <td className="py-2.5 pe-4">
                          <div className="font-medium">{lang === 'fa' && s.nameFa ? s.nameFa : s.name}</div>
                          <div className="font-mono text-xs text-muted-foreground">{s.key}</div>
                        </td>
                        <td className="py-2.5 pe-4 text-muted-foreground">{s.tenantName ?? t('settings.live.none')}</td>
                        <td className="py-2.5 pe-4">
                          <span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-xs">
                            {s.tier}
                          </span>
                        </td>
                        <td className="py-2.5 pe-4">
                          <span className={style.chip + ' inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs'}>
                            <span className={'size-1.5 rounded-full ' + style.dot} />
                            {t(style.label)}
                          </span>
                        </td>
                        <td className={'py-2.5 pe-4 text-xs font-semibold ' + liveTone}>{liveLabel}</td>
                        <td className="py-2.5 text-xs text-muted-foreground">
                          {probe.key === 'none' ? (
                            t('settings.probe.none')
                          ) : probe.key === 'promql' ? (
                            t('settings.probe.promql')
                          ) : probe.key === 'blackbox' ? (
                            t('settings.probe.blackbox', { job: probe.label })
                          ) : probe.key === 'synthetic' ? (
                            t('settings.probe.synthetic')
                          ) : (
                            t('settings.probe.alertmanager', { alert: probe.label })
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── wizard ─────────────────────────────────────────────────────────── */}
      {open ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">{t('settings.wizard.title')}</CardTitle>
            <CardDescription className="flex flex-wrap gap-1.5">
              {STEPS.map((s, i) => (
                <span
                  key={s}
                  className={
                    'rounded-full border px-2 py-0.5 text-xs ' +
                    (i === step
                      ? 'border-primary/40 bg-primary/10 text-brand-ink'
                      : i < step
                        ? 'border-success/40 bg-success/10 text-success'
                        : 'border-border bg-muted/40 text-muted-foreground')
                  }
                >
                  {i + 1}. {t(('settings.wizard.' + s) as TranslationKey)}
                </span>
              ))}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {step === 0 ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="w-name">{t('settings.wizard.name')}</Label>
                  <Input
                    id="w-name"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      if (!keyTouched) setKey(slugify(e.target.value));
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="w-namefa">{t('settings.wizard.nameFa')}</Label>
                  <Input id="w-namefa" value={nameFa} onChange={(e) => setNameFa(e.target.value)} dir="rtl" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="w-key">{t('settings.wizard.key')}</Label>
                  <Input
                    id="w-key"
                    value={key}
                    onChange={(e) => {
                      setKeyTouched(true);
                      setKey(e.target.value);
                    }}
                    className="font-mono"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="w-tier">{t('settings.wizard.tier')}</Label>
                  <Select value={tier} onValueChange={setTier}>
                    <SelectTrigger id="w-tier">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tier-1">tier-1</SelectItem>
                      <SelectItem value="tier-2">tier-2</SelectItem>
                      <SelectItem value="tier-3">tier-3</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="w-tenant">{t('settings.wizard.tenant')}</Label>
                  <Select value={tenantId} onValueChange={setTenantId}>
                    <SelectTrigger id="w-tenant">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t('settings.wizard.tenantNone')}</SelectItem>
                      {tenants.map((tn) => (
                        <SelectItem key={tn.id} value={tn.id}>
                          {lang === 'fa' && tn.nameFa ? tn.nameFa : tn.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="w-endpoint">{t('settings.wizard.endpoint')}</Label>
                  <Input id="w-endpoint" placeholder="https://api.example.ir/health" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
                </div>
              </div>
            ) : null}

            {step === 1 ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>{t('settings.wizard.sourceKind')}</Label>
                  <div className="grid gap-2">
                    {(
                      [
                        ['blackbox', 'settings.wizard.source.blackbox', 'settings.wizard.source.blackboxDesc'],
                        ['promql', 'settings.wizard.source.promql', 'settings.wizard.source.promqlDesc'],
                        ['alertmanager', 'settings.wizard.source.alertmanager', 'settings.wizard.source.alertmanagerDesc'],
                      ] as const
                    ).map(([kind, label, desc]) => (
                      <label
                        key={kind}
                        className={
                          'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ' +
                          (sourceKind === kind ? 'border-primary/50 bg-primary/5' : 'border-border hover:bg-muted/30')
                        }
                      >
                        <input
                          type="radio"
                          name="source-kind"
                          className="mt-1 accent-primary"
                          checked={sourceKind === kind}
                          onChange={() => setSourceKind(kind)}
                        />
                        <span>
                          <span className="block text-sm font-medium">{t(label)}</span>
                          <span className="block text-xs text-muted-foreground">{t(desc)}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                {sourceKind === 'blackbox' ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="w-job">{t('settings.wizard.job')}</Label>
                      <Input id="w-job" value={job} onChange={(e) => setJob(e.target.value)} className="font-mono" placeholder="blackbox.http" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="w-instance">{t('settings.wizard.instance')}</Label>
                      <Input id="w-instance" value={instance} onChange={(e) => setInstance(e.target.value)} className="font-mono" />
                    </div>
                  </div>
                ) : null}

                {sourceKind === 'promql' ? (
                  <div className="grid gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="w-good">{t('settings.wizard.good')}</Label>
                      <Input id="w-good" value={good} onChange={(e) => setGood(e.target.value)} className="font-mono" placeholder='sum(rate(http_requests_total{job="api", code!~"5.."}[5m]))' />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="w-total">{t('settings.wizard.total')}</Label>
                      <Input id="w-total" value={total} onChange={(e) => setTotal(e.target.value)} className="font-mono" placeholder='sum(rate(http_requests_total{job="api"}[5m]))' />
                    </div>
                  </div>
                ) : null}

                {sourceKind === 'alertmanager' ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="w-alert">{t('settings.wizard.alert')}</Label>
                      <Input id="w-alert" value={alert} onChange={(e) => setAlert(e.target.value)} className="font-mono" placeholder="ServiceDown" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="w-matcher">{t('settings.wizard.matcher')}</Label>
                      <Input id="w-matcher" value={matcher} onChange={(e) => setMatcher(e.target.value)} className="font-mono" placeholder='service="api"' />
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {step === 2 ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" onClick={() => void runPreview()} disabled={previewing}>
                    {previewing ? t('settings.wizard.previewing') : t('settings.wizard.preview')}
                  </Button>
                  {preview && preview.note !== 'webhook-driven' ? (
                    <span className="text-xs text-muted-foreground">
                      {t('settings.wizard.preview.samples')}: {preview.series.length} ·{' '}
                      {t('settings.wizard.preview.okRatio')}: {preview.okRatio === null ? '—' : `${Math.round((preview.okRatio ?? 0) * 100)}%`} ·{' '}
                      {t('settings.wizard.preview.last')}: {preview.lastValue === null ? '—' : preview.lastValue}
                    </span>
                  ) : null}
                </div>

                {notConfigured ? (
                  <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
                    {t('settings.wizard.preview.notConfigured')}
                  </div>
                ) : null}

                {previewError ? (
                  <div className="rounded-lg border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical">
                    {t('settings.wizard.preview.failed', { msg: previewError })}
                  </div>
                ) : null}

                {preview && preview.note === 'webhook-driven' ? (
                  <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                    <p>{t('settings.wizard.preview.alertmanagerNote')}</p>
                    <p className="mt-1 font-mono text-xs">{t('settings.wizard.preview.query')}: {preview.query}</p>
                  </div>
                ) : null}

                {preview && preview.note !== 'webhook-driven' ? (
                  preview.series.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('settings.wizard.preview.noData')}</p>
                  ) : (
                    <div className="space-y-2">
                      <div className="h-24">
                        <Sparkline values={previewValues} color="#38bdf8" className="h-24" />
                      </div>
                      <p className="font-mono text-xs text-muted-foreground">
                        {t('settings.wizard.preview.query')}: {preview.query}
                      </p>
                    </div>
                  )
                ) : null}
              </div>
            ) : null}

            {step === 3 ? (
              <div className="space-y-4">
              {/* contract template library : pre-fill from a
                  common Iranian fintech SLA shape — example values only. */}
              <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                <Label htmlFor="w-template">{t('settings.wizard.template')}</Label>
                <Select value={templateKey} onValueChange={applyTemplate}>
                  <SelectTrigger id="w-template">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('settings.wizard.templateNone')}</SelectItem>
                    {CONTRACT_TEMPLATES.map((tpl) => (
                      <SelectItem key={tpl.key} value={tpl.key}>
                        {lang === 'fa' ? tpl.nameFa : tpl.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedTemplate ? (
                  <p className="text-xs text-muted-foreground">
                    {lang === 'fa' ? selectedTemplate.descFa : selectedTemplate.desc}
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">{t('settings.wizard.templateNote')}</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="w-tps">{t('settings.wizard.tps')}</Label>
                  <Input id="w-tps" type="number" min="0" value={tps} onChange={(e) => setTps(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="w-ticket">{t('settings.wizard.ticket')}</Label>
                  <Input id="w-ticket" type="number" min="0" value={ticket} onChange={(e) => setTicket(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="w-sla">{t('settings.wizard.slaTarget')}</Label>
                  <Input id="w-sla" type="number" min="0" max="1" step="0.0001" value={slaTarget} onChange={(e) => setSlaTarget(e.target.value)} />
                </div>
                <div className="space-y-2" />
                <div className="space-y-2">
                  <Label htmlFor="w-pbase">{t('settings.wizard.penaltyBase')}</Label>
                  <Input id="w-pbase" type="number" min="0" value={penaltyBase} onChange={(e) => setPenaltyBase(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="w-ppermin">{t('settings.wizard.penaltyPerMinute')}</Label>
                  <Input id="w-ppermin" type="number" min="0" value={penaltyPerMinute} onChange={(e) => setPenaltyPerMinute(e.target.value)} />
                </div>
              </div>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => (step === 0 ? setOpen(false) : setStep(step - 1))} disabled={creating}>
                  {step === 0 ? t('settings.wizard.back') : t('settings.wizard.back')}
                </Button>
              </div>
              <div className="flex gap-2">
                {step < 3 ? (
                  <Button onClick={() => setStep(step + 1)} disabled={!canNext}>
                    {t('settings.wizard.next')}
                  </Button>
                ) : (
                  <Button onClick={() => void create()} disabled={creating || !step4Valid}>
                    {creating ? t('settings.wizard.creating') : t('settings.wizard.create')}
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </main>
  );
}
