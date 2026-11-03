// Ticketing/chat channel kinds (Mattermost, Jira, Redmine) — REAL transports
// against local mock servers (the notify-adapters test pattern). Covers:
// payload shapes (Mattermost text + props, Jira fields, Redmine issue body),
// the Jira credential rule (email:token → Basic, bare token → Bearer),
// created-ticket refs (AttemptResult.ref), honest refusals at the adapter
// boundary (missing/invalid settings or credentials), per-kind target
// validation, and the create-channel zod contract incl. the settings refine.

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildJiraIssueFields,
  buildMattermostPayload,
  buildRedmineIssueBody,
  parseChannelSettings,
  sendJira,
  sendMattermost,
  sendRedmine,
  DEFAULT_NOTIFY_CONFIG,
  type NotifyConfig,
  type OutgoingMessage,
} from '@/server/notify/adapters';
import { createChannelSchema } from '@/server/validation';
import { validateChannelTarget } from '@/server/alertgovernance';

const MSG: OutgoingMessage = {
  title: '[CRITICAL] Payment Gateway is DOWN',
  body: 'Probes failed. Losing ~600 tx per minute. SLA penalty exposure: 6,000,000 Tomans.',
  topic: 'detection',
  severity: 'critical',
  incidentId: 'inc-1',
  sentAt: new Date('2026-10-09T06:30:00Z'),
};

interface SeenReq {
  path: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  method?: string;
}

