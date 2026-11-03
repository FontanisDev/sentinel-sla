'use client';

// /alerting/rules — alerting IA: policy rules the engine evaluates every
// ~5 s against live metrics (independent of probe detection). Create, toggle,
// delete; live state shows whether a rule is violated right now.
//
// Data sources (server-enforced authz — this page is only the lens):
//   /api/rules           GET list (any signed-in) · POST create (engineer+)
//   /api/rules/import         POST { json, mode } Grafana export import (engineer+)
//   /api/rules/[id]           DELETE (engineer+)
//   /api/rules/[id]/toggle    POST { enabled } (engineer+)
//   /api/services        GET list (scope picker)
//
// Reuses the gov.rules.* vocabulary from the v2.2 governance panel.

import { useCallback, useEffect, useState } from 'react';
import { BellRing, Loader2, Trash2 } from 'lucide-react';
import { useLang } from '@/hooks/use-language';
import type { TranslationKey } from '@/lib/i18n';
import type { AlertRuleDTO, ServiceDTO } from '@/lib/types';
import { formatDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DataTable,
  type DataTableColumn,
} from '@/components/sentinel/data-table';
import { EmptyState } from '@/components/sentinel/empty-state';
import { AlertingPage } from './alerting-page';
import { ImportGrafanaCard } from './import-grafana-card';
import {
  useCreateAlertRule,
  useDeleteAlertRule,
  useToggleAlertRule,
} from '@/hooks/use-sentinel';

type Metric = AlertRuleDTO['metric'];
type Operator = AlertRuleDTO['operator'];

/** '0.995' → '99.50 %' · latency/throughput keep their unit. */
function fmtThreshold(metric: Metric, v: number): string {
  if (metric === 'uptime' || metric === 'errorRate') return `${(v * 100).toFixed(2)} %`;
  if (metric === 'latencyMs') return `${Math.round(v)} ms`;
  return `${Math.round(v)} tx/s`;
}

