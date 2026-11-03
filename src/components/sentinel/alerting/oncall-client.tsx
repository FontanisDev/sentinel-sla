'use client';

// /alerting/oncall — alerting IA: who carries the pager (weekly rotation
// with live "on duty" state) and the fleet escalation ladder (unacked
// incidents page the next tier after the timeout).
//
// Data sources (server-enforced authz — this page is only the lens):
//   /api/oncall       GET list (any signed-in) · POST create (engineer+) ·
//                     DELETE /api/oncall/[id] (engineer+)
//   /api/escalation   GET policy (any signed-in) · PUT edit (engineer+)

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Users } from 'lucide-react';
import { useLang } from '@/hooks/use-language';
import type { TranslationKey } from '@/lib/i18n';
import type { EscalationPolicyDTO, OnCallEntryDTO } from '@/lib/types';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/sentinel/empty-state';
import { AlertingPage } from './alerting-page';
import {
  useCreateOnCall,
  useDeleteOnCall,
  useUpdateEscalationPolicy,
} from '@/hooks/use-sentinel';

/** minute-of-day → 'HH:MM'. */
function fmtMin(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** '09:00' → 540. */
function parseMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((p) => Number(p));
  return h * 60 + (m || 0);
}

interface OnCallForm {
  engineerName: string;
  role: string;
  handle: string;
  dayOfWeek: string;
  start: string; // HH:MM
  end: string;
}

const EMPTY_FORM: OnCallForm = {
  engineerName: '',
  role: 'Primary',
  handle: '',
  dayOfWeek: '0',
  start: '09:00',
  end: '18:00',
};