function httpServer(handler: (req: import('node:http').IncomingMessage, body: string, res: import('node:http').ServerResponse) => void): Promise<{ server: Server; url: string; requests: () => SeenReq[] }> {
  const seen: SeenReq[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      seen.push({ path: req.url ?? '', body: raw, headers: req.headers, method: req.method });
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

function cfg(): NotifyConfig {
  return { ...DEFAULT_NOTIFY_CONFIG, timeoutMs: 3000 };
}

// ── parseChannelSettings (untrusted boundary) ───────────────────────────────

describe('parseChannelSettings', () => {
  it('null/empty raw → ok with null value', () => {
    expect(parseChannelSettings('jira', null)).toEqual({ ok: true, value: null });
    expect(parseChannelSettings('jira', '')).toEqual({ ok: true, value: null });
  });

  it('invalid JSON and non-objects refuse honestly', () => {
    expect(parseChannelSettings('jira', '{nope')).toMatchObject({ ok: false, error: 'channel-settings-invalid-json' });
    expect(parseChannelSettings('jira', '[1,2]')).toMatchObject({ ok: false, error: 'channel-settings-not-an-object' });
    expect(parseChannelSettings('jira', 'null')).toMatchObject({ ok: false, error: 'channel-settings-not-an-object' });
  });

  it('ticketing kinds require their project key/id', () => {
    expect(parseChannelSettings('jira', '{}')).toMatchObject({ ok: false, error: 'jira-settings-missing-projectKey' });
    expect(parseChannelSettings('redmine', '{"other":1}')).toMatchObject({ ok: false, error: 'redmine-settings-missing-projectId' });
    expect(parseChannelSettings('jira', '{"projectKey":"OPS"}')).toEqual({ ok: true, value: { projectKey: 'OPS' } });
    // message kinds do not require any specific field
    expect(parseChannelSettings('mattermost', '{}')).toEqual({ ok: true, value: {} });
  });
});

// ── mattermost ──────────────────────────────────────────────────────────────

describe('mattermost adapter', () => {
  it('posts text + sentinel props and honours channel/username overrides', async () => {
    const { server, url, requests } = await httpServer((_req, _body, res) => {
      res.statusCode = 200;
      res.end('ok');
    });
    await withServer(server, async () => {
      const settings = JSON.stringify({ channel: 'ops-alerts', username: 'Sentinel' });
      const result = await sendMattermost(`${url}/hooks/abc123`, MSG, cfg(), settings);
      expect(result.ok).toBe(true);
      expect(result.statusCode).toBe(200);
      const [req] = requests();
      expect(req.path).toBe('/hooks/abc123');
      const payload = JSON.parse(req.body);
      expect(payload.text).toBe(`${MSG.title}\n${MSG.body}`);
      expect(payload.channel).toBe('ops-alerts');
      expect(payload.username).toBe('Sentinel');
      expect(payload.props.sentinel).toEqual({ topic: 'detection', severity: 'critical', incidentId: 'inc-1' });
    });
  });

  it('buildMattermostPayload omits overrides when settings are absent', () => {
    const p = buildMattermostPayload(MSG, null);
    expect(p.channel).toBeUndefined();
    expect(p.username).toBeUndefined();
    expect(p.text).toContain(MSG.title);
  });

  it('non-200 is a failed attempt (retry policy takes over)', async () => {
    const { server, url } = await httpServer((_req, _body, res) => {
      res.statusCode = 404;
      res.end('not found');
    });
    await withServer(server, async () => {
      const result = await sendMattermost(`${url}/hooks/gone`, MSG, cfg(), null);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('mattermost-404');
    });
  });
});

// ── jira ────────────────────────────────────────────────────────────────────

describe('jira adapter', () => {
  it('email:token secret → Basic auth, rest/api/2/issue path, full fields, ref = issue key', async () => {
    const { server, url, requests } = await httpServer((_req, _body, res) => {
      res.statusCode = 201;
      res.end(JSON.stringify({ id: '10001', key: 'OPS-42' }));
    });
    await withServer(server, async () => {
      const settings = JSON.stringify({ projectKey: 'OPS' });
      const result = await sendJira(url, MSG, cfg(), 'ops@example.com:ATATT-SECRET', settings);
      expect(result.ok).toBe(true);
      expect(result.statusCode).toBe(201);
      expect(result.ref).toBe('OPS-42');
      const [req] = requests();
      expect(req.method).toBe('POST');
      expect(req.path).toBe('/rest/api/2/issue');
      expect(req.headers['authorization']).toBe(`Basic ${Buffer.from('ops@example.com:ATATT-SECRET', 'utf8').toString('base64')}`);
      const body = JSON.parse(req.body) as { fields: { project: { key: string }; summary: string; description: string; issuetype: { name: string } } };
      expect(body.fields.project.key).toBe('OPS');
      expect(body.fields.summary).toBe(MSG.title);
      expect(body.fields.description).toContain(MSG.body);
      expect(body.fields.description).toContain('incident inc-1');
      expect(body.fields.issuetype.name).toBe('Task'); // documented default
    });
  });

  it('bare token → Bearer auth; issueTypeName override honoured', async () => {
    const { server, url, requests } = await httpServer((_req, _body, res) => {
      res.statusCode = 201;
      res.end(JSON.stringify({ key: 'OPS-43' }));
    });
    await withServer(server, async () => {
      const settings = JSON.stringify({ projectKey: 'OPS', issueTypeName: 'Incident' });
      await sendJira(url, MSG, cfg(), 'pat-token-123456', settings);
      const [req] = requests();
      expect(req.headers['authorization']).toBe('Bearer pat-token-123456');
      expect((JSON.parse(req.body) as { fields: { issuetype: { name: string } } }).fields.issuetype.name).toBe('Incident');
    });
  });

  it('honest refusals: missing credential, missing settings, 400 errorMessages surfaced', async () => {
    expect(await sendJira('http://127.0.0.1:9', MSG, cfg(), null, '{"projectKey":"OPS"}')).toMatchObject({ ok: false, error: 'jira-credential-not-configured' });
    expect(await sendJira('http://127.0.0.1:9', MSG, cfg(), 'token-123', null)).toMatchObject({ ok: false, error: 'jira-settings-missing-projectKey' });
    expect(buildJiraIssueFields(MSG, {})).toEqual({ error: 'jira-settings-missing-projectKey' });

    const { server, url } = await httpServer((_req, _body, res) => {
      res.statusCode = 400;
      res.end(JSON.stringify({ errorMessages: ["project 'NOPE' does not exist"] }));
    });
    await withServer(server, async () => {
      const result = await sendJira(url, MSG, cfg(), 'tok-12345678', '{"projectKey":"NOPE"}');
      expect(result.ok).toBe(false);
      expect(result.statusCode).toBe(400);
      expect(result.error).toContain("project 'NOPE' does not exist");
    });
  });
});

// ── redmine ─────────────────────────────────────────────────────────────────

describe('redmine adapter', () => {
  it('X-Redmine-API-Key header, issues.json path, issue body, ref = #id', async () => {
    const { server, url, requests } = await httpServer((_req, _body, res) => {
      res.statusCode = 201;
      res.end(JSON.stringify({ issue: { id: 771 } }));
    });
    await withServer(server, async () => {
      const settings = JSON.stringify({ projectId: 'sentinel' });
      const result = await sendRedmine(url, MSG, cfg(), 'redmine-api-key-01', settings);
      expect(result.ok).toBe(true);
      expect(result.statusCode).toBe(201);
      expect(result.ref).toBe('#771');
      const [req] = requests();
      expect(req.path).toBe('/issues.json');
      expect(req.headers['x-redmine-api-key']).toBe('redmine-api-key-01');
      const body = JSON.parse(req.body) as { issue: { subject: string; description: string; project_id: string } };
      expect(body.issue.subject).toBe(MSG.title);
      expect(body.issue.description).toContain(MSG.body);
      expect(body.issue.project_id).toBe('sentinel');
    });
  });

  it('honest refusals: missing key, missing project, non-201', async () => {
    expect(await sendRedmine('http://127.0.0.1:9', MSG, cfg(), null, '{"projectId":"p"}')).toMatchObject({ ok: false, error: 'redmine-credential-not-configured' });
    expect(await sendRedmine('http://127.0.0.1:9', MSG, cfg(), 'key-123456', null)).toMatchObject({ ok: false, error: 'redmine-settings-missing-projectId' });
    expect(buildRedmineIssueBody(MSG, {})).toEqual({ error: 'redmine-settings-missing-projectId' });

    const { server, url } = await httpServer((_req, _body, res) => {
      res.statusCode = 403;
      res.end('Forbidden');
    });
    await withServer(server, async () => {
      const result = await sendRedmine(url, MSG, cfg(), 'wrong-key-123', '{"projectId":"p"}');
      expect(result.ok).toBe(false);
      expect(result.error).toBe('redmine-403');
    });
  });
});

// ── target validation + create-channel contract ─────────────────────────────

describe('ticketing channel validation', () => {
  it('mattermost target must be http(s) URL', () => {
    expect(validateChannelTarget('mattermost', 'https://mm.example.com/hooks/abc')).toBeNull();
    expect(validateChannelTarget('mattermost', 'http://10.0.0.5:8065/hooks/x')).toBeNull();
    expect(validateChannelTarget('mattermost', 'not a url')).toMatchObject({});
    expect(validateChannelTarget('mattermost', 'ftp://x')).not.toBeNull();
  });

  it('jira/redmine targets must be base URLs without a path', () => {
    expect(validateChannelTarget('jira', 'https://jira.example.com')).toBeNull();
    expect(validateChannelTarget('jira', 'https://jira.example.com/')).toBeNull();
    expect(validateChannelTarget('jira', 'https://jira.example.com/rest/api/2')).not.toBeNull();
    expect(validateChannelTarget('redmine', 'https://rm.example.com')).toBeNull();
    expect(validateChannelTarget('redmine', 'https://rm.example.com/issues')).not.toBeNull();
  });

  it('createChannelSchema: jira/redmine require settings, bad project keys rejected', () => {
    const base = { name: 'Jira bridge', kind: 'jira', target: 'https://jira.example.com', secret: 'ops@example.com:ATATT' };
    expect(createChannelSchema.safeParse(base).success).toBe(false);
    expect(createChannelSchema.safeParse({ ...base, settings: {} }).success).toBe(false);
    // Jira project keys start with a letter (alnum/underscore after)
    expect(createChannelSchema.safeParse({ ...base, settings: { projectKey: '1OPS' } }).success).toBe(false);
    expect(createChannelSchema.safeParse({ ...base, settings: { projectKey: 'OPS' } }).success).toBe(true);
    expect(createChannelSchema.safeParse({ ...base, settings: { projectKey: 'OPS', issueTypeName: 'Incident' } }).success).toBe(true);

    const rbase = { name: 'Redmine bridge', kind: 'redmine', target: 'https://rm.example.com', secret: 'redmine-api-key-01' };
    expect(createChannelSchema.safeParse(rbase).success).toBe(false);
    expect(createChannelSchema.safeParse({ ...rbase, settings: { projectId: 'sentinel' } }).success).toBe(true);

    // mattermost: settings optional, unknown keys rejected (strict)
    const mbase = { name: 'Mattermost bridge', kind: 'mattermost', target: 'https://mm.example.com/hooks/abc' };
    expect(createChannelSchema.safeParse(mbase).success).toBe(true);
    expect(createChannelSchema.safeParse({ ...mbase, settings: { channel: 'ops', username: 'Sentinel' } }).success).toBe(true);
    expect(createChannelSchema.safeParse({ ...mbase, settings: { nope: 1 } }).success).toBe(false);

    // message kinds reject settings
    expect(createChannelSchema.safeParse({ name: 'TG', kind: 'telegram', target: '@sre', settings: { x: 1 } }).success).toBe(false);
  });
});
