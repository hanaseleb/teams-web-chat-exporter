import { describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import { buildDiagnosticJson } from '../src/utils/diagnostics';
import { createSlackApiClient, findSlackWebTokens, retryAfterMs } from '../src/content/slack-api';

const tokenA = 'xoxc-workspace-token-alpha-0123456789abcdef';
const tokenB = 'xoxc-workspace-token-beta-0123456789abcdef';

function makeStorage(values: Record<string, string>) {
  const entries = Object.entries(values);
  return {
    get length() { return entries.length; },
    key(index: number) { return entries[index]?.[0] ?? null; },
    getItem(key: string) { return entries.find(([entry]) => entry === key)?.[1] ?? null; },
  };
}

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function tokenFrom(init?: RequestInit): string {
  return new URLSearchParams(String(init?.body || '')).get('token') || '';
}

function diagnostics(logLine = ''): Promise<string> {
  return buildDiagnosticJson({
    env: {
      extensionVersion: '1.0', buildStamp: 'test', manifestVersion: 3,
      browserBrand: 'Chrome', browserVersion: '1', os: 'Linux', teamsTabUrl: null,
      teamsHost: null, locale: 'en', documentLang: null, prefersColorScheme: 'light',
    },
    permissions: { declaredHostPermissions: [], optionalAllUrlsGranted: null },
    options: { available: true, values: {} },
    idb: { available: false, reason: 'not available' },
    exports: { available: true, items: [] },
    logs: { entries: logLine ? [{ src: 'content', ts: 1, level: 'log', line: logLine }] : [], bytesUsed: 0, persistEnabled: false },
    probes: { state: 'not-run' },
  });
}

describe('Slack Web API access', () => {
  it('discovers multiple workspaces and lists channels, DMs, and group DMs with workspace labels', async () => {
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      const token = tokenFrom(init);
      if (url.pathname.endsWith('/auth.test')) {
        return json(token === tokenA
          ? { ok: true, team_id: 'T_ALPHA', team: 'Alpha Workspace', user_id: 'U_SELF' }
          : { ok: true, team_id: 'T_BETA', team: 'Beta Workspace', user_id: 'U_SELF' });
      }
      if (url.pathname.endsWith('/conversations.list')) {
        if (token === tokenA && new URLSearchParams(String(init?.body)).get('cursor') !== 'next-page') {
          return json({ ok: true, channels: [{ id: 'C_GENERAL', name: 'general', is_channel: true, latest: { ts: '1700000000.0' } }], response_metadata: { next_cursor: 'next-page' } });
        }
        if (token === tokenA) {
          return json({ ok: true, channels: [{ id: 'D_ALICE', is_im: true, user: 'U_ALICE' }], response_metadata: { next_cursor: '' } });
        }
        return json({ ok: true, channels: [{ id: 'G_GROUP', is_mpim: true, members: ['U_SELF', 'U_BOB'] }], response_metadata: { next_cursor: '' } });
      }
      if (url.pathname.endsWith('/users.info')) {
        const user = new URLSearchParams(String(init?.body)).get('user');
        return json({ ok: true, user: { id: user, name: user?.toLowerCase(), profile: { display_name: user === 'U_ALICE' ? 'Alice Example' : 'Bob Example' } } });
      }
      throw new Error('Unexpected URL');
    });
    const client = createSlackApiClient({
      storages: [makeStorage({ localConfig: `{"tokens":["${tokenA}"]}` }), makeStorage({ session: tokenB })],
      fetcher,
    });

    const result = await client.listConversations();
    expect(result.workspaces).toEqual([
      { id: 'T_ALPHA', name: 'Alpha Workspace' },
      { id: 'T_BETA', name: 'Beta Workspace' },
    ]);
    expect(result.conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'slack:T_ALPHA:C_GENERAL', kind: 'channel', name: 'general', subtitle: 'Alpha Workspace' }),
      expect.objectContaining({ id: 'slack:T_ALPHA:D_ALICE', kind: 'chat', name: 'Alice Example', subtitle: 'Alpha Workspace' }),
      expect.objectContaining({ id: 'slack:T_BETA:G_GROUP', kind: 'group', groupMembers: ['Bob Example'], subtitle: 'Beta Workspace' }),
    ]));
    const listCalls = (fetcher as ReturnType<typeof vi.fn>).mock.calls
      .filter(([input]) => String(input).endsWith('/conversations.list'));
    expect(listCalls).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain(tokenA);
    expect(JSON.stringify(result)).not.toContain(tokenB);
  });

  it('collects every history page and converts author, timestamp, text, and private-file attachment', async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      const body = String(init?.body || '');
      requests.push({ url: String(url), body });
      if (url.pathname.endsWith('/auth.test')) return json({ ok: true, team_id: 'T_ALPHA', team: 'Alpha Workspace', user_id: 'U_SELF' });
      if (url.pathname.endsWith('/conversations.history')) {
        const cursor = new URLSearchParams(body).get('cursor');
        return cursor === 'older'
          ? json({ ok: true, messages: [{ ts: '1700000000.5', user: 'U_ALICE', text: 'older message' }], response_metadata: { next_cursor: '' } })
          : json({ ok: true, messages: [{ ts: '1700000001.0', user: 'U_SELF', text: 'new message', files: [{ id: 'F_PLAN', name: 'plan.txt', mimetype: 'text/plain', size: 3, url_private: 'https://files.slack.com/files-pri/T_ALPHA-F_PLAN/plan.txt' }] }], response_metadata: { next_cursor: 'older' } });
      }
      if (url.pathname.endsWith('/users.info')) {
        const user = new URLSearchParams(body).get('user');
        return json({ ok: true, user: { id: user, name: user, profile: { display_name: 'Alice Example' } } });
      }
      if (url.hostname === 'files.slack.com') return new Response('abc', { headers: { 'Content-Type': 'text/plain' } });
      throw new Error('Unexpected URL');
    });
    const client = createSlackApiClient({ storages: [makeStorage({ auth: tokenA })], fetcher });

    const result = await client.exportConversation('slack:T_ALPHA:C_GENERAL', { includeReplies: false, downloadFiles: true });
    expect(result.workspaceName).toBe('Alpha Workspace');
    expect(result.messages.map(message => message.text)).toEqual(['older message', 'new message']);
    expect(result.messages[0]).toMatchObject({ author: 'Alice Example', timestamp: new Date(1700000000.5 * 1_000).toISOString() });
    expect(result.messages[1].timestamp).toBe(new Date(1700000001 * 1_000).toISOString());
    expect(result.messages[1].attachments?.[0]).toMatchObject({
      fileAttachment: true, label: 'F_PLAN-plan.txt', type: 'text/plain', href: 'https://files.slack.com/files-pri/T_ALPHA-F_PLAN/plan.txt',
      dataUrl: 'data:text/plain;base64,YWJj',
    });
    expect(result.attachmentsManifest).toEqual([{ name: 'C_GENERAL/F_PLAN-plan.txt', status: 'embedded' }]);
    expect(requests.every(request => new URL(request.url).origin === 'https://slack.com' || new URL(request.url).origin === 'https://files.slack.com')).toBe(true);
    expect(requests.every(request => !request.url.includes(tokenA))).toBe(true);
  });

  it('paginates thread replies and assigns them to the root thread', async () => {
    const fetcher: typeof fetch = vi.fn(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auth.test')) return json({ ok: true, team_id: 'T_ALPHA', team: 'Alpha Workspace', user_id: 'U_SELF' });
      if (url.pathname.endsWith('/conversations.history')) return json({ ok: true, messages: [{ ts: '1700000000.0', user: 'U_ALICE', text: 'question', reply_count: 1 }], response_metadata: { next_cursor: '' } });
      if (url.pathname.endsWith('/conversations.replies')) return json({ ok: true, messages: [
        { ts: '1700000000.0', user: 'U_ALICE', text: 'question' },
        { ts: '1700000002.0', user: 'U_SELF', text: 'answer', thread_ts: '1700000000.0' },
      ], response_metadata: { next_cursor: '' } });
      if (url.pathname.endsWith('/users.info')) return json({ ok: true, user: { id: 'U_ALICE', name: 'alice' } });
      throw new Error('Unexpected URL');
    });
    const client = createSlackApiClient({ storages: [makeStorage({ auth: tokenA })], fetcher });

    const result = await client.exportConversation('slack:T_ALPHA:C_GENERAL', { includeReplies: true });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toMatchObject({ text: 'answer', threadId: '1700000000.0' });
    expect((fetcher as ReturnType<typeof vi.fn>).mock.calls.some(([input]) => String(input).endsWith('/conversations.replies'))).toBe(true);
  });

  it('lists threads for a selected conversation and exports the selected thread by itself', async () => {
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auth.test')) return json({ ok: true, team_id: 'T_ALPHA', team: 'Alpha Workspace', user_id: 'U_SELF' });
      if (url.pathname.endsWith('/conversations.list')) return json({ ok: true, channels: [{ id: 'C_GENERAL', name: 'general', is_channel: true }], response_metadata: { next_cursor: '' } });
      if (url.pathname.endsWith('/conversations.history')) return json({ ok: true, messages: [
        { ts: '1700000000.0', user: 'U_ALICE', text: 'Question about planning', reply_count: 1, latest_reply: '1700000002.0' },
      ], response_metadata: { next_cursor: '' } });
      if (url.pathname.endsWith('/conversations.replies')) {
        expect(new URLSearchParams(String(init?.body)).get('ts')).toBe('1700000000.0');
        return json({ ok: true, messages: [
          { ts: '1700000000.0', user: 'U_ALICE', text: 'Question about planning' },
          { ts: '1700000002.0', user: 'U_SELF', text: 'Here is the answer', thread_ts: '1700000000.0' },
        ], response_metadata: { next_cursor: '' } });
      }
      if (url.pathname.endsWith('/users.info')) {
        const user = new URLSearchParams(String(init?.body)).get('user');
        return json({ ok: true, user: { id: user, name: user?.toLowerCase(), profile: { display_name: user === 'U_ALICE' ? 'Alice Example' : 'Self Example' } } });
      }
      throw new Error('Unexpected URL');
    });
    const client = createSlackApiClient({ storages: [makeStorage({ auth: tokenA })], fetcher });
    await client.listConversations();

    const threads = await client.listThreads('slack:T_ALPHA:C_GENERAL');
    expect(threads).toEqual([expect.objectContaining({
      id: 'slack-thread:T_ALPHA:C_GENERAL:1700000000.0',
      kind: 'channel',
      name: '↳ Question about planning',
      subtitle: 'Alpha Workspace · general',
    })]);
    const result = await client.exportConversation(threads[0].id, { includeReplies: true });
    expect(result.conversationName).toBe('general - Question about planning');
    expect(result.messages.map(message => message.text)).toEqual(['Question about planning', 'Here is the answer']);
    expect(result.messages[1]).toMatchObject({ threadId: '1700000000.0', author: 'Self Example', isOwn: true });
  });

  it('uses only Slack API routes when talking to a loopback mock server', async () => {
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const payload = request.url === '/api/auth.test'
        ? { ok: true, team_id: 'T_LOCAL', team: 'Local Workspace', user_id: 'U_SELF' }
        : request.url === '/api/conversations.list'
          ? { ok: true, channels: [{ id: 'C_LOCAL', name: 'mock-room', is_channel: true }], response_metadata: { next_cursor: '' } }
          : request.url === '/api/users.info'
            ? { ok: true, user: { id: 'U_SELF', name: 'local-user' } }
          : request.url === '/api/conversations.history' && form.get('channel') === 'C_LOCAL'
            ? { ok: true, messages: [{ ts: '1700000000.0', user: 'U_SELF', text: 'loopback message' }], response_metadata: { next_cursor: '' } }
            : { ok: false, error: 'unknown_method' };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback server did not bind to a TCP port.');
    const fetcher: typeof fetch = (input, init) => new Promise((resolve, reject) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const localRequest = httpRequest({
        hostname: '127.0.0.1',
        port: address.port,
        path: new URL(String(input)).pathname,
        method: init?.method,
        headers,
      }, localResponse => {
        const chunks: Buffer[] = [];
        localResponse.on('data', chunk => chunks.push(Buffer.from(chunk)));
        localResponse.on('end', () => resolve(new Response(Buffer.concat(chunks), {
          status: localResponse.statusCode || 200,
          headers: Object.fromEntries(Object.entries(localResponse.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)])),
        })));
      });
      localRequest.on('error', reject);
      localRequest.end(String(init?.body || ''));
    });
    try {
      const client = createSlackApiClient({ storages: [makeStorage({ auth: tokenA })], fetcher });
      const listed = await client.listConversations();
      const exported = await client.exportConversation('slack:T_LOCAL:C_LOCAL', { includeReplies: false });
      expect(listed.conversations).toEqual([expect.objectContaining({ id: 'slack:T_LOCAL:C_LOCAL', name: 'mock-room' })]);
      expect(exported.messages.map(message => message.text)).toEqual(['loopback message']);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('waits for Retry-After and retries Slack 429 responses', async () => {
    const wait = vi.fn(async () => {});
    let authAttempts = 0;
    const fetcher: typeof fetch = vi.fn(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auth.test') && authAttempts++ === 0) {
        return json({ ok: false, error: 'ratelimited' }, 429, { 'Retry-After': '2' });
      }
      if (url.pathname.endsWith('/auth.test')) return json({ ok: true, team_id: 'T_ALPHA', team: 'Alpha Workspace', user_id: 'U_SELF' });
      if (url.pathname.endsWith('/conversations.list')) return json({ ok: true, channels: [], response_metadata: { next_cursor: '' } });
      throw new Error('Unexpected URL');
    });
    const client = createSlackApiClient({ storages: [makeStorage({ auth: tokenA })], fetcher, wait });

    expect(await client.listConversations()).toMatchObject({ workspaces: [{ id: 'T_ALPHA' }], conversations: [] });
    expect(wait).toHaveBeenCalledWith(2_000, expect.anything());
    expect(authAttempts).toBe(2);
    expect(retryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:00 GMT'))).toBe(60_000);
  });

  it('marks unavailable file URLs as failed and keeps credentials out of results and Diagnostics', async () => {
    const fetcher: typeof fetch = vi.fn(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/auth.test')) return json({ ok: true, team_id: 'T_ALPHA', team: 'Alpha Workspace', user_id: 'U_SELF' });
      if (url.pathname.endsWith('/conversations.history')) return json({ ok: true, messages: [{
        ts: '1700000000.0', user: 'U_SELF', text: 'file note', files: [
          { id: 'F_LINK', name: 'linked.txt', url_private: 'https://files.slack.com/files-pri/T_ALPHA-F_LINK/linked.txt' },
          { id: 'F_BAD', name: 'unsafe.txt', url_private: 'https://outside.invalid/unsafe.txt' },
        ],
      }], response_metadata: { next_cursor: '' } });
      if (url.pathname.endsWith('/users.info')) return json({ ok: true, user: { id: 'U_SELF', name: 'self' } });
      throw new Error('Unexpected URL');
    });
    const client = createSlackApiClient({ storages: [makeStorage({ localConfig: tokenA })], fetcher });

    const result = await client.exportConversation('slack:T_ALPHA:C_GENERAL', { includeReplies: false, downloadFiles: false });
    const report = await diagnostics();
    expect(result.attachmentsManifest.map(item => item.status)).toEqual(['linked', 'failed']);
    expect(JSON.stringify(result)).not.toContain(tokenA);
    expect(report).not.toContain(tokenA);
    expect((fetcher as ReturnType<typeof vi.fn>).mock.calls.some(([input]) => String(input).includes('outside.invalid'))).toBe(false);
  });

  it('finds only Slack Web xoxc tokens without storing them in returned workspace data', () => {
    const storages = [makeStorage({ first: `${tokenA} and ${tokenA}`, other: 'xoxp-not-a-web-token-0123456789' }), makeStorage({ second: tokenB })];
    expect(findSlackWebTokens(storages)).toEqual([tokenA, tokenB]);
  });
});
