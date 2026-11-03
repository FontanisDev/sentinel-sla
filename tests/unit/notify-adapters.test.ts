// Notification adapters — REAL transports against local mock servers (a
// local mock HTTP server for each adapter checks payload, signature …). Webhook HMAC signature is verified byte-for-byte; the Bot API
// shape (telegram/bale) is asserted on path + body; email runs a minimal SMTP
// conversation against a local TCP server.

import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildAckKeyboard,
  buildEmailPayload,
  buildWebhookPayload,
  DEFAULT_NOTIFY_CONFIG,
  encodeSubject,
  sendBale,
  sendEmail,
  sendSimulate,
  sendTelegram,
  sendWebhook,
  signWebhookBody,
  type NotifyConfig,
  type OutgoingMessage,
} from '@/server/notify/adapters';

const MSG: OutgoingMessage = {
  title: '[CRITICAL] Payment Gateway is DOWN',
  body: 'Probes failed. Losing ~600 tx per minute. SLA penalty exposure: 6,000,000 Tomans.',
  topic: 'detection',
  severity: 'critical',
  incidentId: 'inc-1',
  sentAt: new Date('2026-10-08T09:30:00Z'),
};

function httpServer(handler: (req: import('node:http').IncomingMessage, body: string, res: import('node:http').ServerResponse) => void): Promise<{ server: Server; url: string; requests: () => Array<{ path: string; body: string; headers: Record<string, string | string[] | undefined> }> }> {
  const seen: Array<{ path: string; body: string; headers: Record<string, string | string[] | undefined> }> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      seen.push({ path: req.url ?? '', body: raw, headers: req.headers });
      handler(req, raw, res);
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

const allServers: Array<{ close: () => void }> = [];
afterAll(() => {
  for (const s of allServers) s.close();
});

async function withServer<T>(s: { close: () => void }, fn: () => Promise<T>): Promise<T> {
  allServers.push(s);
  return fn();
}

function cfg(overrides: Partial<NotifyConfig> = {}): NotifyConfig {
  return { ...DEFAULT_NOTIFY_CONFIG, timeoutMs: 3000, ...overrides };
}

// ── webhook: payload + HMAC signature + status handling ─────────────────────

describe('webhook adapter', () => {
  it('sends the full JSON payload and signs the EXACT body bytes', async () => {
    const { server, url, requests } = await httpServer((_req, _body, res) => {
      res.statusCode = 200;
      res.end('ok');
    });
    await withServer(server, async () => {
      const secret = 'whsec-0123456789abcdef';
      const result = await sendWebhook(`${url}/hook`, MSG, cfg(), secret, 'https://s/ack?token=t');
      expect(result.ok).toBe(true);
      expect(result.statusCode).toBe(200);
      const [req] = requests();
      expect(req.path).toBe('/hook');
      const payload = JSON.parse(req.body);
      expect(payload.source).toBe('sentinel-sla');
      expect(payload.topic).toBe('detection');
      expect(payload.severity).toBe('critical');
      expect(payload.title).toBe(MSG.title);
      expect(payload.incidentId).toBe('inc-1');
      expect(payload.ackUrl).toBe('https://s/ack?token=t');
      // signature: HMAC over the raw body as transmitted
      const expected = `sha256=${createHmac('sha256', secret).update(req.body, 'utf8').digest('hex')}`;
      expect(req.headers['x-sentinel-signature']).toBe(expected);
    });
  });

  it('buildWebhookPayload + signWebhookBody compose the same signature', () => {
    const payload = buildWebhookPayload(MSG, null);
    const body = JSON.stringify(payload);
    expect(signWebhookBody(body, 's3cr3t')).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('omits the signature header when no secret is configured', async () => {
    const { server, url, requests } = await httpServer((_req, _body, res) => {
      res.statusCode = 200;
      res.end();
    });
    await withServer(server, async () => {
      await sendWebhook(`${url}/hook`, MSG, cfg(), null, null);
      expect(requests()[0].headers['x-sentinel-signature']).toBeUndefined();
    });
  });

  it('5xx responses are failures that flow into the retry policy', async () => {
    const { server, url } = await httpServer((_req, _body, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    await withServer(server, async () => {
      const result = await sendWebhook(`${url}/hook`, MSG, cfg(), null, null);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('http-500');
    });
  });
});

// ── telegram / bale: Bot API shape + inline ack keyboard ────────────────────

describe('bot API adapters (telegram + bale)', () => {
  it('telegram posts to /bot<token>/sendMessage with chat_id + text', async () => {
    const { server, url, requests } = await httpServer((_req, _body, res) => {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    });
    await withServer(server, async () => {
      const result = await sendTelegram('@sre_room', MSG, cfg({ telegramBase: url, telegramToken: 'T0K3N' }), null);
      expect(result.ok).toBe(true);
      const [req] = requests();
      expect(req.path).toBe('/botT0K3N/sendMessage');
      const body = JSON.parse(req.body);
      expect(body.chat_id).toBe('@sre_room');
      expect(body.text).toContain(MSG.title);
      expect(body.reply_markup).toBeUndefined();
    });
  });

  it('ack link becomes an inline keyboard button', () => {
    const kb = buildAckKeyboard('https://s/ack?token=t');
    expect(kb?.[0][0].url).toBe('https://s/ack?token=t');
    expect(kb?.[0][0].text).toContain('Acknowledge');
    expect(buildAckKeyboard(null)).toBeUndefined();
  });

  it('bot API errors surface their description (retryable like any failure)', async () => {
    const { server, url } = await httpServer((_req, _body, res) => {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, description: 'chat not found' }));
    });
    await withServer(server, async () => {
      const result = await sendTelegram('@gone', MSG, cfg({ telegramBase: url, telegramToken: 'T' }), null);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('bot-api-400 — chat not found');
    });
  });

  it('missing token fails with a NAMED error, never a fake success', async () => {
    const result = await sendTelegram('@room', MSG, cfg({ telegramBase: 'http://127.0.0.1:9', telegramToken: null }), null);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('bot-token-not-configured');
  });

  it('bale mirrors the Bot API on its own base URL', async () => {
    const { server, url, requests } = await httpServer((_req, _body, res) => {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    });
    await withServer(server, async () => {
      const result = await sendBale('-100200', MSG, cfg({ baleBase: url, baleToken: 'B4LE' }), 'https://s/ack?x=1');
      expect(result.ok).toBe(true);
      const [req] = requests();
      expect(req.path).toBe('/botB4LE/sendMessage');
      expect(JSON.parse(req.body).reply_markup.inline_keyboard[0][0].url).toBe('https://s/ack?x=1');
    });
  });
});

// ── email: minimal SMTP conversation ────────────────────────────────────────

describe('email adapter (minimal SMTP)', () => {
  /** Tiny SMTP server speaking exactly the subset the adapter expects. */
  function smtpServer(_expectAuth: boolean, captured: { data: string; mailFrom: string; rcptTo: string }): Promise<net.Server> {
    const server = net.createServer((socket) => {
      socket.write('220 mail.test ESMTP\r\n');
      let step = 0;
      let data = '';
      socket.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (step === 5) {
          // inside DATA — accumulate until CRLF.CRLF
          data += text;
          if (data.endsWith('\r\n.\r\n')) {
            captured.data = data.slice(0, -5);
            socket.write('250 queued\r\n');
            step = 6;
          }
          return;
        }
        const line = text.trim();
        if (step === 0 && line.startsWith('EHLO')) {
          socket.write('250-mail.test\r\n250 8BITMIME\r\n');
          step = 1;
        } else if (step === 1 && line.startsWith('AUTH PLAIN')) {
          socket.write('235 ok\r\n');
          step = 2;
        } else if ((step === 1 || step === 2) && line.startsWith('MAIL FROM:')) {
          captured.mailFrom = line;
          socket.write('250 ok\r\n');
          step = 3;
        } else if (step === 3 && line.startsWith('RCPT TO:')) {
          captured.rcptTo = line;
          socket.write('250 ok\r\n');
          step = 4;
        } else if (step === 4 && line === 'DATA') {
          socket.write('354 go\r\n');
          step = 5;
        } else if (step === 6 && line === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        }
      });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
  }

  it('completes EHLO/AUTH/MAIL/RCPT/DATA and delivers the UTF-8 payload', async () => {
    const captured = { data: '', mailFrom: '', rcptTo: '' };
    const server = await smtpServer(true, captured);
    await withServer(server, async () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const result = await sendEmail('oncall@example.ir', MSG, cfg({ smtp: { host: '127.0.0.1', port, from: 'sentinel@example.ir', user: 'u', pass: 'p' } }));
      expect(result.ok).toBe(true);
      expect(captured.mailFrom).toBe('MAIL FROM:<sentinel@example.ir>');
      expect(captured.rcptTo).toBe('RCPT TO:<oncall@example.ir>');
      expect(captured.data).toContain('Subject: [CRITICAL] Payment Gateway is DOWN'); // ASCII stays bare
      expect(captured.data).toContain('Content-Type: text/plain; charset=utf-8');
      expect(captured.data).toContain(MSG.title);
    });
  });

  it('unconfigured SMTP reports a NAMED error (never fakes delivery)', async () => {
    const result = await sendEmail('x@example.ir', MSG, cfg({ smtp: null }));
    expect(result).toEqual({ ok: false, error: 'smtp-not-configured', latencyMs: 0 });
  });

  it('buildEmailPayload dot-stuffs lines that start with a dot', () => {
    const out = buildEmailPayload('f@x', 't@x', 'Subject', 'line one\r\n.dangerous\r\nend', new Date(0));
    expect(out).toContain('\r\n..dangerous');
    expect(out.endsWith('\r\n.\r\n')).toBe(true); // RFC 5321 terminator
  });

  it('encodeSubject leaves ASCII bare and base64-encodes Persian', () => {
    expect(encodeSubject('Plain subject')).toBe('Plain subject');
    const enc = encodeSubject('اختلال بحرانی');
    expect(enc).toMatch(/^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const b64 = enc.slice('=?utf-8?B?'.length, -'?='.length);
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('اختلال بحرانی');
  });
});

describe('simulate adapter', () => {
  it('always succeeds with zero latency (offline bookkeeping)', async () => {
    const r = await sendSimulate();
    expect(r.ok).toBe(true);
    expect(r.latencyMs).toBe(0);
  });
});
