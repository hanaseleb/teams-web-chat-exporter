<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { Send } from 'lucide-svelte';
  import { t } from '../../../i18n/i18n';

  export let projectName = '';
  export let recentProjectNames: string[] = [];
  export let disabled = false;
  export let busy = false;
  export let lang = 'en';

  const dispatch = createEventDispatcher<{ send: void }>();
  $: canSend = !disabled && !busy && Boolean(projectName.trim());
</script>

<section class="ebi-send">
  <label for="ebi-project-name">{t('ebi.project', {}, lang)}</label>
  <input id="ebi-project-name" bind:value={projectName} list="ebi-project-names" autocomplete="off" />
  <datalist id="ebi-project-names">
    {#each recentProjectNames as name (name)}<option value={name}></option>{/each}
  </datalist>
  <button type="button" disabled={!canSend} on:click={() => dispatch('send')}>
    <Send size={16} />
    {t('ebi.send', {}, lang)}
  </button>
  <p>{t('ebi.sendHint', {}, lang)}</p>
</section>

<style>
  .ebi-send {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 7px 8px;
    align-items: center;
    margin: 10px 0 2px;
    padding: 10px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }
  label { color: var(--color-muted); font-size: 11px; font-weight: 700; }
  input {
    grid-column: 1 / -1;
    width: 100%;
    box-sizing: border-box;
    padding: 8px 9px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-bg);
    color: var(--color-text);
    font: inherit;
  }
  button {
    display: flex;
    grid-column: 1 / -1;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 38px;
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--color-accent);
    color: white;
    font: inherit;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
  }
  button:disabled { opacity: 0.55; cursor: not-allowed; }
  p { grid-column: 1 / -1; margin: 0; color: var(--color-muted); font-size: 10px; line-height: 1.4; }
</style>
