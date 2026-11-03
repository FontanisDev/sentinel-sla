'use client';

// /setup — first-run wizard: create the owner account (only when zero users).
// Step 1 of the journey "first run: setup wizard
// creates the owner"; Live/Demo choice + Prometheus connection arrive with the
// integrations screen (single-step now, extended later).

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function SetupPage() {
  const router = useRouter();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/auth/setup')
      .then((r) => r.json())
      .then((d) => {
        setAvailable(Boolean(d.available));
        if (!d.available) router.replace('/login');
      })
      .catch(() => setAvailable(false));
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, locale: 'en' }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? 'Setup failed. Please try again.');
        return;
      }
      router.replace('/');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (available === null || available === false) {
    return (
      <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">
          {available === false
            ? 'Setup is not available — this instance already has an owner.'
            : 'Loading…'}
        </p>
      </main>
    );
  }

  const field =
    'w-full rounded-[4px] border border-input bg-input/40 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/30';

  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-md border border-border bg-card p-6 shadow-sm">
        <div className="mb-6">
          <div className="text-lg font-semibold">Welcome to Sentinel-SLA</div>
          <p className="mt-1 text-xs text-muted-foreground">
            First run: create the owner account. This screen is only available until the first
            account exists.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="name" className="mb-1 block text-xs font-medium">
              Your name
            </label>
            <input id="name" required minLength={2} value={name} onChange={(e) => setName(e.target.value)} placeholder="Operations Lead" className={field} />
          </div>
          <div>
            <label htmlFor="email" className="mb-1 block text-xs font-medium">
              Email
            </label>
            <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.ir" className={field} />
          </div>
          <div>
            <label htmlFor="password" className="mb-1 block text-xs font-medium">
              Password
            </label>
            <input id="password" type="password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
            <p className="mt-1 text-xs text-muted-foreground">
              At least 12 characters. Stored as an argon2id hash — never in plain text.
            </p>
          </div>
          <div>
            <label htmlFor="confirm" className="mb-1 block text-xs font-medium">
              Confirm password
            </label>
            <input id="confirm" type="password" required minLength={12} value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} />
          </div>

          {error && (
            <p role="alert" className="rounded-[4px] border border-critical/40 bg-critical/10 px-3 py-2 text-xs text-critical">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-[4px] bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {busy ? 'Creating…' : 'Create owner account'}
          </button>
        </form>
      </div>
    </main>
  );
}
