'use client';

// Alerting parts — channels, delivery log, outbox and executive digest cards.
// Single source of truth for the /alerting/channels page (alerting IA consolidation);
// the legacy /settings/notifications route redirects here.
//
// Data sources (server-enforced authz — this is only the lens):
//   /api/channels               GET list · POST create (engineer+)
//   /api/channels/[id]          PATCH edit · DELETE (engineer+)
//   /api/channels/[id]/test     POST real test-send (engineer+)
//   /api/integrations/digest    GET/PUT/POST run-now (admin)
//   /api/notifications/delivery GET (any signed-in role)
//   /api/notifications/outbox   GET (any role) · POST retry (admin)
//
// Health chips are honest: they come from the dispatcher's real counters
// (deliveredCount / failedCount / lastError), not from optimism.
import { useCallback, useEffect, useState } from 'react';
import { useLang } from '@/hooks/use-language';
import type { TranslationKey } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TemplatePreview } from '@/components/sentinel/template-preview';

type ChannelKind = 'telegram' | 'bale' | 'webhook' | 'email' | 'mattermost' | 'jira' | 'redmine';
type ChannelAudience = 'technical' | 'executive' | 'both';

interface ChannelDTO {
  id: string;
  name: string;
  kind: ChannelKind;
  target: string;
  audience: ChannelAudience;
  enabled: boolean;
  deliveredCount: number;
  failedCount: number;
  lastDeliveryAt: string | null;
  lastError: string | null;
  settings?: Record<string, unknown> | null;
  status: 'healthy' | 'degraded' | 'disabled';
  createdAt: string;
}

interface DigestView {
  frequency: 'off' | 'daily' | 'weekly';
  hour: number;
  dayOfWeek: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunOk: boolean;
  lastError: string | null;
}

interface DeliveryRow {
  id: string;
  kind: string;
  ok: number | boolean;
  statusCode: number | null;
  error: string | null;
  latencyMs: number;
  at: string;
  title: string | null;
  severity: string | null;
  test: number | boolean | null;
}

interface OutboxRow {
  id: string;
  topic: string;
  severity: string;
  audience: string;
  kind: string;
  title: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  availableAt: string;
  test: boolean;
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function healthTone(status: ChannelDTO['status']): string {
  switch (status) {
    case 'healthy':
      return 'border-success/40 bg-success/10 text-success';
    case 'degraded':
      return 'border-warning/40 bg-warning/10 text-warning';
    default:
      return 'border-border bg-muted/40 text-muted-foreground';
  }
}

const KIND_LABEL: Record<ChannelKind, string> = {
  telegram: 'Telegram',
  bale: 'Bale',
  webhook: 'Webhook',
  email: 'Email',
  mattermost: 'Mattermost',
  jira: 'Jira',
  redmine: 'Redmine',
};

/** Kinds whose secret field is meaningful (credential, not just a webhook key). */
const USE_SECRET: ReadonlySet<ChannelKind> = new Set(['webhook', 'jira', 'redmine']);

export function NotificationsBody() {

  // ── data state ────────────────────────────────────────────────────────────
  const [channels, setChannels] = useState<ChannelDTO[] | null>(null);
  const [digest, setDigest] = useState<DigestView | null>(null);
  const [digestForbidden, setDigestForbidden] = useState(false);
  const [log, setLog] = useState<DeliveryRow[] | null>(null);
  const [outbox, setOutbox] = useState<OutboxRow[] | null>(null);

  const [pageError, setPageError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    const results = await Promise.allSettled([
      fetch('/api/channels', { cache: 'no-store' }),
      fetch('/api/integrations/digest', { cache: 'no-store' }),
      fetch('/api/notifications/delivery?limit=50', { cache: 'no-store' }),
      fetch('/api/notifications/outbox?limit=50', { cache: 'no-store' }),
    ]);
    if (results[0].status === 'fulfilled' && results[0].value.ok) {
      setChannels((await results[0].value.json()) as ChannelDTO[]);
    } else {
      setChannels([]);
      setPageError(`HTTP ${results[0].status === 'fulfilled' ? results[0].value.status : '—'}`);
    }
    if (results[1].status === 'fulfilled') {
      if (results[1].value.ok) {
        setDigest((await results[1].value.json()) as DigestView);
        setDigestForbidden(false);
      } else if (results[1].value.status === 403) {
        setDigestForbidden(true); // scoped role — digest card degrades honestly
      }
    }
    if (results[2].status === 'fulfilled' && results[2].value.ok) {
      setLog((await results[2].value.json()) as DeliveryRow[]);
    } else {
      setLog([]);
    }
    if (results[3].status === 'fulfilled' && results[3].value.ok) {
      setOutbox((await results[3].value.json()) as OutboxRow[]);
    } else {
      setOutbox([]);
    }
  }, []);