export function OncallClient({
  user,
}: {
  user: { name: string; email: string; role: string; locale?: string | null };
}) {
  const { t } = useLang();
  const [entries, setEntries] = useState<OnCallEntryDTO[] | null>(null);
  const [policy, setPolicy] = useState<EscalationPolicyDTO | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  const [form, setForm] = useState<OnCallForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<OnCallEntryDTO | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // escalation editor state (hydrated from the fetched policy)
  const [timeoutMin, setTimeoutMin] = useState('10');
  const [appliesTo, setAppliesTo] = useState<'critical' | 'all'>('critical');
  const [armed, setArmed] = useState(true);
  const [escSaving, setEscSaving] = useState(false);
  const [escError, setEscError] = useState<string | null>(null);

  const createEntry = useCreateOnCall();
  const deleteEntry = useDeleteOnCall();
  const updatePolicy = useUpdateEscalationPolicy();

  const loadAll = useCallback(async () => {
    const [oncallRes, escRes] = await Promise.allSettled([
      fetch('/api/oncall', { cache: 'no-store' }),
      fetch('/api/escalation', { cache: 'no-store' }),
    ]);
    if (oncallRes.status === 'fulfilled' && oncallRes.value.ok) {
      setEntries((await oncallRes.value.json()) as OnCallEntryDTO[]);
    } else {
      setEntries([]);
      setPageError(`HTTP ${oncallRes.status === 'fulfilled' ? oncallRes.value.status : '—'}`);
    }
    if (escRes.status === 'fulfilled' && escRes.value.ok) {
      const p = (await escRes.value.json()) as EscalationPolicyDTO;
      setPolicy(p);
      setTimeoutMin(String(p.timeoutMin));
      setAppliesTo(p.appliesTo);
      setArmed(p.enabled);
    }
  }, []);

  useEffect(() => {
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

  const submitEntry = async (): Promise<void> => {
    if (!form) return;
    setFormError(null);
    const start = parseMin(form.start);
    const end = parseMin(form.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      setFormError(t('alerting.oncall.errWindow'));
      return;
    }
    try {
      await createEntry.mutateAsync({
        engineerName: form.engineerName,
        role: form.role,
        handle: form.handle,
        dayOfWeek: Number(form.dayOfWeek),
        startMinute: start,
        endMinute: end,
      });
      closeForm();
      await loadAll();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeEntry = async (): Promise<void> => {
    if (!pendingDelete) return;
    setBusyId(pendingDelete.id);
    try {
      await deleteEntry.mutateAsync(pendingDelete.id);
      setPendingDelete(null);
      await loadAll();
    } finally {
      setBusyId(null);
    }
  };

  const savePolicy = async (): Promise<void> => {
    setEscSaving(true);
    setEscError(null);
    try {
      await updatePolicy.mutateAsync({
        timeoutMin: Number(timeoutMin) || policy?.timeoutMin,
        appliesTo,
        enabled: armed,
      });
      await loadAll();
    } catch (err) {
      setEscError(err instanceof Error ? err.message : String(err));
    } finally {
      setEscSaving(false);
    }
  };

  const onDuty = (entries ?? []).filter((e) => e.active);
  const sorted = [...(entries ?? [])].sort(
    (a, b) => a.dayOfWeek - b.dayOfWeek || a.startMinute - b.startMinute,
  );

  return (
    <AlertingPage
      user={user}
      active="oncall"
      title={t('gov.oncall.title')}
      description={t('gov.oncall.desc')}
    >
      {pageError ? (
        <div
          className="rounded-[4px] border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical"
          role="alert"
        >
          HTTP — {pageError}
        </div>
      ) : null}

      {/* ── rotation ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              {t('gov.oncall.week')}
              {onDuty.length > 0 ? (
                <Badge
                  variant="outline"
                  className="border-ok/30 bg-ok-subtle text-ok"
                >
                  {t('gov.oncall.activeNow')}: {onDuty.map((e) => e.engineerName).join(', ')}
                </Badge>
              ) : null}
            </CardTitle>
            <CardDescription>{t('gov.oncall.desc')}</CardDescription>
          </div>
          <Button size="sm" onClick={() => setForm({ ...EMPTY_FORM })} disabled={form !== null}>
            <Plus className="size-4" aria-hidden="true" />
            {t('gov.oncall.create')}
          </Button>
        </CardHeader>
        <CardContent>
          {entries !== null && entries.length === 0 ? (
            <EmptyState
              icon={Users}
              title={t('gov.oncall.title')}
              description={t('gov.oncall.empty')}
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('gov.oncall.day')}</TableHead>
                    <TableHead>{t('gov.oncall.engineer')}</TableHead>
                    <TableHead>{t('gov.oncall.role')}</TableHead>
                    <TableHead>{t('gov.oncall.handle')}</TableHead>
                    <TableHead>{t('maint.duration')}</TableHead>
                    <TableHead className="text-end">{t('alerting.rules.state')}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="text-xs">
                        {t(`gov.oncall.day.${e.dayOfWeek}` as TranslationKey)}
                      </TableCell>
                      <TableCell className="font-medium">{e.engineerName}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{e.role}</TableCell>
                      <TableCell dir="ltr" className="font-mono text-xs">
                        {e.handle}
                      </TableCell>
                      <TableCell dir="ltr" className="font-mono text-xs">
                        {fmtMin(e.startMinute)}–{fmtMin(e.endMinute)}
                      </TableCell>
                      <TableCell className="text-end">
                        {e.active ? (
                          <Badge variant="outline" className="border-ok/30 bg-ok-subtle text-ok">
                            {t('gov.oncall.active')}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t('gov.oncall.off')}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-muted-foreground hover:text-critical"
                          disabled={busyId === e.id}
                          aria-label={`${t('gov.oncall.deleteConfirmTitle')} ${e.engineerName}`}
                          onClick={() => setPendingDelete(e)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── escalation ladder ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {t('esc.title')}
            {policy ? (
              <Badge
                variant="outline"
                className={
                  policy.enabled
                    ? 'border-ok/30 bg-ok-subtle text-ok'
                    : 'border-line bg-raised text-muted-foreground'
                }
              >
                {policy.enabled ? t('esc.enabled') : t('alerting.rules.off')}
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>{t('esc.desc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="esc-timeout">{t('esc.timeout')}</Label>
              <Input
                id="esc-timeout"
                type="number"
                min={1}
                max={30}
                dir="ltr"
                value={timeoutMin}
                onChange={(e) => setTimeoutMin(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t('esc.timeoutMin', { n: timeoutMin })}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="esc-applies">{t('esc.appliesTo')}</Label>
              <Select value={appliesTo} onValueChange={(v) => setAppliesTo(v as 'critical' | 'all')}>
                <SelectTrigger id="esc-applies" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="critical">{t('esc.appliesTo.critical')}</SelectItem>
                  <SelectItem value="all">{t('esc.appliesTo.all')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="esc-armed">{t('esc.enabled')}</Label>
              <div className="flex h-9 items-center">
                <Switch
                  id="esc-armed"
                  checked={armed}
                  onCheckedChange={(v) => setArmed(v === true)}
                  aria-label={t('esc.enabled')}
                />
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('esc.ladder')}: {t('esc.ladder.desc')}
          </p>
          {escError ? (
            <p
              role="alert"
              className="rounded-[4px] border border-critical/40 bg-critical/10 px-3 py-2 text-xs text-critical"
            >
              {escError}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void savePolicy()} disabled={escSaving || !policy}>
              {escSaving ? '…' : t('esc.save')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── add dialog ────────────────────────────────────────────────── */}
      <Dialog open={form !== null} onOpenChange={(open) => (open ? null : closeForm())}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('gov.oncall.create')}</DialogTitle>
            <DialogDescription>{t('gov.oncall.desc')}</DialogDescription>
          </DialogHeader>
          {form ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="oc-name">{t('gov.oncall.engineer')}</Label>
                  <Input
                    id="oc-name"
                    value={form.engineerName}
                    placeholder={t('gov.oncall.engineerPh')}
                    onChange={(e) => setForm({ ...form, engineerName: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="oc-role">{t('gov.oncall.role')}</Label>
                  <Input
                    id="oc-role"
                    value={form.role}
                    placeholder={t('gov.oncall.rolePh')}
                    onChange={(e) => setForm({ ...form, role: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="oc-handle">{t('gov.oncall.handle')}</Label>
                  <Input
                    id="oc-handle"
                    dir="ltr"
                    value={form.handle}
                    placeholder={t('gov.oncall.handlePh')}
                    onChange={(e) => setForm({ ...form, handle: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="oc-day">{t('gov.oncall.day')}</Label>
                  <Select value={form.dayOfWeek} onValueChange={(v) => setForm({ ...form, dayOfWeek: v })}>
                    <SelectTrigger id="oc-day" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                        <SelectItem key={d} value={String(d)}>
                          {t(`gov.oncall.day.${d}` as TranslationKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="oc-start">{t('gov.oncall.from')}</Label>
                    <Input
                      id="oc-start"
                      type="time"
                      dir="ltr"
                      value={form.start}
                      onChange={(e) => setForm({ ...form, start: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="oc-end">{t('gov.oncall.to')}</Label>
                    <Input
                      id="oc-end"
                      type="time"
                      dir="ltr"
                      value={form.end}
                      onChange={(e) => setForm({ ...form, end: e.target.value })}
                    />
                  </div>
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
            <Button onClick={() => void submitEntry()} disabled={createEntry.isPending}>
              {createEntry.isPending ? '…' : t('gov.oncall.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── delete confirm (names the object) ─────────────────────────── */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => (open ? null : setPendingDelete(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('gov.oncall.deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('gov.oncall.deleteConfirmDesc')}
              {pendingDelete ? (
                <span className="mt-2 block font-medium text-foreground">
                  {pendingDelete.engineerName} ·{' '}
                  {t(`gov.oncall.day.${pendingDelete.dayOfWeek}` as TranslationKey)}{' '}
                  {fmtMin(pendingDelete.startMinute)}–{fmtMin(pendingDelete.endMinute)}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('esc.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-critical text-white hover:bg-critical/90"
              onClick={() => void removeEntry()}
            >
              {t('settings.notif.ch.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AlertingPage>
  );
}
