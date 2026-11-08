import type { AiMessage } from '@wikistow/client';
import { describe, expect, it } from 'vite-plus/test';
import { COPY_LEFT_OUT, keptMessages } from '../src/workshop/kept.ts';

// What the workshop keeps of its conversation with the draft (#314): a
// copy of a real page never goes to the server, wherever the tools put it.
// The browser test covers one report; these cover each place a copy shows.

const SECRET = 'Grandma adds cardamom';
const copy = { pageId: 'sample-1', title: 'Family recipes', markdown: SECRET };
const own = { pageId: 'sample-2', title: 'Prices', markdown: 'Two at 3.' };
const report = { running: null, samples: [copy, own] };

const conversation: AiMessage[] = [
  { role: 'user', text: '(I copied my page “Family recipes” …)\n\nAdd a block' },
  {
    role: 'assistant',
    text: '',
    toolCalls: [
      { id: 'a', name: 'read_preview', input: {} },
      { id: 'b', name: 'build_plugin', input: {} },
      { id: 'c', name: 'write_sample_page', input: { ...copy, markdown: `${SECRET}!` } },
      { id: 'd', name: 'sdk_reference', input: {} },
      { id: 'e', name: 'list_files', input: {} },
    ],
  },
  {
    role: 'tool',
    results: [
      { callId: 'a', output: JSON.stringify(report), isError: false },
      {
        callId: 'b',
        output: JSON.stringify({ version: 2, built: true, preview: report }),
        isError: false,
      },
      { callId: 'c', output: '{"pageId":"sample-1"}', isError: false },
      { callId: 'd', output: '# The SDK guide', isError: false },
      { callId: 'e', output: '[{"path":"wikistow-plugin.json","size":2}]', isError: false },
    ],
  },
];

describe('the kept conversation', () => {
  const kept = keptMessages(
    conversation,
    ['(I copied one of my pages …)\n\nAdd a block'],
    new Set(['sample-1']),
  );
  const text = JSON.stringify(kept);

  it('holds neither a copy’s text nor its title', () => {
    expect(text).not.toContain('cardamom');
    expect(text).not.toContain('Family recipes');
    expect(text).toContain(COPY_LEFT_OUT);
  });

  it('keeps the rest as it was', () => {
    expect(kept[0]).toEqual({ role: 'user', text: '(I copied one of my pages …)\n\nAdd a block' });
    const results = kept[2]?.role === 'tool' ? kept[2].results : [];
    expect(JSON.parse(results[0]?.output ?? '')).toEqual({
      running: null,
      samples: [{ pageId: 'sample-1', left: COPY_LEFT_OUT }, own],
    });
    expect(JSON.parse(results[1]?.output ?? '')).toMatchObject({ version: 2, built: true });
    expect(results[4]?.output).toBe('[{"path":"wikistow-plugin.json","size":2}]');
  });

  it('leaves out the SDK reference, which the model can ask for again', () => {
    expect(text).not.toContain('# The SDK guide');
    expect(text).toContain('call sdk_reference again');
  });

  it('is the conversation itself when nothing was copied', () => {
    const plain = conversation.slice(1);
    const again = keptMessages(plain, [], new Set());
    expect(JSON.stringify(again)).toContain(SECRET);
  });
});