/** minute-of-day → 'HH:MM' (1440 = '24:00'). */
function fmtMin(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function severityTone(sev: AlertRuleDTO['severity']): string {
  return sev === 'critical'
    ? 'border-critical/40 bg-critical/10 text-critical'
    : 'border-warning/40 bg-warning/10 text-warning';
}

interface RuleForm {
  name: string;
  serviceId: string; // '__fleet__' = fleet rule
  metric: Metric;
  operator: Operator;
  threshold: string;
  severity: AlertRuleDTO['severity'];
  audience: AlertRuleDTO['audience'];
  cooldownMin: string;
  quietStart: string; // 'off' | minutes
  quietEnd: string;
}

const FLEET = '__fleet__';
const QUIET_OFF = 'off';

const EMPTY_FORM: RuleForm = {
  name: '',
  serviceId: FLEET,
  metric: 'uptime',
  operator: 'lt',
  threshold: '',
  severity: 'warning',
  audience: 'technical',
  cooldownMin: '15',
  quietStart: QUIET_OFF,
  quietEnd: QUIET_OFF,
};

export function RulesClient({
  user,
}: {
  user: { name: string; email: string; role: string; locale?: string | null };
}) {
  const { t } = useLang();
  const [rules, setRules] = useState<AlertRuleDTO[] | null>(null);
  const [services, setServices] = useState<ServiceDTO[]>([]);
  const [pageError, setPageError] = useState<string | null>(null);
  const [form, setForm] = useState<RuleForm | null>(null); // null = closed
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AlertRuleDTO | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const createRule = useCreateAlertRule();
  const toggleRule = useToggleAlertRule();
  const deleteRule = useDeleteAlertRule();

  const loadAll = useCallback(async () => {
    const [rulesRes, servicesRes] = await Promise.allSettled([
      fetch('/api/rules', { cache: 'no-store' }),
      fetch('/api/services', { cache: 'no-store' }),
    ]);
    if (rulesRes.status === 'fulfilled' && rulesRes.value.ok) {
      setRules((await rulesRes.value.json()) as AlertRuleDTO[]);
    } else {
      setRules([]);
      setPageError(
        `HTTP ${rulesRes.status === 'fulfilled' ? rulesRes.value.status : '—'}`,
      );
    }
    if (servicesRes.status === 'fulfilled' && servicesRes.value.ok) {
      const body = (await servicesRes.value.json()) as { services: ServiceDTO[] };
      setServices(body.services ?? []);
    }
  }, []);

  useEffect(() => {
    // Deferred one tick: the react-hooks lint forbids synchronous setState
    // inside effects; the interval keeps violatedNow/measured live.
    const boot = setTimeout(() => void loadAll(), 0);
    const iv = setInterval(() => void loadAll(), 15000);
    return () => {
      clearTimeout(boot);
      clearInterval(iv);
    };
  }, [loadAll]);

  const closeForm = (): void => {
    setForm(null);
    setFormError(null);
  };

  const submit = async (): Promise<void> => {
    if (!form) return;
    setFormError(null);
    const threshold = Number(form.threshold);
    if (!Number.isFinite(threshold)) {
      setFormError(t('alerting.rules.errThreshold'));
      return;
    }
    try {
      await createRule.mutateAsync({
        name: form.name,
        serviceId: form.serviceId === FLEET ? null : form.serviceId,
        metric: form.metric,
        operator: form.operator,
        threshold,
        severity: form.severity,
        audience: form.audience,
        cooldownMin: Number(form.cooldownMin) || 15,
        quietStartMin:
          form.quietStart === QUIET_OFF ? null : Number(form.quietStart),
        quietEndMin: form.quietEnd === QUIET_OFF ? null : Number(form.quietEnd),
      });
      closeForm();
      await loadAll();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  const act = async (
    rule: AlertRuleDTO,
    action: 'toggle' | 'delete',
  ): Promise<void> => {
    setBusyId(rule.id);
    try {
      if (action === 'toggle') {
        await toggleRule.mutateAsync({ id: rule.id, enabled: !rule.enabled });
      } else {
        await deleteRule.mutateAsync(rule.id);
        setPendingDelete(null);
      }
      await loadAll();
    } finally {
      setBusyId(null);
    }
  };

  const conditionText = (r: AlertRuleDTO): string =>
    `${t(`gov.rules.operator.${r.operator}` as TranslationKey)} ${fmtThreshold(r.metric, r.threshold)}`;

  const quietText = (r: AlertRuleDTO): string =>
    r.quietStartMin === null || r.quietEndMin === null
      ? '—'
      : `${fmtMin(r.quietStartMin)}–${fmtMin(r.quietEndMin)}`;

  const columns: Array<DataTableColumn<AlertRuleDTO>> = [
    {
      id: 'name',
      header: t('gov.rules.name'),
      accessor: (r) => r.name,
      cell: (r) => <span className="font-medium">{r.name}</span>,
    },
    {
      id: 'scope',
      header: t('gov.rules.scope'),
      accessor: (r) => r.serviceName ?? 'fleet',
      cell: (r) =>
        r.serviceName ? (
          <span>{r.serviceName}</span>
        ) : (
          <Badge variant="outline" className="border-line bg-raised text-muted-foreground">
            {t('gov.rules.fleetScope')}
          </Badge>
        ),
    },
    {
      id: 'condition',
      header: t('gov.rules.operator'),
      accessor: (r) => `${r.metric} ${r.operator} ${r.threshold}`,
      cell: (r) => (
        <span dir="ltr" className="font-mono text-xs">
          {r.metric} {conditionText(r)}
        </span>
      ),
    },
    {
      id: 'severity',
      header: t('gov.rules.severity'),
      accessor: (r) => r.severity,
      cell: (r) => (
        <Badge
          variant="outline"
          className={severityTone(r.severity)}
          aria-label={t(`severity.${r.severity}` as TranslationKey)}
        >
          {t(`severity.${r.severity}` as TranslationKey)}
        </Badge>
      ),
    },
    {
      id: 'audience',
      header: t('gov.rules.audience'),
      accessor: (r) => r.audience,
      cell: (r) => (
        <span className="text-xs text-muted-foreground">
          {t(`gov.rules.audience.${r.audience}` as TranslationKey)}
        </span>
      ),
    },
    {
      id: 'cooldown',
      header: t('gov.rules.cooldown'),
      numeric: true,
      accessor: (r) => r.cooldownMin,
      cell: (r) => <span className="text-xs">{t('maint.minutes', { n: r.cooldownMin })}</span>,
    },
    {
      id: 'quiet',
      header: t('alerting.rules.quiet'),
      accessor: (r) => quietText(r),
      cell: (r) => (
        <span dir="ltr" className="font-mono text-xs">
          {quietText(r)}
        </span>
      ),
    },
    {
      id: 'fired',
      header: t('alerting.rules.firedCol'),
      numeric: true,
      accessor: (r) => r.timesFired,
      cell: (r) => (
        <span
          className="text-xs"
          title={
            r.lastFiredAt
              ? t('gov.rules.lastFired', { t: formatDateTime(r.lastFiredAt) })
              : t('gov.rules.never')
          }
        >
          {t('gov.rules.fired', { n: r.timesFired })}
        </span>
      ),
    },
    {
      id: 'state',
      header: t('alerting.rules.state'),
      accessor: (r) => (r.violatedNow ? 'violating' : r.enabled ? 'ok' : 'disabled'),
      cell: (r) =>
        r.violatedNow ? (
          <Badge
            variant="outline"
            className="border-critical/40 bg-critical/10 text-critical"
            title={
              r.measuredValue !== null
                ? t('gov.rules.measured', {
                    v: fmtThreshold(r.metric, r.measuredValue),
                  })
                : undefined
            }
          >
            {t('gov.rules.violatingNow')}
          </Badge>
        ) : r.enabled ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <Badge variant="outline" className="border-line bg-raised text-muted-foreground">
            {t('alerting.rules.off')}
          </Badge>
        ),
    },
    {
      id: 'enabled',
      header: t('alerting.rules.enabled'),
      accessor: (r) => (r.enabled ? '1' : '0'),
      cell: (r) => (
        <Switch
          checked={r.enabled}
          disabled={busyId === r.id}
          aria-label={`${t('alerting.rules.enabled')}: ${r.name}`}
          onClick={(e) => {
            e.stopPropagation();
            void act(r, 'toggle');
          }}
        />
      ),
    },
    {
      id: 'actions',
      header: '',
      locked: true,
      cell: (r) => (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-muted-foreground hover:text-critical"
          disabled={busyId === r.id}
          aria-label={`${t('gov.rules.deleteConfirmTitle')} ${r.name}`}
          onClick={() => setPendingDelete(r)}
        >
          {busyId === r.id ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Trash2 className="size-4" />
          )}
        </Button>
      ),
    },
  ];

  const quietOptions = (kind: 'start' | 'end'): Array<{ value: string; label: string }> => {
    const out: Array<{ value: string; label: string }> = [
      { value: QUIET_OFF, label: t('alerting.rules.off') },
    ];
    if (kind === 'start') {
      for (let m = 0; m <= 1425; m += 15) out.push({ value: String(m), label: fmtMin(m) });
    } else {
      for (let m = 15; m <= 1440; m += 15) out.push({ value: String(m), label: fmtMin(m) });
    }
    return out;
  };

  return (
    <AlertingPage
      user={user}
      active="rules"
      title={t('gov.rules.title')}
      description={t('gov.rules.desc')}
    >
      {pageError ? (
        <div
          className="rounded-[4px] border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical"
          role="alert"
        >
          HTTP — {pageError}
        </div>
      ) : null}

      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="text-base">{t('gov.rules.title')}</CardTitle>
            <CardDescription>{t('gov.rules.desc')}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ImportGrafanaCard onImported={() => void loadAll()} />
            <Button size="sm" onClick={() => setForm({ ...EMPTY_FORM })} disabled={form !== null}>
              {t('gov.rules.create')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            rows={rules ?? []}
            rowKey={(r) => r.id}
            ariaLabel={t('gov.rules.title')}
            searchAccessor={(r) => `${r.name} ${r.serviceName ?? ''} ${r.metric} ${r.severity}`}
            csvFileName="alert-rules.csv"
            empty={
              <EmptyState
                icon={BellRing}
                title={t('gov.rules.empty.title')}
                description={t('gov.rules.empty.desc')}
              />
            }
          />
        </CardContent>
      </Card>

      {/* ── create dialog ─────────────────────────────────────────────── */}
      <Dialog open={form !== null} onOpenChange={(open) => (open ? null : closeForm())}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('gov.rules.create')}</DialogTitle>
            <DialogDescription>{t('gov.rules.empty.desc')}</DialogDescription>
          </DialogHeader>
          {form ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="rule-name">{t('gov.rules.name')}</Label>
                <Input
                  id="rule-name"
                  value={form.name}
                  placeholder={t('gov.rules.namePh')}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="rule-scope">{t('gov.rules.scope')}</Label>
                  <Select value={form.serviceId} onValueChange={(v) => setForm({ ...form, serviceId: v })}>
                    <SelectTrigger id="rule-scope" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={FLEET}>{t('gov.rules.fleet')}</SelectItem>
                      {services.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rule-metric">{t('gov.rules.metric')}</Label>
                  <Select value={form.metric} onValueChange={(v) => setForm({ ...form, metric: v as Metric })}>
                    <SelectTrigger id="rule-metric" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(['uptime', 'errorRate', 'latencyMs', 'throughput'] as const).map((m) => (
                        <SelectItem key={m} value={m}>
                          {t(`gov.rules.metric.${m}` as TranslationKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rule-operator">{t('gov.rules.operator')}</Label>
                  <Select
                    value={form.operator}
                    onValueChange={(v) => setForm({ ...form, operator: v as Operator })}
                  >
                    <SelectTrigger id="rule-operator" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="lt">{t('gov.rules.operator.lt')}</SelectItem>
                      <SelectItem value="gt">{t('gov.rules.operator.gt')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rule-threshold">{t('gov.rules.threshold')}</Label>
                  <Input
                    id="rule-threshold"
                    type="number"
                    step="any"
                    dir="ltr"
                    value={form.threshold}
                    placeholder={
                      form.metric === 'uptime' || form.metric === 'errorRate' ? '0.995' : '800'
                    }
                    onChange={(e) => setForm({ ...form, threshold: e.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    {form.metric === 'uptime' || form.metric === 'errorRate'
                      ? t('alerting.rules.hintRatio')
                      : t('alerting.rules.hintPlain')}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rule-severity">{t('gov.rules.severity')}</Label>
                  <Select
                    value={form.severity}
                    onValueChange={(v) => setForm({ ...form, severity: v as RuleForm['severity'] })}
                  >
                    <SelectTrigger id="rule-severity" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="warning">{t('severity.warning')}</SelectItem>
                      <SelectItem value="critical">{t('severity.critical')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rule-audience">{t('gov.rules.audience')}</Label>
                  <Select
                    value={form.audience}
                    onValueChange={(v) => setForm({ ...form, audience: v as RuleForm['audience'] })}
                  >
                    <SelectTrigger id="rule-audience" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="technical">{t('gov.rules.audience.technical')}</SelectItem>
                      <SelectItem value="executive">{t('gov.rules.audience.executive')}</SelectItem>
                      <SelectItem value="both">{t('gov.rules.audience.both')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rule-cooldown">{t('gov.rules.cooldown')}</Label>
                  <Input
                    id="rule-cooldown"
                    type="number"
                    min={1}
                    max={1440}
                    dir="ltr"
                    value={form.cooldownMin}
                    onChange={(e) => setForm({ ...form, cooldownMin: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rule-quiet-start">{t('alerting.rules.quiet')}</Label>
                  <Select value={form.quietStart} onValueChange={(v) => setForm({ ...form, quietStart: v })}>
                    <SelectTrigger id="rule-quiet-start" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {quietOptions('start').map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="rule-quiet-end">{t('alerting.rules.quietEnd')}</Label>
                  <Select value={form.quietEnd} onValueChange={(v) => setForm({ ...form, quietEnd: v })}>
                    <SelectTrigger id="rule-quiet-end" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {quietOptions('end').map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {formError ? (
                <p
                  role="alert"
                  className="rounded-[4px] border border-critical/40 bg-critical/10 px-3 py-2 text-xs text-critical"
                >
                  {formError}
                </p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={closeForm}>
              {t('esc.cancel')}
            </Button>
            <Button onClick={() => void submit()} disabled={createRule.isPending}>
              {createRule.isPending ? '…' : t('gov.rules.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── delete confirm (names the object) ─────────────────────────── */}
      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => (open ? null : setPendingDelete(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('gov.rules.deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('gov.rules.deleteConfirmDesc')}
              {pendingDelete ? (
                <span className="mt-2 block font-medium text-foreground">{pendingDelete.name}</span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('esc.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-critical text-white hover:bg-critical/90"
              onClick={() => pendingDelete && void act(pendingDelete, 'delete')}
            >
              {t('gov.rules.deleteConfirmTitle')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AlertingPage>
  );
}
