import { describe, expect, it } from 'vite-plus/test';
import {
  AttachmentId,
  COVER_NAMESPACE,
  coverOf,
  emojiTest,
  newId,
  newPayload,
  type AttachmentRef,
  type PagePayload,
} from '../src/index.ts';

const image = newId(AttachmentId);
const ref = { id: image } as AttachmentRef;
const withCover = (
  cover: PagePayload['extensions'][string],
  attachments: AttachmentRef[] = [ref],
) =>
  newPayload({ title: 'T', markdown: '', attachments, extensions: { [COVER_NAMESPACE]: cover } });

describe('page emoji', () => {
  it('refuses everything, rather than throwing, where the browser lacks the v flag', () => {
    let built = 0;
    const lacking = emojiTest(() => {
      built += 1;
      throw new SyntaxError("Invalid flags supplied to RegExp constructor 'v'");
    });
    expect(built).toBe(0);
    expect(lacking('🍞')).toBe(false);
    expect(lacking('a')).toBe(false);
    expect(built).toBe(1);
  });
});

describe('cover', () => {
  it('falls back part by part, never failing on what a newer client wrote', () => {
    const theme = { kind: 'theme' };
    const cases: [PagePayload['extensions'][string], { emoji: string | null; banner: unknown }][] =
      [
        [
          { format: 1, emoji: '🍞', banner: { kind: 'video', src: 'x' } },
          { emoji: '🍞', banner: theme },
        ],
        [
          { format: 2, emoji: '🍞' },
          { emoji: null, banner: theme },
        ],
      ];
    for (const [cover, shown] of cases)
      expect(coverOf(withCover(cover)), JSON.stringify(cover)).toEqual(shown);
  });
});