  useEffect(() => {
    // Deferred one tick: the new react-hooks lint forbids synchronous
    // setState inside effects; loadAll flips loading state immediately.
    const t = setTimeout(() => void loadAll(), 0);
    return () => clearTimeout(t);
  }, [loadAll]);

  const showFlash = (msg: string): void => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 4000);
  };

  return (
    <>

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

      <div className="space-y-6">
        <DigestCard digest={digest} forbidden={digestForbidden} onChanged={loadAll} onFlash={showFlash} />
        <ChannelsCard channels={channels} onChanged={loadAll} onFlash={showFlash} />
        <DeliveryLogCard rows={log} />
        <OutboxCard rows={outbox} onChanged={loadAll} onFlash={showFlash} />
        <TemplatePreview />
      </div>
    </>
  );
}

// ── digest schedule card ─────────────────────────────────────────────────────

export function DigestCard({
  digest,
  forbidden,
  onChanged,
  onFlash,
}: {
  digest: DigestView | null;
  forbidden: boolean;
  onChanged: () => Promise<void>;
  onFlash: (msg: string) => void;
}) {
  const { t } = useLang();
  const [frequency, setFrequency] = useState<'off' | 'daily' | 'weekly'>('off');
  const [hour, setHour] = useState('8');
  const [dayOfWeek, setDayOfWeek] = useState('6');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (digest) {
      setFrequency(digest.frequency);
      setHour(String(digest.hour));
      setDayOfWeek(String(digest.dayOfWeek));
    }
  }, [digest]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/integrations/digest', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          frequency,
          hour: Number(hour),
          dayOfWeek: frequency === 'weekly' ? Number(dayOfWeek) : undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
      } else {
        onFlash(t('settings.notif.digest.saved'));
        await onChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async (): Promise<void> => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/integrations/digest', { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; enqueued?: number; error?: string };
      if (!res.ok) {
        setError(
          res.status === 409 || body.error === 'digest-disabled'
            ? t('settings.notif.digest.runDisabled')
            : (body.error ?? `HTTP ${res.status}`),
        );
      } else {
        onFlash(t('settings.notif.digest.runOk', { n: body.enqueued ?? 0 }));
        await onChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const hours = Array.from({ length: 24 }, (_, h) => h);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('settings.notif.digest.title')}</CardTitle>
        <CardDescription>{t('settings.notif.digest.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {forbidden ? (
          <p className="text-sm text-muted-foreground">403 — admin only.</p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="digest-frequency">{t('settings.notif.digest.frequency')}</Label>
                <Select value={frequency} onValueChange={(v) => setFrequency(v as 'off' | 'daily' | 'weekly')}>
                  <SelectTrigger id="digest-frequency" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">{t('settings.notif.digest.off')}</SelectItem>
                    <SelectItem value="daily">{t('settings.notif.digest.daily')}</SelectItem>
                    <SelectItem value="weekly">{t('settings.notif.digest.weekly')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="digest-hour">{t('settings.notif.digest.hour')}</Label>
                <Select value={hour} onValueChange={setHour}>
                  <SelectTrigger id="digest-hour" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {hours.map((h) => (
                      <SelectItem key={h} value={String(h)}>
                        {String(h).padStart(2, '0')}:00
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {frequency === 'weekly' ? (
                <div className="space-y-2">
                  <Label htmlFor="digest-day">{t('settings.notif.digest.day')}</Label>
                  <Select value={dayOfWeek} onValueChange={setDayOfWeek}>
                    <SelectTrigger id="digest-day" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                        <SelectItem key={d} value={String(d)}>
                          {t(`settings.notif.digest.day.${d}` as TranslationKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>
                {digest?.nextRunAt
                  ? t('settings.notif.digest.next', { time: fmtTime(digest.nextRunAt) })
                  : null}
              </span>
              <span>
                {digest?.lastRunAt
                  ? digest.lastRunOk
                    ? t('settings.notif.digest.last', { time: fmtTime(digest.lastRunAt) })
                    : t('settings.notif.digest.lastFailed', { err: digest.lastError ?? '?' })
                  : t('settings.notif.digest.last', { time: t('settings.notif.digest.never') })}
              </span>
            </div>

            {error ? (
              <p role="alert" className="rounded-[4px] border border-critical/40 bg-critical/10 px-3 py-2 text-xs text-critical">
                {error}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void save()} disabled={saving}>
                {saving ? '…' : t('settings.notif.digest.save')}
              </Button>
              <Button variant="outline" onClick={() => void runNow()} disabled={running || frequency === 'off'}>
                {running ? t('settings.notif.digest.running') : t('settings.notif.digest.runNow')}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── channels card (add / edit / test-send / enable / delete) ─────────────────

interface ChannelForm {
  name: string;
  kind: ChannelKind;
  target: string;
  audience: ChannelAudience;
  secret: string;
  /** per-kind non-secret settings, edited as flat strings below */
  jiraProjectKey: string;
  jiraIssueTypeName: string;
  redmineProjectId: string;
  mmChannel: string;
  mmUsername: string;
}

const EMPTY_FORM: ChannelForm = {
  name: '', kind: 'telegram', target: '', audience: 'technical', secret: '',
  jiraProjectKey: '', jiraIssueTypeName: '', redmineProjectId: '', mmChannel: '', mmUsername: '',
};

export function ChannelsCard({
  channels,
  onChanged,
  onFlash,
}: {
  channels: ChannelDTO[] | null;
  onChanged: () => Promise<void>;
  onFlash: (msg: string) => void;
}) {
  const { t } = useLang();
  const [form, setForm] = useState<ChannelForm | null>(null); // null = closed
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openAdd = (): void => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
  };
  const openEdit = (ch: ChannelDTO): void => {
    setEditingId(ch.id);
    const s = (ch.settings ?? {}) as Record<string, unknown>;
    setForm({
      name: ch.name,
      kind: ch.kind,
      target: ch.target,
      audience: ch.audience,
      secret: '',
      jiraProjectKey: typeof s['projectKey'] === 'string' ? s['projectKey'] : '',
      jiraIssueTypeName: typeof s['issueTypeName'] === 'string' ? s['issueTypeName'] : '',
      redmineProjectId: typeof s['projectId'] === 'string' ? s['projectId'] : '',
      mmChannel: typeof s['channel'] === 'string' ? s['channel'] : '',
      mmUsername: typeof s['username'] === 'string' ? s['username'] : '',
    });
  };
  const close = (): void => {
    setForm(null);
    setEditingId(null);
    setError(null);
  };

  const submit = async (): Promise<void> => {
    if (!form) return;
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        kind: form.kind,
        target: form.target,
        audience: form.audience,
      };
      if (form.secret) payload.secret = form.secret;
      // per-kind settings: ticketing kinds need a project; mattermost overrides optional
      if (form.kind === 'jira') {
        const settings: Record<string, unknown> = { projectKey: form.jiraProjectKey.trim() };
        if (form.jiraIssueTypeName.trim()) settings['issueTypeName'] = form.jiraIssueTypeName.trim();
        payload.settings = settings;
      } else if (form.kind === 'redmine') {
        payload.settings = { projectId: form.redmineProjectId.trim() };
      } else if (form.kind === 'mattermost') {
        const settings: Record<string, unknown> = {};
        if (form.mmChannel.trim()) settings['channel'] = form.mmChannel.trim();
        if (form.mmUsername.trim()) settings['username'] = form.mmUsername.trim();
        if (Object.keys(settings).length > 0) payload.settings = settings;
      }
      const res = editingId
        ? await fetch(`/api/channels/${editingId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await fetch('/api/channels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      close();
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const act = async (ch: ChannelDTO, action: 'test' | 'toggle' | 'delete'): Promise<void> => {
    setBusyId(ch.id);
    setError(null);
    try {
      let res: Response;
      if (action === 'test') {
        res = await fetch(`/api/channels/${ch.id}/test`, { method: 'POST' });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          setError(body.error ?? `HTTP ${res.status}`);
          return;
        }
        onFlash(t('settings.notif.ch.testOk'));
      } else if (action === 'toggle') {
        res = await fetch(`/api/channels/${ch.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !ch.enabled }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? `HTTP ${res.status}`);
          return;
        }
      } else {
        res = await fetch(`/api/channels/${ch.id}`, { method: 'DELETE' });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? `HTTP ${res.status}`);
          return;
        }
      }
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const targetHint = (kind: ChannelKind): string =>
    t(`settings.notif.ch.targetHint.${kind}` as TranslationKey);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">{t('settings.notif.ch.title')}</CardTitle>
          <CardDescription>{t('settings.notif.ch.desc')}</CardDescription>
        </div>
        <Button size="sm" onClick={openAdd} disabled={form !== null}>
          {t('settings.notif.ch.add')}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <p role="alert" className="rounded-[4px] border border-critical/40 bg-critical/10 px-3 py-2 text-xs text-critical">
            {error}
          </p>
        ) : null}

        {form ? (
          <div className="space-y-3 rounded-[4px] border border-border bg-muted/20 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ch-name">{t('settings.notif.ch.name')}</Label>
                <Input id="ch-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ch-kind">{t('settings.notif.ch.kind')}</Label>
                <Select
                  value={form.kind}
                  onValueChange={(v) => setForm({ ...form, kind: v as ChannelKind })}
                  disabled={editingId !== null}
                >
                  <SelectTrigger id="ch-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="telegram">Telegram</SelectItem>
                    <SelectItem value="bale">Bale</SelectItem>
                    <SelectItem value="webhook">Webhook</SelectItem>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="mattermost">Mattermost</SelectItem>
                    <SelectItem value="jira">Jira</SelectItem>
                    <SelectItem value="redmine">Redmine</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ch-target">{t('settings.notif.ch.target')}</Label>
                <Input
                  id="ch-target"
                  placeholder={targetHint(form.kind)}
                  value={form.target}
                  onChange={(e) => setForm({ ...form, target: e.target.value })}
                  dir="ltr"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ch-audience">{t('settings.notif.ch.audience')}</Label>
                <Select value={form.audience} onValueChange={(v) => setForm({ ...form, audience: v as ChannelAudience })}>
                  <SelectTrigger id="ch-audience" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="technical">{t('settings.notif.ch.audience.technical')}</SelectItem>
                    <SelectItem value="executive">{t('settings.notif.ch.audience.executive')}</SelectItem>
                    <SelectItem value="both">{t('settings.notif.ch.audience.both')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.kind === 'jira' ? (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="ch-jira-project">{t('settings.notif.ch.jira.project')}</Label>
                    <Input
                      id="ch-jira-project"
                      placeholder="OPS"
                      value={form.jiraProjectKey}
                      onChange={(e) => setForm({ ...form, jiraProjectKey: e.target.value })}
                      dir="ltr"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ch-jira-type">{t('settings.notif.ch.jira.issueType')}</Label>
                    <Input
                      id="ch-jira-type"
                      placeholder="Task"
                      value={form.jiraIssueTypeName}
                      onChange={(e) => setForm({ ...form, jiraIssueTypeName: e.target.value })}
                      dir="ltr"
                    />
                  </div>
                </>
              ) : null}
              {form.kind === 'redmine' ? (
                <div className="space-y-1.5">
                  <Label htmlFor="ch-redmine-project">{t('settings.notif.ch.redmine.project')}</Label>
                  <Input
                    id="ch-redmine-project"
                    placeholder="sentinel"
                    value={form.redmineProjectId}
                    onChange={(e) => setForm({ ...form, redmineProjectId: e.target.value })}
                    dir="ltr"
                  />
                </div>
              ) : null}
              {form.kind === 'mattermost' ? (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="ch-mm-channel">{t('settings.notif.ch.mm.channel')}</Label>
                    <Input
                      id="ch-mm-channel"
                      placeholder="town-square"
                      value={form.mmChannel}
                      onChange={(e) => setForm({ ...form, mmChannel: e.target.value })}
                      dir="ltr"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ch-mm-username">{t('settings.notif.ch.mm.username')}</Label>
                    <Input
                      id="ch-mm-username"
                      placeholder="Sentinel"
                      value={form.mmUsername}
                      onChange={(e) => setForm({ ...form, mmUsername: e.target.value })}
                      dir="ltr"
                    />
                  </div>
                </>
              ) : null}
              {USE_SECRET.has(form.kind) || editingId === null ? (
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="ch-secret">{t('settings.notif.ch.secret')}</Label>
                  <Input
                    id="ch-secret"
                    type="password"
                    value={form.secret}
                    onChange={(e) => setForm({ ...form, secret: e.target.value })}
                    autoComplete="new-password"
                  />
                  <p className="text-xs text-muted-foreground">
                    {form.kind === 'jira'
                      ? t('settings.notif.ch.secretHint.jira')
                      : form.kind === 'redmine'
                        ? t('settings.notif.ch.secretHint.redmine')
                        : t('settings.notif.ch.secretHint')}
                  </p>
                </div>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => void submit()}
                disabled={
                  !form.name ||
                  !form.target ||
                  (form.kind === 'jira' && !form.jiraProjectKey.trim()) ||
                  (form.kind === 'redmine' && !form.redmineProjectId.trim())
                }
              >
                {editingId ? t('settings.notif.ch.save') : t('settings.notif.ch.add')}
              </Button>
              <Button size="sm" variant="outline" onClick={close}>
                {t('settings.notif.ch.cancel')}
              </Button>
            </div>
          </div>
        ) : null}

        {channels === null ? (
          <p className="text-sm text-muted-foreground">…</p>
        ) : channels.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('settings.notif.ch.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('settings.notif.ch.col.name')}</TableHead>
                  <TableHead>{t('settings.notif.ch.col.kind')}</TableHead>
                  <TableHead>{t('settings.notif.ch.col.target')}</TableHead>
                  <TableHead>{t('settings.notif.ch.col.audience')}</TableHead>
                  <TableHead>{t('settings.notif.ch.col.health')}</TableHead>
                  <TableHead className="text-end">{t('settings.notif.ch.col.delivered')}</TableHead>
                  <TableHead className="text-end">{t('settings.notif.ch.col.failed')}</TableHead>
                  <TableHead className="text-end">·</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {channels.map((ch) => (
                  <TableRow key={ch.id}>
                    <TableCell className="font-medium">{ch.name}</TableCell>
                    <TableCell>{KIND_LABEL[ch.kind] ?? ch.kind}</TableCell>
                    <TableCell className="max-w-52 truncate font-mono text-xs" dir="ltr" title={ch.target}>
                      {ch.target}
                    </TableCell>
                    <TableCell>
                      {t(`settings.notif.ch.audience.${ch.audience}` as TranslationKey)}
                    </TableCell>
                    <TableCell>
                      <span className={'rounded-full border px-2 py-0.5 text-[10px] font-medium ' + healthTone(ch.status)}>
                        {t(`settings.notif.ch.${ch.status}` as TranslationKey)}
                      </span>
                      {ch.lastError ? (
                        <p className="mt-1 max-w-40 truncate text-[10px] text-critical" title={ch.lastError}>
                          {ch.lastError}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{ch.deliveredCount}</TableCell>
                    <TableCell className="text-end tabular-nums">{ch.failedCount}</TableCell>
                    <TableCell className="text-end">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="outline" onClick={() => void act(ch, 'test')} disabled={busyId === ch.id}>
                          {busyId === ch.id ? t('settings.notif.ch.testing') : t('settings.notif.ch.test')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => openEdit(ch)}>
                          {t('settings.notif.ch.edit')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void act(ch, 'toggle')}>
                          {ch.enabled ? t('settings.notif.ch.disable') : t('settings.notif.ch.enable')}
                        </Button>
                        <Button size="sm" variant="ghost" className="text-critical" onClick={() => void act(ch, 'delete')}>
                          {t('settings.notif.ch.delete')}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── delivery log card ────────────────────────────────────────────────────────

export function DeliveryLogCard({ rows }: { rows: DeliveryRow[] | null }) {
  const { t } = useLang();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('settings.notif.log.title')}</CardTitle>
        <CardDescription>{t('settings.notif.log.desc')}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows === null ? (
          <p className="text-sm text-muted-foreground">…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('settings.notif.log.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('settings.notif.log.col.at')}</TableHead>
                  <TableHead>{t('settings.notif.log.col.message')}</TableHead>
                  <TableHead>{t('settings.notif.log.col.kind')}</TableHead>
                  <TableHead>{t('settings.notif.log.col.status')}</TableHead>
                  <TableHead>{t('settings.notif.log.col.code')}</TableHead>
                  <TableHead className="text-end">{t('settings.notif.log.col.latency')}</TableHead>
                  <TableHead>{t('settings.notif.log.col.error')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const ok = Boolean(r.ok);
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap text-xs">{fmtTime(r.at)}</TableCell>
                      <TableCell className="max-w-64 truncate text-xs" title={r.title ?? ''}>
                        {r.title ?? '—'}
                        {r.test ? (
                          <Badge variant="outline" className="ms-1 px-1 py-0 text-[9px]">
                            {t('settings.notif.log.test')}
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-xs">{r.kind}</TableCell>
                      <TableCell>
                        <span
                          className={
                            'rounded-full border px-2 py-0.5 text-[10px] font-medium ' +
                            (ok ? 'border-success/40 bg-success/10 text-success' : 'border-critical/40 bg-critical/10 text-critical')
                          }
                        >
                          {ok ? t('settings.notif.log.ok') : t('settings.notif.log.fail')}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">{r.statusCode ?? '—'}</TableCell>
                      <TableCell className="text-end text-xs tabular-nums">{r.latencyMs} ms</TableCell>
                      <TableCell className="max-w-48 truncate text-xs text-critical" title={r.error ?? ''}>
                        {r.error ?? '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── outbox card (queue view + dead-letter retry) ─────────────────────────────

export function OutboxCard({
  rows,
  onChanged,
  onFlash,
}: {
  rows: OutboxRow[] | null;
  onChanged: () => Promise<void>;
  onFlash: (msg: string) => void;
}) {
  const { t } = useLang();
  const [retrying, setRetrying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const retry = async (id: string): Promise<void> => {
    setRetrying(id);
    setError(null);
    try {
      const res = await fetch('/api/notifications/outbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'retry' }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      onFlash(t('settings.notif.outbox.retryOk'));
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(null);
    }
  };

  const statusTone = (status: string): string => {
    switch (status) {
      case 'delivered':
        return 'border-success/40 bg-success/10 text-success';
      case 'dead':
        return 'border-critical/40 bg-critical/10 text-critical';
      case 'delivering':
      case 'pending':
        return 'border-warning/40 bg-warning/10 text-warning';
      default:
        return 'border-border bg-muted/40 text-muted-foreground';
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('settings.notif.outbox.title')}</CardTitle>
        <CardDescription>{t('settings.notif.outbox.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p role="alert" className="rounded-[4px] border border-critical/40 bg-critical/10 px-3 py-2 text-xs text-critical">
            {error}
          </p>
        ) : null}
        {rows === null ? (
          <p className="text-sm text-muted-foreground">…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('settings.notif.outbox.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('settings.notif.outbox.col.status')}</TableHead>
                  <TableHead>{t('settings.notif.outbox.col.topic')}</TableHead>
                  <TableHead>{t('settings.notif.outbox.col.title')}</TableHead>
                  <TableHead className="text-end">{t('settings.notif.outbox.col.attempts')}</TableHead>
                  <TableHead>{t('settings.notif.outbox.col.available')}</TableHead>
                  <TableHead>{t('settings.notif.outbox.col.error')}</TableHead>
                  <TableHead className="text-end">·</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <span className={'rounded-full border px-2 py-0.5 text-[10px] font-medium ' + statusTone(r.status)}>
                        {r.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.topic}
                      {r.test ? ' · test' : ''}
                    </TableCell>
                    <TableCell className="max-w-64 truncate text-xs" title={r.title}>
                      {r.title}
                    </TableCell>
                    <TableCell className="text-end text-xs tabular-nums">
                      {r.attempts}/{r.maxAttempts}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{fmtTime(r.availableAt)}</TableCell>
                    <TableCell className="max-w-48 truncate text-xs text-critical" title={r.lastError ?? ''}>
                      {r.lastError ?? '—'}
                    </TableCell>
                    <TableCell className="text-end">
                      {r.status === 'dead' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void retry(r.id)}
                          disabled={retrying === r.id}
                        >
                          {t('settings.notif.outbox.retry')}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
