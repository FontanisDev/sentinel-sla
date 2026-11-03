// Executive digest — unit tests.
//
// Covers: the pure due/window math (daily + weekly, catch-up semantics),
// the multipart sendDocument adapter (against a local mock HTTP server,
// binary-safe), the newest-report lookup against a real temp reports dir,
// and the scheduler's run-once-per-window behaviour over a stub db.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { digestDueInstant, digestNextInstant, digestWindow, type DigestConfig } from '@/server/notify/digest';

const DAILY: DigestConfig = { frequency: 'daily', hour: 8, dayOfWeek: 6 };
const WEEKLY: DigestConfig = { frequency: 'weekly', hour: 8, dayOfWeek: 1 }; // Monday 08:00 UTC

const cfgMock = vi.hoisted(() => ({ reportsDir: '' }));
vi.mock('@/server/config', () => ({
  getConfig: () => ({
    mode: 'demo',
    notifyTransport: 'simulate',
    port: 3000,
    role: 'all',
    dataDir: '.',
    reportsDir: cfgMock.reportsDir,
    fontDir: null,
    reportPython: null,
    reportScript: '',
    pollIntervalSec: 15,
    liveFailureThreshold: 3,
    liveSuccessThreshold: 2,
    liveStaleSec: 90,
    publicBaseUrl: 'http://localhost:3000',
  }),
}));
vi.mock('@/server/locks', () => ({
  tryAcquireSchedulerLock: async () => true,
  releaseSchedulerLock: async () => undefined,
  withSchedulerLock: async <T,>(_name: string, fn: () => Promise<T>) => fn(),
}));

describe('digest window math (pure)', () => {
  it('daily covers the trailing 24h with bilingual labels', () => {
    const now = Date.UTC(2026, 9, 8, 9, 0, 0);
    const w = digestWindow({ frequency: 'daily' }, now);
    expect(w).not.toBeNull();
    expect(w!.endMs).toBe(now);
    expect(w!.startMs).toBe(now - 24 * 3600_000);
    expect(w!.labelEn).toBe('last 24 hours');
    expect(w!.labelFa).toBe('۲۴ ساعت گذشته');
  });

  it('weekly covers the trailing 7 days', () => {
    const now = Date.UTC(2026, 9, 8, 9, 0, 0);
    const w = digestWindow({ frequency: 'weekly' }, now);
    expect(w!.startMs).toBe(now - 7 * 24 * 3600_000);
    expect(w!.labelFa).toBe('۷ روز گذشته');
  });

  it('off has no window', () => {
    expect(digestWindow({ frequency: 'off' }, Date.now())).toBeNull();
  });

  it('daily due instant: same-day hour if passed, yesterday otherwise', () => {
    const now = new Date(Date.UTC(2026, 9, 8, 9, 0, 0));
    const past = digestDueInstant(DAILY, now); // 08:00 already passed
    expect(past).toEqual(new Date(Date.UTC(2026, 9, 8, 8, 0, 0)));
    const early = new Date(Date.UTC(2026, 9, 8, 7, 30, 0));
    expect(digestDueInstant(DAILY, early)).toEqual(new Date(Date.UTC(2026, 9, 7, 8, 0, 0)));
  });

  it('weekly due instant lands on the configured weekday', () => {
    // 2026-10-08 is a Thursday; Monday 08:00 → 2026-10-05.
    const now = new Date(Date.UTC(2026, 9, 8, 9, 0, 0));
    const due = digestDueInstant(WEEKLY, now);
    expect(due).toEqual(new Date(Date.UTC(2026, 9, 5, 8, 0, 0)));
    expect(due!.getUTCDay()).toBe(1);
  });

  it('off and malformed configs never fire', () => {
    const now = new Date(Date.UTC(2026, 9, 8, 9, 0, 0));
    expect(digestDueInstant({ frequency: 'off', hour: 8, dayOfWeek: 1 }, now)).toBeNull();
    expect(digestDueInstant({ frequency: 'daily', hour: 24, dayOfWeek: 1 }, now)).toBeNull();
    expect(digestDueInstant({ frequency: 'daily', hour: -1, dayOfWeek: 1 }, now)).toBeNull();
    expect(digestDueInstant({ frequency: 'weekly', hour: 8, dayOfWeek: 7 }, now)).toBeNull();
  });

  it('next instant is strictly in the future', () => {
    const now = new Date(Date.UTC(2026, 9, 8, 9, 0, 0));
    const next = digestNextInstant(DAILY, now);
    expect(next!.getTime()).toBeGreaterThan(now.getTime());
    expect(next).toEqual(new Date(Date.UTC(2026, 9, 9, 8, 0, 0)));
    const nextWeekly = digestNextInstant(WEEKLY, now);
    expect(nextWeekly).toEqual(new Date(Date.UTC(2026, 9, 12, 8, 0, 0))); // next Monday
  });
});

