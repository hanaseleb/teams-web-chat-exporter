import type { ConversationKind, ConversationSummary, ExportMessage } from '../types/shared';

const SLACK_API_ORIGIN = 'https://slack.com';
const SLACK_FILE_HOST = 'files.slack.com';
const TOKEN_RE = /xoxc-[A-Za-z0-9-]{20,}/g;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EXPORT_FILE_BYTES = 24 * 1024 * 1024;
const MAX_RATE_LIMIT_RETRIES = 5;

type StorageReader = Pick<Storage, 'length' | 'key' | 'getItem'>;
type SlackRecord = Record<string, unknown>;
type SlackWorkspaceSession = { id: string; name: string; userId: string; token: string };
type SlackAttachmentStatus = 'embedded' | 'linked' | 'failed';
export type SlackAttachmentManifestEntry = { name: string; status: SlackAttachmentStatus };
export type SlackConversationExport = {
  workspaceName: string;
  conversationName: string;
  messages: ExportMessage[];
  attachmentsManifest: SlackAttachmentManifestEntry[];
};
export type SlackExportOptions = {
  startAt?: string | null;
  endAt?: string | null;
  includeReplies?: boolean;
  downloadFiles?: boolean;
  attachmentSizeCapMb?: number;
};
type SlackFileResult = {
  dataUrl?: string;
  status: SlackAttachmentStatus;
  href?: string;
  name: string;
  mime: string;
  size?: number;
};

type SlackApiClientOptions = {
  storages: readonly StorageReader[];
  fetcher?: typeof fetch;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export class SlackApiError extends Error {
  constructor(readonly method: string, readonly code: string, readonly status?: number) {
    super(`Slack ${method} failed (${code}).`);
    this.name = 'SlackApiError';
  }
}

function isRecord(value: unknown): value is SlackRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function boolValue(value: unknown): boolean {
  return value === true;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export function findSlackWebTokens(storages: readonly StorageReader[]): string[] {
  const found = new Set<string>();
  for (const storage of storages) {
    let length = 0;
    try { length = storage.length; } catch { continue; }
    for (let index = 0; index < length; index++) {
      try {
        const key = storage.key(index);
        const value = key ? storage.getItem(key) : null;
        if (!value) continue;
        for (const match of value.matchAll(TOKEN_RE)) found.add(match[0]);
      } catch { /* Storage can disappear while Slack changes account state. */ }
    }
  }
  return [...found];
}

export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 1_000;
}

function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return; }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function parseEnvelope(value: unknown, method: string, status: number): SlackRecord {
  if (!isRecord(value)) throw new SlackApiError(method, 'invalid-response', status);
  if (value.ok !== true) {
    const rawCode = stringValue(value.error) || '';
    const code = /^[a-z0-9_]{1,64}$/i.test(rawCode) ? rawCode : 'request-failed';
    throw new SlackApiError(method, code, status);
  }
  return value;
}

function toUnixSeconds(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : String(date.getTime() / 1_000);
}

function safeFileName(value: string): string {
  const name = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return name || 'attachment';
}

function fileUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === SLACK_FILE_HOST && !url.username && !url.password && !url.search && !url.hash
      ? url.href
      : undefined;
  } catch { return undefined; }
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength <= maxBytes ? bytes : null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('cancelled');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function compositeConversationId(workspaceId: string, conversationId: string): string {
  return `slack:${workspaceId}:${conversationId}`;
}

function compositeThreadId(workspaceId: string, conversationId: string, threadTs: string): string {
  return `slack-thread:${workspaceId}:${conversationId}:${threadTs}`;
}

function parseConversationId(value: string): { workspaceId: string; conversationId: string; threadTs?: string } {
  const thread = value.match(/^slack-thread:([^:]+):([^:]+):([0-9.]+)$/);
  if (thread) return { workspaceId: thread[1], conversationId: thread[2], threadTs: thread[3] };
  const match = value.match(/^slack:([^:]+):([^:]+)$/);
  if (!match) throw new Error('Select a Slack conversation and try again.');
  return { workspaceId: match[1], conversationId: match[2] };
}

function conversationKind(conversation: SlackRecord): ConversationKind | null {
  if (boolValue(conversation.is_im)) return 'chat';
  if (boolValue(conversation.is_mpim)) return 'group';
  if (boolValue(conversation.is_channel) || boolValue(conversation.is_group)) return 'channel';
  return null;
}

