import { defineContentScript } from 'wxt/sandbox';
import type { SlackExportOptions } from '../content/slack-api';
import { SLACK_MATCH_PATTERNS } from '../utils/slack-urls';

declare const browser: typeof chrome | undefined;

const BRIDGE = '__teams_web_chat_exporter_slack__';

type SlackRequest =
  | { type: 'SLACK_LIST_CONVERSATIONS' }
  | { type: 'SLACK_LIST_THREADS'; conversationId: string }
  | { type: 'SLACK_EXPORT_CONVERSATION'; id: string; options: SlackExportOptions }
  | { type: 'SLACK_CANCEL' };

function requestPage(action: 'list' | 'threads' | 'export', payload?: unknown): Promise<unknown> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Slack Web did not respond. Refresh the Slack tab and retry.')), 300_000);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const message = event.data as { bridge?: unknown; response?: unknown; result?: unknown; error?: unknown };
      if (message?.bridge !== BRIDGE || message.response !== id) return;
      if (typeof message.error === 'string') finish(new Error(message.error));
      else finish(undefined, message.result);
    };
    function finish(error?: Error, result?: unknown) {
      clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      if (error) reject(error);
      else resolve(result);
    }
    window.addEventListener('message', onMessage);
    window.postMessage({ bridge: BRIDGE, id, action, payload }, location.origin);
  });
}

export default defineContentScript({
  matches: SLACK_MATCH_PATTERNS,
  runAt: 'document_idle',
  main() {
    const runtime = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;
    runtime.onMessage.addListener((message: SlackRequest, _sender, sendResponse) => {
      if (message?.type === 'SLACK_CANCEL') {
        window.postMessage({ bridge: BRIDGE, id: crypto.randomUUID(), action: 'cancel' }, location.origin);
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === 'SLACK_LIST_CONVERSATIONS') {
        void requestPage('list').then(
          result => sendResponse({ ok: true, ...result as object }),
          error => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Slack request failed.' }),
        );
        return true;
      }
      if (message?.type === 'SLACK_LIST_THREADS') {
        void requestPage('threads', { conversationId: message.conversationId }).then(
          threads => sendResponse({ ok: true, threads }),
          error => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Slack request failed.' }),
        );
        return true;
      }
      if (message?.type === 'SLACK_EXPORT_CONVERSATION') {
        void requestPage('export', { id: message.id, options: message.options }).then(
          result => sendResponse({ ok: true, result }),
          error => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Slack request failed.' }),
        );
        return true;
      }
    });
  },
});
