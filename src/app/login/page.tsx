'use client';

// /login — credential login. The page follows the app's own
// design tokens; error copy is plain language with the fix.
//
// Next 16 prerenders pages: the useSearchParams() consumer is isolated in
// <LoginForm> under a Suspense boundary so the static shell can export
// without bail-out.

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { setLang } from '@/hooks/use-language';

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? 'Login failed. Please try again.');
        return;
      }
      // journey 6: the account's language preference follows the sign-in —
      // an fa-locale executive lands on the Persian home on any machine.
      const locale = data?.user?.locale;
      if (locale === 'fa' || locale === 'en') setLang(locale);
      const next = params.get('next') ?? '/';
      router.replace(next.startsWith('/') ? next : '/');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const field =
    'w-full rounded-[4px] border border-input bg-input/40 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/30';

  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-md border border-border bg-card p-6 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          { }
          <img src="/logo.svg" alt="" className="h-6 w-6" />
          <div>
            <div className="text-lg font-semibold leading-tight">Sentinel SLA</div>
            <div className="text-xs text-muted-foreground">Fintech Service Level Command Center</div>
          </div>
        </div>

        <h1 className="text-base font-semibold">Sign in</h1>
        <p className="mb-4 mt-1 text-xs text-muted-foreground">
          Access the SLA command center with your operator account.
        </p>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-1 block text-xs font-medium">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.ir"
              className={field}
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1 block text-xs font-medium">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={field}
            />
          </div>

          {error && (
            <p role="alert" className="rounded-[4px] border border-critical/40 bg-critical/10 px-3 py-2 text-xs text-critical">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-[4px] bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