export function createSlackApiClient(options: SlackApiClientOptions) {
  const fetcher = options.fetcher || fetch;
  const wait = options.wait || defaultWait;
  let sessions: SlackWorkspaceSession[] | null = null;
  let activeController: AbortController | null = null;
  let totalDownloadedBytes = 0;
  const conversationNames = new Map<string, string>();
  const conversationKinds = new Map<string, ConversationKind>();
  const userNames = new Map<string, Promise<string>>();

  async function api(method: string, token: string, parameters: Record<string, string>, signal: AbortSignal): Promise<SlackRecord> {
    const url = new URL(`/api/${method}`, SLACK_API_ORIGIN);
    if (url.origin !== SLACK_API_ORIGIN) throw new Error('Invalid Slack API origin.');
    const body = new URLSearchParams({ token, ...parameters });
    for (let attempt = 0; attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
      let response: Response;
      try {
        response = await fetcher(url, {
          method: 'POST',
          body,
          credentials: 'include',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          signal,
        });
      } catch {
        if (signal.aborted) throw new Error('cancelled');
        throw new Error('Could not reach the Slack API. Check that Slack Web is signed in and connected.');
      }
      if (response.status === 429) {
        if (attempt + 1 === MAX_RATE_LIMIT_RETRIES) throw new SlackApiError(method, 'rate-limited', 429);
        await wait(retryAfterMs(response.headers.get('Retry-After')), signal);
        continue;
      }
      let payload: unknown;
      try { payload = await response.json(); }
      catch { throw new SlackApiError(method, 'invalid-response', response.status); }
      if (isRecord(payload) && payload.error === 'ratelimited') {
        if (attempt + 1 === MAX_RATE_LIMIT_RETRIES) throw new SlackApiError(method, 'rate-limited', 429);
        await wait(retryAfterMs(response.headers.get('Retry-After')), signal);
        continue;
      }
      if (!response.ok) throw new SlackApiError(method, `http-${response.status}`, response.status);
      return parseEnvelope(payload, method, response.status);
    }
    throw new SlackApiError(method, 'rate-limited', 429);
  }

  async function discoverSessions(signal: AbortSignal): Promise<SlackWorkspaceSession[]> {
    const tokens = findSlackWebTokens(options.storages);
    if (!tokens.length) throw new Error('Slack Web session not found. Open Slack Web, sign in, and retry.');
    const found: SlackWorkspaceSession[] = [];
    for (const token of tokens) {
      let auth: SlackRecord;
      try { auth = await api('auth.test', token, {}, signal); }
      catch (error) {
        if (error instanceof SlackApiError && ['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive'].includes(error.code)) continue;
        throw error;
      }
      const id = stringValue(auth.team_id);
      const userId = stringValue(auth.user_id);
      if (!id || !userId || found.some(session => session.id === id)) continue;
      found.push({ id, name: stringValue(auth.team) || id, userId, token });
    }
    if (!found.length) throw new Error('No active Slack Web workspace was found. Refresh Slack Web and retry.');
    return found;
  }

  async function getSessions(signal: AbortSignal): Promise<SlackWorkspaceSession[]> {
    if (sessions) return sessions;
    const found = await discoverSessions(signal);
    sessions = found;
    return found;
  }

  async function userName(session: SlackWorkspaceSession, userId: string, signal: AbortSignal): Promise<string> {
    const key = `${session.id}:${userId}`;
    let pending = userNames.get(key);
    if (!pending) {
      pending = (async () => {
        const data = await api('users.info', session.token, { user: userId }, signal);
        const user = isRecord(data.user) ? data.user : {};
        const profile = isRecord(user.profile) ? user.profile : {};
        return stringValue(profile.display_name) || stringValue(profile.real_name) || stringValue(user.real_name)
          || stringValue(user.name) || userId;
      })();
      userNames.set(key, pending);
    }
    try { return await pending; }
    catch (error) { userNames.delete(key); throw error; }
  }

  async function privateFileResponse(url: string, signal: AbortSignal): Promise<Response> {
    for (let attempt = 0; attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
      const response = await fetcher(url, {
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
        signal,
      });
      if (response.status !== 429) return response;
      if (attempt + 1 === MAX_RATE_LIMIT_RETRIES) return response;
      await wait(retryAfterMs(response.headers.get('Retry-After')), signal);
    }
    throw new Error('Slack file request failed.');
  }

  async function listConversationsForWorkspace(session: SlackWorkspaceSession, signal: AbortSignal): Promise<ConversationSummary[]> {
    const conversations: SlackRecord[] = [];
    let cursor = '';
    do {
      const response = await api('conversations.list', session.token, {
        types: 'public_channel,private_channel,im,mpim',
        limit: '200',
        ...(cursor ? { cursor } : {}),
      }, signal);
      const page = Array.isArray(response.channels) ? response.channels.filter(isRecord) : [];
      conversations.push(...page);
      const metadata = isRecord(response.response_metadata) ? response.response_metadata : {};
      cursor = stringValue(metadata.next_cursor) || '';
    } while (cursor);

    const output: ConversationSummary[] = [];
    for (const conversation of conversations) {
      const kind = conversationKind(conversation);
      const id = stringValue(conversation.id);
      if (!kind || !id) continue;
      const members = Array.isArray(conversation.members)
        ? [...new Set(conversation.members.filter((member): member is string => typeof member === 'string'))]
        : [];
      let name = stringValue(conversation.name) || '';
      let groupMembers: string[] | undefined;
      let isSelfChat = false;
      if (kind === 'chat') {
        const otherId = stringValue(conversation.user);
        if (otherId) {
          isSelfChat = otherId === session.userId;
          name = await userName(session, otherId, signal);
        }
      } else if (kind === 'group' && members.length) {
        groupMembers = [];
        for (const member of members) {
          const resolved = await userName(session, member, signal);
          if (member !== session.userId) groupMembers.push(resolved);
        }
        if (!name) name = groupMembers.join(', ');
      }
      const latest = isRecord(conversation.latest) ? stringValue(conversation.latest.ts) : undefined;
      const latestMs = latest ? Number(latest) * 1_000 : NaN;
      output.push({
        id: compositeConversationId(session.id, id),
        kind,
        name,
        ...(groupMembers?.length ? { groupMembers } : {}),
        ...(isSelfChat ? { isSelfChat: true } : {}),
        subtitle: session.name,
        ...(Number.isFinite(latestMs) ? { lastActivity: new Date(latestMs).toISOString() } : {}),
      });
      conversationKinds.set(compositeConversationId(session.id, id), kind);
    }
    return output;
  }

  async function listConversations(): Promise<{ workspaces: Array<{ id: string; name: string }>; conversations: ConversationSummary[] }> {
    return withOperation(async signal => {
      const found = await getSessions(signal);
      const conversations: ConversationSummary[] = [];
      for (const session of found) {
        const workspaceConversations = await listConversationsForWorkspace(session, signal);
        for (const conversation of workspaceConversations) conversationNames.set(conversation.id, conversation.name);
        conversations.push(...workspaceConversations);
      }
      return {
        workspaces: found.map(({ id, name }) => ({ id, name })),
        conversations: conversations.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || '')),
      };
    });
  }

  async function listThreads(id: string): Promise<ConversationSummary[]> {
    return withOperation(async signal => {
      const { workspaceId, conversationId, threadTs } = parseConversationId(id);
      if (threadTs) return [];
      const found = await getSessions(signal);
      const session = found.find(candidate => candidate.id === workspaceId);
      if (!session) throw new Error('The selected Slack workspace session is no longer available. Refresh the conversation list and retry.');
      const history = await pageMessages('conversations.history', session, conversationId, {}, signal);
      const parentName = conversationNames.get(id) || conversationId;
      const kind = conversationKinds.get(id) || 'channel';
      const threads: ConversationSummary[] = [];
      for (const root of history) {
        const ts = stringValue(root.ts);
        if (!ts || (numberValue(root.reply_count) || 0) < 1) continue;
        const threadId = compositeThreadId(session.id, conversationId, ts);
        const rootText = (stringValue(root.text) || '').replace(/\s+/g, ' ').trim();
        const threadName = rootText ? `↳ ${rootText.slice(0, 100)}` : `↳ ${ts}`;
        const latestReply = stringValue(root.latest_reply) || ts;
        const latestMs = Number(latestReply) * 1_000;
        conversationNames.set(threadId, `${parentName} - ${threadName.slice(2)}`);
        threads.push({
          id: threadId,
          kind,
          name: threadName,
          subtitle: `${session.name} · ${parentName}`,
          ...(Number.isFinite(latestMs) ? { lastActivity: new Date(latestMs).toISOString() } : {}),
        });
      }
      return threads.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
    });
  }

  async function pageMessages(method: 'conversations.history' | 'conversations.replies', session: SlackWorkspaceSession, channel: string, parameters: Record<string, string>, signal: AbortSignal): Promise<SlackRecord[]> {
    const messages: SlackRecord[] = [];
    let cursor = '';
    do {
      const response = await api(method, session.token, {
        channel,
        limit: '200',
        ...parameters,
        ...(cursor ? { cursor } : {}),
      }, signal);
      const page = Array.isArray(response.messages) ? response.messages.filter(isRecord) : [];
      messages.push(...page);
      const metadata = isRecord(response.response_metadata) ? response.response_metadata : {};
      cursor = stringValue(metadata.next_cursor) || '';
    } while (cursor);
    return messages;
  }

  async function downloadSlackFile(file: SlackRecord, signal: AbortSignal, perFileLimit: number): Promise<SlackFileResult> {
    const rawName = stringValue(file.name) || stringValue(file.title) || stringValue(file.id) || 'attachment';
    const name = safeFileName(rawName);
    const mime = stringValue(file.mimetype) || 'application/octet-stream';
    const size = numberValue(file.size);
    const href = fileUrl(file.url_private_download) || fileUrl(file.url_private);
    if (!href) return { status: 'failed', name, mime, ...(size != null ? { size } : {}) };
    if (perFileLimit > 0 && size != null && size > perFileLimit) return { status: 'linked', name, mime, href, size };
    if (totalDownloadedBytes >= MAX_EXPORT_FILE_BYTES || (size != null && size > MAX_EXPORT_FILE_BYTES - totalDownloadedBytes)) {
      return { status: 'linked', name, mime, href, ...(size != null ? { size } : {}) };
    }
    try {
      const response = await privateFileResponse(href, signal);
      if (!response.ok) return { status: 'failed', name, mime, href, ...(size != null ? { size } : {}) };
      const hardLimit = Math.min(MAX_FILE_BYTES, perFileLimit > 0 ? perFileLimit : MAX_FILE_BYTES, MAX_EXPORT_FILE_BYTES - totalDownloadedBytes);
      const bytes = await readBoundedBody(response, hardLimit, signal);
      if (!bytes) return { status: 'linked', name, mime, href, ...(size != null ? { size } : {}) };
      totalDownloadedBytes += bytes.byteLength;
      const responseMime = response.headers.get('Content-Type')?.split(';')[0]?.trim();
      return {
        status: 'embedded',
        dataUrl: bytesToDataUrl(bytes, responseMime && /^[\w.+-]+\/[\w.+-]+$/.test(responseMime) ? responseMime : mime),
        name,
        mime,
        size: bytes.byteLength,
        href,
      };
    } catch {
      if (signal.aborted) throw new Error('cancelled');
      return { status: 'failed', name, mime, href, ...(size != null ? { size } : {}) };
    }
  }

  async function convertMessage(session: SlackWorkspaceSession, channelId: string, raw: SlackRecord, rootTs: string | undefined, options: SlackExportOptions, signal: AbortSignal): Promise<{ message: ExportMessage; manifest: SlackAttachmentManifestEntry[] }> {
    const ts = stringValue(raw.ts) || '';
    const userId = stringValue(raw.user);
    const author = userId ? await userName(session, userId, signal) : stringValue(raw.username) || 'Slack';
    const files = Array.isArray(raw.files) ? raw.files.filter(isRecord) : [];
    const attachments: NonNullable<ExportMessage['attachments']> = [];
    const manifest: SlackAttachmentManifestEntry[] = [];
    const perFileLimit = Math.max(0, Number(options.attachmentSizeCapMb || 0)) * 1024 * 1024;
    for (const file of files) {
      const result = options.downloadFiles
        ? await downloadSlackFile(file, signal, perFileLimit)
        : await downloadSlackFileMetadata(file);
      const fileId = stringValue(file.id) || String(manifest.length + 1);
      const attachmentName = safeFileName(`${fileId}-${result.name}`);
      manifest.push({ name: `${channelId}/${attachmentName}`, status: result.status });
      attachments.push({
        fileAttachment: true,
        label: attachmentName,
        type: result.mime,
        ...(result.href ? { href: result.href } : {}),
        ...(result.size != null ? { size: String(result.size) } : {}),
        ...(result.dataUrl ? { dataUrl: result.dataUrl } : {}),
        ...(userId ? { owner: author } : {}),
        ...(result.status === 'failed' ? { failReason: 'unavailable' } : {}),
      });
    }
    const parsedTs = Number(ts);
    const timestamp = Number.isFinite(parsedTs) ? new Date(parsedTs * 1_000).toISOString() : undefined;
    return {
      message: {
        id: `${channelId}:${ts}`,
        ...(rootTs ? { threadId: rootTs } : {}),
        ...(author ? { author } : {}),
        ...(timestamp ? { timestamp } : {}),
        text: stringValue(raw.text) || '',
        ...(raw.edited_ts ? { edited: true } : {}),
        ...(userId === session.userId ? { isOwn: true } : {}),
        ...(attachments.length ? { attachments } : {}),
      },
      manifest,
    };
  }

  async function downloadSlackFileMetadata(file: SlackRecord): Promise<SlackFileResult> {
    const rawName = stringValue(file.name) || stringValue(file.title) || stringValue(file.id) || 'attachment';
    const href = fileUrl(file.url_private_download) || fileUrl(file.url_private);
    return {
      status: href ? 'linked' : 'failed',
      name: safeFileName(rawName),
      mime: stringValue(file.mimetype) || 'application/octet-stream',
      ...(href ? { href } : {}),
      ...(numberValue(file.size) != null ? { size: numberValue(file.size) } : {}),
    };
  }

  async function exportConversation(id: string, exportOptions: SlackExportOptions = {}): Promise<SlackConversationExport> {
    return withOperation(async signal => {
      totalDownloadedBytes = 0;
      const { workspaceId, conversationId, threadTs } = parseConversationId(id);
      const found = await getSessions(signal);
      const session = found.find(candidate => candidate.id === workspaceId);
      if (!session) throw new Error('The selected Slack workspace session is no longer available. Refresh the conversation list and retry.');

      const oldest = toUnixSeconds(exportOptions.startAt);
      const latest = toUnixSeconds(exportOptions.endAt);
      const range = {
        ...(oldest ? { oldest, inclusive: 'true' } : {}),
        ...(latest ? { latest, inclusive: 'true' } : {}),
      };
      const history = threadTs
        ? await pageMessages('conversations.replies', session, conversationId, { ts: threadTs }, signal)
        : await pageMessages('conversations.history', session, conversationId, range, signal);
      const all = new Map<string, { raw: SlackRecord; rootTs?: string }>();
      const threadStart = toUnixSeconds(exportOptions.startAt);
      const threadEnd = toUnixSeconds(exportOptions.endAt);
      for (const message of history) {
        const ts = stringValue(message.ts);
        if (!ts) continue;
        if (threadTs) {
          if (ts !== threadTs && ((threadStart && Number(ts) < Number(threadStart)) || (threadEnd && Number(ts) > Number(threadEnd)))) continue;
          if (exportOptions.includeReplies === false && ts !== threadTs) continue;
          all.set(ts, { raw: message, ...(ts !== threadTs ? { rootTs: threadTs } : {}) });
        } else {
          all.set(ts, { raw: message });
        }
      }
      if (!threadTs && exportOptions.includeReplies !== false) {
        const roots = history.filter(message => (numberValue(message.reply_count) || 0) > 0 && stringValue(message.ts));
        for (const root of roots) {
          const rootTs = stringValue(root.ts)!;
          const replies = await pageMessages('conversations.replies', session, conversationId, { ts: rootTs, ...range }, signal);
          for (const reply of replies) {
            const ts = stringValue(reply.ts);
            if (ts) all.set(ts, { raw: reply, rootTs });
          }
        }
      }
      const sorted = [...all.values()].sort((a, b) => Number(a.raw.ts) - Number(b.raw.ts));
      const messages: ExportMessage[] = [];
      const attachmentsManifest: SlackAttachmentManifestEntry[] = [];
      for (const item of sorted) {
        const converted = await convertMessage(session, conversationId, item.raw, item.rootTs, exportOptions, signal);
        messages.push(converted.message);
        attachmentsManifest.push(...converted.manifest);
      }
      return {
        workspaceName: session.name,
        conversationName: conversationNames.get(id) || conversationId,
        messages,
        attachmentsManifest,
      };
    });
  }

  async function withOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (activeController) throw new Error('A Slack request is already running.');
    const controller = new AbortController();
    activeController = controller;
    try { return await operation(controller.signal); }
    finally { if (activeController === controller) activeController = null; }
  }

  return {
    listConversations,
    exportConversation,
    listThreads,
    cancel: () => activeController?.abort(),
  };
}
