'use client';

// /settings/integrations — Prometheus connection card (
// "Settings → Integrations: Prometheus base URL (+ optional basic auth /
// bearer), test-connection button").
//
// Admin-only by construction: every underlying API (GET/PUT/test) enforces
// the admin floor server-side; a scoped user reaching this page sees the
// 403 surfaced in the error banner instead of the form data.
// Secrets are never echoed back by the API — the form starts empty on
// reload; saving re-sends credentials only when typed.

import { useCallback, useEffect, useState } from 'react';
import { useLang } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsNav } from '@/components/sentinel/settings-nav';

type AuthKind = 'none' | 'basic' | 'bearer';

interface PromSettingsView {
  configured: boolean;
  baseUrl: string | null;
  auth: { kind: AuthKind; username?: string; tokenPreview?: string };
}

export default function IntegrationsSettingsPage() {
  const { t } = useLang();
  const [view, setView] = useState<PromSettingsView | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [authKind, setAuthKind] = useState<AuthKind>('none');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/integrations/prometheus', { cache: 'no-store' });
      if (!res.ok) {
        setLoadError(`HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as PromSettingsView;
      setView(data);
      if (data.baseUrl) setBaseUrl(data.baseUrl);
      setAuthKind(data.auth?.kind ?? 'none');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const authPayload = useCallback((): Record<string, unknown> => {
    if (authKind === 'basic') return { kind: 'basic', username, password };
    if (authKind === 'bearer') return { kind: 'bearer', token };
    return { kind: 'none' };
  }, [authKind, username, password, token]);

  const save = async () => {
    setSaving(true);
    setErrorMsg(null);
    setSavedMsg(null);
    try {
      const res = await fetch('/api/integrations/prometheus', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, auth: authPayload() }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setErrorMsg(body.error ?? `HTTP ${res.status}`);
      } else {
        setSavedMsg(t('settings.integrations.saved'));
        await load();
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const candidate = baseUrl ? { baseUrl, auth: authPayload() } : undefined;
      const res = await fetch('/api/integrations/prometheus/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: candidate ? JSON.stringify(candidate) : JSON.stringify({}),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        version?: string | null;
        queryLatencyMs?: number;
      };
      if (!res.ok || body.ok === false) {
        setTestMsg({
          ok: false,
          text: t('settings.integrations.testFailed', { msg: body.error ?? `HTTP ${res.status}` }),
        });
      } else {
        const detail = [body.version ?? 'unknown version', `${body.queryLatencyMs ?? '?'} ms`]
          .filter(Boolean)
          .join(', ');
        setTestMsg({ ok: true, text: t('settings.integrations.testOk', { detail }) });
      }
    } catch (err) {
      setTestMsg({
        ok: false,
        text: t('settings.integrations.testFailed', { msg: err instanceof Error ? err.message : String(err) }),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
      <SettingsNav active="integrations" />
      <h1 className="mt-6 text-2xl font-bold tracking-tight">{t('settings.integrations.title')}</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('settings.integrations.desc')}</p>

      {loadError ? (
        <div className="mt-6 rounded-lg border border-critical/40 bg-critical/10 px-4 py-3 text-sm text-critical">
          HTTP — {loadError}
        </div>
      ) : (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">{t('settings.integrations.title')}</CardTitle>
            <CardDescription>
              {view && !view.configured ? t('settings.integrations.notConfigured') : view?.baseUrl ?? ''}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="prom-base">{t('settings.integrations.baseUrl')}</Label>
              <Input
                id="prom-base"
                placeholder="http://prometheus:9090"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                autoComplete="url"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="prom-auth">{t('settings.integrations.auth')}</Label>
              <Select value={authKind} onValueChange={(v) => setAuthKind(v as AuthKind)}>
                <SelectTrigger id="prom-auth" className="w-full sm:w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('settings.integrations.authNone')}</SelectItem>
                  <SelectItem value="basic">{t('settings.integrations.authBasic')}</SelectItem>
                  <SelectItem value="bearer">{t('settings.integrations.authBearer')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {authKind === 'basic' ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="prom-user">{t('settings.integrations.username')}</Label>
                  <Input id="prom-user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="prom-pass">{t('settings.integrations.password')}</Label>
                  <Input
                    id="prom-pass"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                </div>
              </div>
            ) : null}

            {authKind === 'bearer' ? (
              <div className="space-y-2">
                <Label htmlFor="prom-token">{t('settings.integrations.token')}</Label>
                <Input
                  id="prom-token"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="new-password"
                />
                {view?.auth?.tokenPreview ? (
                  <p className="text-xs text-muted-foreground">{view.auth.tokenPreview}</p>
                ) : null}
              </div>
            ) : null}

            {errorMsg ? (
              <div className="rounded-lg border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical">
                {t('settings.integrations.saveFailed', { msg: errorMsg })}
              </div>
            ) : null}
            {savedMsg ? (
              <div className="rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
                {savedMsg}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2 pt-1">
              <Button onClick={() => void save()} disabled={saving || !baseUrl}>
                {saving ? t('settings.integrations.saving') : t('settings.integrations.save')}
              </Button>
              <Button variant="outline" onClick={() => void test()} disabled={testing || (!baseUrl && !view?.configured)}>
                {testing ? t('settings.integrations.testing') : t('settings.integrations.test')}
              </Button>
            </div>

            {testMsg ? (
              <div
                className={
                  'rounded-lg border px-3 py-2 text-sm ' +
                  (testMsg.ok
                    ? 'border-success/40 bg-success/10 text-success'
                    : 'border-critical/40 bg-critical/10 text-critical')
                }
              >
                {testMsg.text}
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}
    </main>
  );
}
