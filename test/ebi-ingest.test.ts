import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_OPTIONS, loadOptions } from '../src/utils/options';
import {
  EBI_INGEST_SETTINGS_KEY,
  EBI_RECENT_PROJECTS_KEY,
  buildIngestContent,
  ingestPermissionPattern,
  loadIngestSettings,
  normalizeIngestBaseUrl,
  prepareIngestRequest,
  rememberRecentProjectName,
  sendToEbiIngest,
} from '../src/utils/ebi-ingest';
import { buildDiagnosticJson } from '../src/utils/diagnostics';

const settings = { baseUrl: 'http://127.0.0.1:43127/', token: 'secret-ingest-token' };

describe('Ebi Ingest', () => {
  it('builds an authenticated /api/ingest request with the export and required tag', async () => {
    const file = new Blob(['same export bytes'], { type: 'application/zip' });
    const request = await prepareIngestRequest(
      settings,
      { blob: file, filename: 'TeamsExport_bundle.zip', mime: 'application/zip' },
      'Product Alpha',
      ['Roadmap', 'Project chat'],
    );
    const body = JSON.parse(request.body);

    expect(request.url).toBe('http://127.0.0.1:43127/api/ingest');
    expect(request.headers).toEqual({
      Authorization: 'Bearer secret-ingest-token',
      'Content-Type': 'application/json',
    });
    expect(body.content).toContain('"Product Alpha"');
    expect(body.content).toContain('"Roadmap"');
    expect(body.content).toContain('Teams Export/<会話名>/');
    expect(body.attachments).toEqual([{
      filename: 'TeamsExport_bundle.zip',
      mimetype: 'application/zip',
      data: btoa('same export bytes'),
    }]);
    expect(body.attachments_manifest).toEqual([{ name: 'TeamsExport_bundle.zip', status: 'embedded' }]);
    expect(body.tags).toEqual(['teams-import']);
  });

  it('keeps the destination prompt free of reply-draft marker phrases', () => {
    const content = buildIngestContent('Product Alpha', ['Roadmap']);
    expect(content).not.toContain('Microsoft Teams のスレッドが、サーバー上に1発言1ファイルで同期されています');
    expect(content).not.toContain('[Teams Channel Exporter]');
    expect(content).not.toContain('source: Teams Channel Exporter');
    expect(content).toContain('内容を要約・再構成・改変せず');
  });

  it('rejects requests over 50 MiB before reading or sending the attachment', async () => {
    const arrayBuffer = vi.fn();
    const blob = { size: 40 * 1024 * 1024, arrayBuffer } as unknown as Blob;
    await expect(prepareIngestRequest(
      settings,
      { blob, filename: 'large.zip', mime: 'application/zip' },
      'Product Alpha',
      ['Roadmap'],
    )).rejects.toThrow(/maximum 50 MiB/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it.each([
    { status: 401, detail: 'Invalid bearer token' },
    { status: 503, detail: 'Ingest is disabled' },
    { status: 409, detail: 'Attachment delivery is incomplete' },
  ])('reports HTTP $status response reasons and redacts the token', async ({ status, detail }) => {
    const fetcher: typeof fetch = async () => new Response(
      JSON.stringify({ error: `${detail}: ${settings.token}` }),
      { status },
    );
    await expect(sendToEbiIngest(
      settings,
      { blob: new Blob(['x']), filename: 'export.txt', mime: 'text/plain' },
      'Product Alpha',
      ['Roadmap'],
      fetcher,
    )).rejects.toMatchObject({ status, detail: expect.stringContaining(detail) });
    await expect(sendToEbiIngest(
      settings,
      { blob: new Blob(['x']), filename: 'export.txt', mime: 'text/plain' },
      'Product Alpha',
      ['Roadmap'],
      fetcher,
    )).rejects.not.toThrow(settings.token);
    if (status === 503) {
      await expect(sendToEbiIngest(
        settings,
        { blob: new Blob(['x']), filename: 'export.txt', mime: 'text/plain' },
        'Product Alpha',
        ['Roadmap'],
        fetcher,
      )).rejects.toThrow(/server-side Ingest API is disabled \(503\)/);
    }
  });

  it('sends the request once and returns the API response', async () => {
    const fetcher: typeof fetch = async (input, init) => {
      expect(String(input)).toBe('http://127.0.0.1:43127/api/ingest');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${settings.token}`);
      expect(JSON.parse(String(init?.body)).tags).toEqual(['teams-import']);
      return new Response(JSON.stringify({ status: 'spawned', thread_id: 'test-thread' }), { status: 201 });
    };
    await expect(sendToEbiIngest(
      settings,
      { blob: new Blob(['body']), filename: 'export.txt', mime: 'text/plain' },
      'Product Alpha',
      ['Roadmap'],
      fetcher,
    )).resolves.toEqual({ status: 'spawned', thread_id: 'test-thread' });
  });

  it('does not include the separately stored token in the Diagnostics options report', async () => {
    await chrome.storage.local.set({
      [EBI_INGEST_SETTINGS_KEY]: settings,
      teamsExporterOptions: DEFAULT_OPTIONS,
    });
    const options = await loadOptions(chrome.storage);
    const report = await buildDiagnosticJson({
      env: {
        extensionVersion: '1.0', buildStamp: 'test', manifestVersion: 3,
        browserBrand: 'Chrome', browserVersion: '1', os: 'Linux', teamsTabUrl: null,
        teamsHost: null, locale: 'en', documentLang: null, prefersColorScheme: 'light',
      },
      permissions: { declaredHostPermissions: [], optionalAllUrlsGranted: null },
      options: { available: true, values: options },
      idb: { available: false, reason: 'not available' },
      exports: { available: true, items: [] },
      logs: { entries: [], bytesUsed: null, persistEnabled: false },
      probes: { state: 'not-run' },
    });
    expect(report).not.toContain(settings.token);
  });

  it('validates the connection URL and keeps only the ten most recent project names', async () => {
    expect(normalizeIngestBaseUrl(' https://relay.test/prefix/ ')).toBe('https://relay.test/prefix');
    expect(ingestPermissionPattern('https://relay.test/prefix')).toBe('https://relay.test/*');
    expect(() => normalizeIngestBaseUrl('ftp://relay.test')).toThrow(/HTTP\(S\)/);

    await chrome.storage.local.set({
      [EBI_INGEST_SETTINGS_KEY]: settings,
      [EBI_RECENT_PROJECTS_KEY]: ['Old', 'Project 1'],
    });
    const names = await rememberRecentProjectName(chrome.storage.local, 'New Project');
    expect(names).toEqual(['New Project', 'Old', 'Project 1']);
    expect((await chrome.storage.local.get(EBI_RECENT_PROJECTS_KEY))[EBI_RECENT_PROJECTS_KEY]).toEqual(names);
    expect(await loadIngestSettings(chrome.storage.local)).toEqual({
      baseUrl: 'http://127.0.0.1:43127',
      token: settings.token,
    });
  });
});
