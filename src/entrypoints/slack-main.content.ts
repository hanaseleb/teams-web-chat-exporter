import { defineContentScript } from 'wxt/sandbox';
import { createSlackApiClient, type SlackExportOptions } from '../content/slack-api';
import { SLACK_MATCH_PATTERNS } from '../utils/slack-urls';

const BRIDGE = '__teams_web_chat_exporter_slack__';

export default defineContentScript({
  matches: SLACK_MATCH_PATTERNS,
  world: 'MAIN',
  runAt: 'document_idle',
  main() {
    const storages: Storage[] = [];
    try { storages.push(window.localStorage); } catch { /* unavailable in restricted contexts */ }
    try { storages.push(window.sessionStorage); } catch { /* unavailable in restricted contexts */ }
    const client = createSlackApiClient({ storages });
    window.addEventListener('message', event => {
      if (event.source !== window || event.origin !== location.origin) return;
      const request = event.data as { bridge?: unknown; id?: unknown; action?: unknown; payload?: unknown };
      if (request?.bridge !== BRIDGE || typeof request.id !== 'string') return;
      if (request.action === 'cancel') {
        client.cancel();
        return;
      }
      const work = request.action === 'list'
        ? client.listConversations()
        : request.action === 'threads' && typeof (request.payload as { conversationId?: unknown } | null)?.conversationId === 'string'
          ? client.listThreads((request.payload as { conversationId: string }).conversationId)
        : request.action === 'export' && typeof (request.payload as { id?: unknown } | null)?.id === 'string'
          ? client.exportConversation(
            (request.payload as { id: string }).id,
            (request.payload as { options?: SlackExportOptions }).options,
          )
          : Promise.reject(new Error('Unsupported Slack request.'));
      void work.then(
        result => window.postMessage({ bridge: BRIDGE, response: request.id, result }, location.origin),
        error => window.postMessage({
          bridge: BRIDGE,
          response: request.id,
          error: error instanceof Error ? error.message : 'Slack request failed.',
        }, location.origin),
      );
    });
  },
});