// ── sendDocument adapter (multipart, binary-safe mock) ──────────────────────

interface Seen {
  path: string;
  body: Buffer;
  contentType: string | undefined;
}

function binaryServer(handler: (req: IncomingMessage, body: Buffer, res: ServerResponse) => void): Promise<{
  server: Server;
  url: string;
  requests: () => Seen[];
}> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ path: req.url ?? '', body, contentType: req.headers['content-type'] });
      handler(req, body, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, requests: () => seen });
    });
  });
}

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

const DOC_MSG = {
  title: 'گزارش خلاصه سنتیل — ۲۴ ساعت گذشته',
  body: 'در بازه ۲۴ ساعت گذشته: ۳ مورد اختلال ثبت شد.',
  topic: 'digest',
  severity: 'info',
  sentAt: new Date('2026-10-08T08:00:00Z'),
  document: { filename: 'sentinel-sla-report-2026-10-08.pdf', data: Buffer.from('%PDF-1.7 fake pdf bytes') },
};

describe('botApiSendDocument (digest PDF attach)', () => {
  it('uploads the PDF as multipart/form-data to /bot<token>/sendDocument', async () => {
    const { botApiSendDocument } = await import('@/server/notify/adapters');
    const { server, url, requests } = await binaryServer((_req, _body, res) => {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    });
    servers.push(server);
    const result = await botApiSendDocument(url, 'TEST-TOKEN', '12345', DOC_MSG, 3000);
    expect(result.ok).toBe(true);
    const seen = requests()[0];
    expect(seen.path).toBe('/botTEST-TOKEN/sendDocument');
    expect(seen.contentType).toMatch(/^multipart\/form-data; boundary=/);
    const bodyText = seen.body.toString('utf8');
    expect(bodyText).toContain('sentinel-sla-report-2026-10-08.pdf');
    expect(bodyText).toContain('%PDF-1.7');
    expect(bodyText).toContain('name="chat_id"');
    expect(bodyText).toContain('name="document"');
  });

  it('fails honestly on a 500 with the Bot API error shape', async () => {
    const { botApiSendDocument } = await import('@/server/notify/adapters');
    const { server, url } = await binaryServer((_req, _body, res) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, description: 'Internal Server Error' }));
    });
    servers.push(server);
    const result = await botApiSendDocument(url, 'TEST-TOKEN', '12345', DOC_MSG, 3000);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(500);
    expect(result.error).toContain('bot-api-500');
  });

  it('refuses to send without a token or a document', async () => {
    const { botApiSendDocument } = await import('@/server/notify/adapters');
    const noToken = await botApiSendDocument('http://127.0.0.1:1', '', '1', DOC_MSG, 500);
    expect(noToken).toMatchObject({ ok: false, error: 'bot-token-not-configured' });
    const noDoc = await botApiSendDocument(
      'http://127.0.0.1:1',
      'T',
      '1',
      { ...DOC_MSG, document: null },
      500,
    );
    expect(noDoc).toMatchObject({ ok: false, error: 'no-document' });
  });
});

// ── newest-report lookup (real temp dir) ────────────────────────────────────

