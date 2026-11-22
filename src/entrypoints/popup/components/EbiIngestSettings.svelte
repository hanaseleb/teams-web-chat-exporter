<script lang="ts" module>
  declare const browser: typeof chrome | undefined;
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { Send } from 'lucide-svelte';
  import { t } from '../../../i18n/i18n';
  import {
    ingestPermissionPattern,
    loadIngestSettings,
    normalizeIngestBaseUrl,
    saveIngestSettings,
  } from '../../../utils/ebi-ingest';

  export let lang = 'en';

  const localStorage = typeof browser !== 'undefined' ? browser.storage.local : chrome.storage.local;
  const permissions = typeof browser !== 'undefined' ? browser.permissions : chrome.permissions;
  let baseUrl = '';
  let token = '';
  let saving = false;
  let saved = false;
  let error = '';

  onMount(async () => {
    const settings = await loadIngestSettings(localStorage);
    if (settings) {
      baseUrl = settings.baseUrl;
      token = settings.token;
    }
  });

  async function saveConnection() {
    if (saving) return;
    saved = false;
    error = '';
    let normalized: string;
    try { normalized = normalizeIngestBaseUrl(baseUrl); }
    catch { error = t('ebi.settings.invalidUrl', {}, lang); return; }
    if (!token.trim()) {
      error = t('ebi.error.settings', {}, lang);
      return;
    }

    saving = true;
    try {
      const granted = await permissions.request({ origins: [ingestPermissionPattern(normalized)] });
      if (!granted) {
        error = t('ebi.settings.permissionDenied', {}, lang);
        return;
      }
      await saveIngestSettings(localStorage, { baseUrl: normalized, token });
      baseUrl = normalized;
      saved = true;
    } catch {
      error = t('ebi.settings.saveFailed', {}, lang);
    } finally {
      saving = false;
    }
  }
</script>

<section class="ebi-settings ac">
  <div class="ah"><Send size={14} /> {t('ebi.settings.title', {}, lang)}</div>
  <div class="group">
    <label class="field-row">
      <span>{t('ebi.settings.baseUrl', {}, lang)}</span>
      <input bind:value={baseUrl} type="url" placeholder="https://" autocomplete="url" />
    </label>
    <label class="field-row">
      <span>{t('ebi.settings.token', {}, lang)}</span>
      <input bind:value={token} type="password" autocomplete="new-password" />
    </label>
    <p class="hint">{t('ebi.settings.hint', {}, lang)}</p>
    {#if error}<p class="message error" role="alert">{error}</p>{/if}
    {#if saved}<p class="message saved" role="status">{t('ebi.settings.saved', {}, lang)}</p>{/if}
    <button class="save" type="button" disabled={saving} on:click={saveConnection}>
      {saving ? t('ebi.settings.saving', {}, lang) : t('ebi.settings.save', {}, lang)}
    </button>
  </div>
</section>

<style>
  .ebi-settings {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
    margin-bottom: var(--gap);
  }
  .ah {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 12px;
    color: var(--color-accent);
    background: var(--color-accent-light);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }
  .group { display: grid; gap: 10px; padding: 12px; }
  .field-row { display: grid; gap: 5px; color: var(--color-text); font-size: 12px; font-weight: 600; }
  input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 9px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
  }
  .hint, .message { margin: 0; color: var(--color-muted); font-size: 11px; line-height: 1.45; }
  .message.error { color: var(--color-danger); }
  .message.saved { color: var(--color-success); }
  .save {
    justify-self: end;
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--color-accent);
    color: white;
    padding: 8px 12px;
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
  }
  .save:disabled { opacity: 0.6; cursor: wait; }
</style>
