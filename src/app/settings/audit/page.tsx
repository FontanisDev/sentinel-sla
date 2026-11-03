'use client';

// /settings/audit — audit trail browser.
// Admin-only page: filter by action / lookback window, scan the trail,
// follow up on logins, user changes, report generation and exports.
// Server-enforced: the API itself 403s below admin — this page is the lens.

import { useCallback, useEffect, useState } from 'react';

interface AuditEntry {
  id: string;
  ts: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  detail: string | null;
  ip: string | null;
}

const ACTION_TONES: Record<string, string> = {
  login: 'text-success border-success/40 bg-success/10',
  logout: 'text-muted-foreground border-border bg-muted/40',
  'login.failed': 'text-critical border-critical/40 bg-critical/10',
  'login.locked': 'text-critical border-critical/40 bg-critical/10',
  'user.created': 'text-brand-ink border-primary/40 bg-primary/10',
  'user.updated': 'text-warning border-warning/40 bg-warning/10',
  'user.deleted': 'text-critical border-critical/40 bg-critical/10',
  'user.sessions_revoked': 'text-warning border-warning/40 bg-warning/10',
};

function toneFor(action: string): string {
  return ACTION_TONES[action] ?? 'text-foreground border-border bg-muted/40';
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const LOOKBACKS = [
  { label: '24 h', hours: 24 },
  { label: '7 d', hours: 24 * 7 },
  { label: '30 d', hours: 24 * 30 },
  { label: 'All', hours: 0 },
];

export default function AuditSettingsPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [actionFilter, setActionFilter] = useState('');
  const [hours, setHours] = useState(24 * 7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ take: '200' });
      if (actionFilter) params.set('action', actionFilter);
      if (hours > 0) params.set('hours', String(hours));
      const res = await fetch(`/api/audit?${params.toString()}`);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? 'Failed to load the audit log.');
        return;
      }
      setEntries(data.entries ?? []);
      setActions(data.actions ?? []);
    } finally {
      setLoading(false);
    }
  }, [actionFilter, hours]);

  useEffect(() => {
    // Deferred one tick: the new react-hooks lint forbids synchronous
    // setState inside effects (cascading renders); load() flips loading
    // immediately, so run it after mount settles.
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <nav className="mb-1 text-xs text-muted-foreground" aria-label="Breadcrumb">
              <a href="/" className="hover:text-foreground">
                Command center
              </a>
              <span className="mx-1">/</span>
              <span>Settings</span>
              <span className="mx-1">/</span>
              <span className="text-foreground">Audit log</span>
            </nav>
            <h1 className="text-xl font-semibold tracking-tight">Audit log</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              Append-only trail of security-relevant events: sign-ins, account changes, report
              generation, exports. Entries are recorded by the server and cannot be edited here.
            </p>
          </div>
          <button
            onClick={() => void load()}
            className="rounded-[4px] border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted/60"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </header>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="rounded-[4px] border border-input bg-input/40 px-2.5 py-1.5 text-xs outline-none focus:border-primary"
            aria-label="Filter by action"
          >
            <option value="">All actions</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <div className="flex overflow-hidden rounded-[4px] border border-border" role="group" aria-label="Lookback window">
            {LOOKBACKS.map((l) => (
              <button
                key={l.label}
                onClick={() => setHours(l.hours)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  hours === l.hours
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-card text-muted-foreground hover:bg-muted/60'
                }`}
              >
                {l.label}
              </button>
            ))}
          </div>
          <span className="ml-auto text-xs text-muted-foreground">
            {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}
          </span>
        </div>

        {error && (
          <p role="alert" className="mb-4 rounded-[4px] border border-critical/40 bg-critical/10 px-3 py-2 text-xs text-critical">
            {error}
          </p>
        )}

        <div className="overflow-hidden rounded-md border border-border bg-card">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-border bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">Time</th>
                <th className="px-4 py-2.5 font-medium">Action</th>
                <th className="px-4 py-2.5 font-medium">Actor</th>
                <th className="px-4 py-2.5 font-medium">Detail</th>
                <th className="px-4 py-2.5 font-medium">IP</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-border/60 last:border-0 hover:bg-muted/20">
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono tabular-nums text-muted-foreground">
                    {fmtTime(e.ts)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block whitespace-nowrap rounded-[3px] border px-1.5 py-0.5 font-mono ${toneFor(e.action)}`}>
                      {e.action}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5">
                    {e.actorName ?? <span className="text-muted-foreground">{e.actorType}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{e.detail ?? '—'}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-muted-foreground">
                    {e.ip ?? '—'}
                  </td>
                </tr>
              ))}
              {entries.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                    No audit entries match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