describe('latestReportDocument', () => {
  it('returns the newest sentinel-sla-report-*.pdf and null when none', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sentinel-reports-'));
    try {
      await writeFile(path.join(dir, 'sentinel-sla-report-a.pdf'), Buffer.from('%PDF a'));
      await writeFile(path.join(dir, 'sentinel-sla-report-b.pdf'), Buffer.from('%PDF b'));
      await writeFile(path.join(dir, 'unrelated.txt'), 'nope');
      await writeFile(path.join(dir, 'sentinel-sla-report-c.pdf.tmp'), 'partial upload');
      const files = await readdir(dir);
      expect(files.filter((f) => f.endsWith('.pdf')).length).toBe(2);

      cfgMock.reportsDir = dir;
      const { latestReportDocument } = await import('@/server/notify/outbox');
      const doc = await latestReportDocument();
      expect(doc).not.toBeNull();
      expect(doc!.filename).toMatch(/^sentinel-sla-report-.*\.pdf$/);
      expect(doc!.data.toString('utf8')).toMatch(/^%PDF/);

      cfgMock.reportsDir = path.join(dir, 'missing');
      expect(await latestReportDocument()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── scheduler over a stub db ────────────────────────────────────────────────

const store = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  alerts: [] as Array<Record<string, unknown>>,
  outbox: [] as Array<Record<string, unknown>>,
}));

function makeDb(): any {
  return {
    integrationSetting: {
      findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
        where.key.in.filter((k) => store.settings.has(k)).map((k) => ({ key: k, value: store.settings.get(k) })),
      findUnique: async ({ where }: { where: { key: string } }) =>
        store.settings.has(where.key) ? { key: where.key, value: store.settings.get(where.key) } : null,
      upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
        store.settings.set(where.key, update.value);
        return { key: where.key, value: update.value };
      },
    },
    alert: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `al-${store.alerts.length + 1}`, ...data };
        store.alerts.push(row);
        return row;
      },
    },
    notificationOutbox: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `ob-${store.outbox.length + 1}`, ...data };
        store.outbox.push(row);
        return row;
      },
    },
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join(' ? ');
      if (sql.includes('FROM NotificationChannel')) return []; // no channels → dashboard-only
      if (sql.includes('FROM Incident') && sql.includes('COUNT(*)')) {
        return [{ n: 2, resolvedN: 2, openN: 0, lostTx: 1200, revenueLoss: 9_000_000, penalty: 3_000_000 }];
      }
      if (sql.includes('FROM Incident') && sql.includes('GROUP BY')) {
        return [{ name: 'Payment Gateway', nameFa: 'درگاه پرداخت', loss: 7_000_000 }];
      }
      return [];
    },
    $executeRaw: async () => 1,
  };
}

vi.mock('@/lib/db', () => ({ db: makeDb() }));

import { runDigestNow, runDueDigests } from '@/server/notify/digest';

describe('digest scheduler (stub db)', () => {
  beforeEach(() => {
    store.settings.clear();
    store.alerts.length = 0;
    store.outbox.length = 0;
  });

  it('runDigestNow emits an executive digest row and records the run', async () => {
    store.settings.set('digestFrequency', 'daily');
    store.settings.set('digestHour', '8');
    const result = await runDigestNow(Date.UTC(2026, 9, 8, 9, 0, 0));
    expect(result.ok).toBe(true);
    expect(result.enqueued).toBe(0); // no channels — dashboard-only, honest
    expect(store.alerts.length).toBe(1);
    expect(store.alerts[0].audience).toBe('executive');
    expect(String(store.alerts[0].title)).toContain('گزارش خلاصه');
    expect(store.settings.get('digestLastRunOk')).toBe('1');
  });

  it('runDigestNow refuses honestly when the digest is off', async () => {
    const result = await runDigestNow();
    expect(result).toMatchObject({ ok: false, error: 'digest-disabled' });
    expect(store.alerts.length).toBe(0);
  });

  it('runDueDigests fires once per window (catch-up-once)', async () => {
    store.settings.set('digestFrequency', 'daily');
    store.settings.set('digestHour', '8');
    const t1 = Date.UTC(2026, 9, 8, 9, 0, 0); // after the 08:00 slot
    expect(await runDueDigests(new Date(t1))).toBe(1);
    // same window again → no double-send
    expect(await runDueDigests(new Date(t1 + 3600_000))).toBe(0);
    // next day's slot → fires again
    expect(await runDueDigests(new Date(Date.UTC(2026, 9, 9, 8, 30, 0)))).toBe(1);
  });

  it('runDueDigests is a no-op when off or already run for the current window', async () => {
    store.settings.set('digestFrequency', 'off');
    expect(await runDueDigests(new Date())).toBe(0);
    store.settings.set('digestFrequency', 'daily');
    store.settings.set('digestHour', '8');
    // already ran today, just after the 08:00 slot → today's slot is covered;
    // yesterday's instant is older than lastRunAt → nothing due
    store.settings.set('digestLastRunAt', new Date(Date.UTC(2026, 9, 8, 8, 30, 0)).toISOString());
    expect(await runDueDigests(new Date(Date.UTC(2026, 9, 8, 9, 0, 0)))).toBe(0);
  });
});
