import {
  exportOperations,
  pageOperations as pages,
  linkSpans,
  type LinkSpans,
} from '@wikistow/client';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { personWithVault } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { ABOVE, library } from './support/sharing.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

describe('a page whose links can’t be read', () => {
  it('is exported as written, and the others as usual', async () => {
    const alice = await personWithVault(t);
    const lib = await library(alice);
    await pages.editDraft(alice.ctx, lib.page, { markdown: 'See [[private]].' });
    const path = `${ABOVE}/Shared/Plan.md`;
    const plan = async (read?: (markdown: string) => Promise<LinkSpans>) => {
      const files = new Map<string, string>();
      const { unread } = await exportOperations.exportMarkdown(alice.ctx, {
        scope: { spaceId: lib.spaceId },
        ...(read ? { read } : {}),
        write: (entry) => {
          if (entry.kind === 'file') files.set(entry.path, new TextDecoder().decode(entry.bytes));
        },
      });
      return { markdown: files.get(path), unread: unread.map((page) => page.path) };
    };
    // Read, the link names the page's file.
    expect(await plan()).toEqual({ markdown: 'See [[Private]].', unread: [] });
    // Too slow, say: none of its links is rewritten, and the summary says so.
    expect(await plan(() => Promise.reject(new Error('Too slow')))).toEqual({
      markdown: 'See [[private]].',
      unread: [path],
    });
    // Read, but its rewrite too slow to check: as written, not half rewritten.
    const once = async (markdown: string) => {
      if (markdown !== 'See [[private]].') throw new Error('Too slow');
      return linkSpans(markdown);
    };
    expect(await plan(once)).toEqual({ markdown: 'See [[private]].', unread: [path] });
  }, 60_000);
});
