import { pageRoutes } from '@wikistow/contracts';
import { describe, expect, it } from 'vite-plus/test';
import {
  checkPayloadSize,
  newPayload,
  PageTooLarge,
  parsePayload,
  revisePayload,
} from '../src/index.ts';
import { buildWorld } from './fixture/world.ts';

describe('payload format and extensions', () => {
  it('carries an unknown extension namespace and unknown fields unchanged through a save', () => {
    const { owner, agent, page } = buildWorld();
    const future = { reactions: [{ emoji: '👍', by: 'someone' }], nested: { deep: [1, 2, 3] } };

    // A newer client writes data this client has never heard of.
    const written = owner.saveDraft(page, {
      ...newPayload({ title: 'Plan', markdown: 'v1', extensions: { 'future.reactions': future } }),
      format: { major: 1, minor: 4, channel: 'beta' },
      futureField: 'kept',
    });

    // This client edits only the body and saves.
    const { opened } = agent.read(page, written);
    const edited = agent.saveDraft(page, revisePayload(opened, { markdown: 'v2' }));

    const reread = owner.read(page, edited).opened;
    if (reread.kind !== 'current') throw new Error('expected current format');
    expect(reread.payload.markdown).toBe('v2');
    expect(reread.payload.extensions['future.reactions']).toEqual(future);
    expect(reread.payload['futureField']).toBe('kept');
    expect(reread.payload.format).toEqual({ major: 1, minor: 4, channel: 'beta' });
  });

  it('refuses to save over a payload with a newer major format version', () => {
    const opened = parsePayload({ format: { major: 2, minor: 0 }, blocks: [] });
    expect(opened).toEqual({ kind: 'newer-format', format: { major: 2, minor: 0 } });
    expect(() => revisePayload(opened, { markdown: 'overwrite' })).toThrow(
      expect.objectContaining({ code: 'unsupported-format' }),
    );
  });
});

describe('the size of a version', () => {
  const { MAX_MARKDOWN_BYTES } = pageRoutes;
  const markdown = (text: string) => newPayload({ title: 'Notes', markdown: text });

  it('counts the Markdown in UTF-8 bytes, up to and including the limit', () => {
    expect(() => checkPayloadSize(markdown('a'.repeat(MAX_MARKDOWN_BYTES)))).not.toThrow();
    // Three bytes each, so fewer characters than the limit's bytes, and over it.
    const wide = '€'.repeat(Math.ceil((MAX_MARKDOWN_BYTES + 1) / 3));
    expect(() => checkPayloadSize(markdown(wide))).toThrow(PageTooLarge);
  });
});
