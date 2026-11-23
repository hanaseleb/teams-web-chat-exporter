import { describe, expect, it } from 'vitest';
import { buildOneChatForBundle } from '../src/background/download';

describe('Slack export builder', () => {
  it('uses the standard message builder and puts fetched files under attachments/', async () => {
    const result = await buildOneChatForBundle({
      messages: [{
        id: 'C_GENERAL:1700000000.0',
        author: 'Alice Example',
        timestamp: '2023-11-14T22:13:20.000Z',
        text: 'Here is the plan.',
        attachments: [{
          fileAttachment: true,
          label: 'plan.txt',
          type: 'text/plain',
          href: 'https://files.slack.com/files-pri/T_ALPHA-F_PLAN/plan.txt',
          dataUrl: 'data:text/plain;base64,YWJj',
        }],
      }],
      meta: { title: 'Slack Alpha general' },
      formats: ['json'],
      embedAvatars: false,
      downloadImages: false,
      avatarMode: 'inline',
    });

    const file = result.files.find(entry => entry.relativePath === 'attachments/plan.txt');
    expect(file && new TextDecoder().decode(file.data)).toBe('abc');
    const json = result.files.find(entry => entry.relativePath === 'messages.json');
    const output = JSON.parse(new TextDecoder().decode(json!.data));
    expect(output.messages[0]).toMatchObject({ author: 'Alice Example', text: 'Here is the plan.' });
    expect(output.messages[0].attachments[0]).toMatchObject({ label: 'plan.txt', href: 'attachments/plan.txt' });
    expect(JSON.stringify(output)).not.toContain('data:text/plain;base64');
    expect(output.messages[0].attachments[0]).not.toHaveProperty('fileAttachment');
  });
});
