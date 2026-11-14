import {
  FolderId,
  newId,
  PageId,
  RevisionId,
  SpaceId,
  splitFrontmatter,
  type AttachmentRef,
  type DraftSave,
  type PageWriter,
} from '@wikistow/client';
import type { DesktopClip } from '@wikistow/contracts';
import { describe, expect, it } from 'vite-plus/test';
import { htmlMarkdown } from '../src/page/editor/visual/html-markdown.ts';
import { saveClip } from '../src/clip/save-clip.ts';

// A clip from the browser saved as a draft (ADR 0017, steps 4 and 6), with the
// paste path itself turning its HTML into Markdown, in Chromium.

const spaceId = newId(SpaceId);
const folderId = newId(FolderId);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function save(fields: Partial<DesktopClip>) {
  const writes: { markdown: string; saved?: DraftSave }[] = [];
  const writer = {
    async newPageDraft({ markdown }: { markdown: string }) {
      writes.push({ markdown });
      return { pageId: newId(PageId), revisionId: newId(RevisionId) };
    },
    async attach(_page: unknown, file: { name: string; mediaType: string }) {
      return { id: 'A1', name: file.name, mediaType: file.mediaType } as AttachmentRef;
    },
    draft: () => ({
      waitingHead: async () => null,
      save: async (input: DraftSave) => void (writes[0]!.saved = input),
    }),
  } as unknown as PageWriter;
  const { outcome } = await saveClip(
    {
      id: 'c',
      mode: 'article',
      url: 'https://news.example/story',
      title: 'A story',
      note: '',
      tags: [],
      html: '',
      text: '',
      byline: null,
      folder: { spaceId, folderId },
      screenshot: null,
      waited: false,
      made: null,
      ...fields,
    },
    {
      writer,
      places: async () => ({
        places: [{ spaceId, folderId, path: ['Home', 'News'] }],
        unread: new Set(),
      }),
      convert: htmlMarkdown,
      image: async () => ({ ok: true, bytes: PNG, mediaType: 'image/png' }),
      today: '2026-11-13',
      choose: async () => null,
    },
  );
  return { outcome, first: writes[0]?.markdown ?? '', saved: writes[0]?.saved };
}

const HEAD = '---\nsource: https://news.example/story\nclipped: 2026-11-13\n---\n';

describe('a clip saved as a page', () => {
  it('escapes a link’s note and selection, as text pasted', async () => {
    const { first } = await save({
      mode: 'link',
      note: '# not a heading\n- nor a list',
      text: '*quoted*',
    });
    expect(first).toBe(
      // A line break in the note is a hard break.
      `${HEAD}\\# not a heading\\\n\\- nor a list\n\n> \\*quoted\\*\n\n[A story](https://news.example/story)\n`,
    );
  });

  it('keeps frontmatter-like text the site wrote as the page’s body', async () => {
    const { first } = await save({
      html: '<p>---</p><p>title: Evil<br>tags: [spam]</p><p>---</p><p>Text</p>',
    });
    const { frontmatter, body } = splitFrontmatter(first);
    expect(frontmatter).toBe(HEAD);
    expect(body).toContain('title: Evil');
    expect(body).toContain('Text');
  });

  it('attaches an article’s images, and saves it pointing at them', async () => {
    const { outcome, first, saved } = await save({
      html: '<h1>Story</h1><p>Words <img src="https://cdn.example/a.png" alt="A cat"></p>',
      byline: 'Ann',
    });
    expect(outcome).toMatchObject({ ok: true, images: { saved: 1, skipped: 0 }, faithful: true });
    expect(first).toContain('author: Ann');
    expect(first).toContain('[A cat](https://cdn.example/a.png)');
    expect(saved?.payload.markdown).toContain('![A cat](attachment:A1)');
    expect(saved?.payload.attachments).toEqual([expect.objectContaining({ id: 'A1' })]);
  });

  it('drops what the site hides, as a paste does', async () => {
    const { first } = await save({
      html: '<p>Shown</p><p style="display:none">Hidden</p><script>alert(1)</script>',
    });
    expect(first).toBe(`${HEAD}Shown\n`);
  });

  it('shows a screenshot from its attachment, above the link, with the note first', async () => {
    const { outcome, first, saved } = await save({
      mode: 'screenshot',
      title: 'A [story] *now*',
      note: '# Look',
      screenshot: { bytes: PNG, mediaType: 'image/png' },
    });
    expect(outcome).toMatchObject({ ok: true, images: { saved: 1, skipped: 0 } });
    const link = '[A \\[story\\] \\*now\\*](https://news.example/story)\n';
    expect(first).toBe(`${HEAD}\\# Look\n\n${link}`);
    expect(saved?.payload.markdown).toBe(
      `${HEAD}\\# Look\n\n![Screenshot](attachment:A1)\n\n${link}`,
    );
    expect(saved?.payload.attachments).toEqual([
      expect.objectContaining({ id: 'A1', name: 'Screenshot.png', mediaType: 'image/png' }),
    ]);
  });
});
