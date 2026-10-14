import {
  LINKS_NAMESPACE,
  linksInUse,
  newPayload,
  OWNER_REGION,
  PageId,
  placedWikilinks,
  RevisionId,
  SpaceId,
  ShareId,
  type Region,
  type AttachmentRef,
  type pageOperations,
  type PagePayload,
} from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { describe, expect, it } from 'vite-plus/test';
import { DraftSession, type DraftPorts } from '../src/page/draft-session.ts';
import type { EditorSurfaceHandle } from '../src/page/editor/surface.ts';

type SaveInput = Parameters<DraftPorts['saveDraft']>[0];

/** A surface holding text the way an editor does; `typed` is an edit it hasn't reported yet. */
class FakeSurface implements EditorSurfaceHandle {
  text: string;
  replaced: string[] = [];
  constructor(text: string) {
    this.text = text;
  }
  read() {
    return this.text;
  }
  replace(markdown: string) {
    this.replaced.push(markdown);
    this.text = markdown;
  }
  focus() {}
}

function opened(markdown = 'Start.', table?: Record<string, string>) {
  return newPayload({
    title: 'Notes',
    markdown,
    extensions: {
      other: { kept: true },
      ...(table
        ? {
            [LINKS_NAMESPACE]: {
              format: 1,
              links: Object.entries(table).map(([key, pageId]) => ({ key, pageId })),
            },
          }
        : {}),
    },
  });
}

/**
 * A session over a fake surface and fake ports. Each save is answered by
 * `answer` (by default stored as sent), once `hold` lets it go.
 */
function session(
  payload: PagePayload = opened(),
  answer: (input: SaveInput) => PagePayload | Promise<PagePayload> = (input) => input.payload,
  region: Region = OWNER_REGION,
  readLinks: DraftPorts['readLinks'] = async (markdown) => placedWikilinks(markdown),
) {
  const surface = new FakeSurface(payload.markdown);
  const saves: SaveInput[] = [];
  let epoch = 0;
  let afterSave = () => {};
  // The pages a link in the draft may name: any but one in another share.
  const linkTargets: ReadonlySet<PageId> = new Set(
    ['p-home', 'p-work', 'p-plan'].map((id) => PageId.parse(id)),
  );
  const ports: DraftPorts = {
    async saveDraft(input) {
      saves.push(input);
      const written = await answer(input);
      return {
        revisionId: RevisionId.parse(`r${saves.length}`),
        repaired: false,
        region: OWNER_REGION,
        payload: written,
        inUse: await linksInUse(written),
        renamed: [],
        linksKept: false,
      } satisfies pageOperations.Written;
    },
    async uploadAttachment(file): Promise<AttachmentRef> {
      return {
        id: `a-${file.name}`,
        name: file.name,
        mediaType: file.mediaType,
        size: file.bytes.length,
      } as AttachmentRef;
    },
    draftHead: async () => RevisionId.parse('r-theirs-latest'),
    generation: () => 0,
    epoch: () => epoch,
    tree: () => undefined,
    linkTargets: () => linkTargets,
    saved: async () => afterSave(),
    overtaken: () => undefined,
    readLinks,
  };
  const draft = new DraftSession(
    { base: RevisionId.parse('r0'), payload, region },
    ports,
    { current: surface },
    { debounceMs: 60_000, maxWaitMs: 60_000 },
  );
  return {
    draft,
    surface,
    saves,
    lock: () => (epoch += 1),
    /** Run `then` as each save finishes, after the session has read the surface. */
    afterSave: (then: () => void) => (afterSave = then),
  };
}

/** What the surface reports as the person types. */
const type = (s: ReturnType<typeof session>, text: string) => {
  s.surface.text = text;
  s.draft.edit(text);
};

describe('a draft session', () => {
  it('saves what the surface reports, each save based on the last, in its region', async () => {
    const s = session();
    type(s, 'One.');
    await s.draft.flush();
    type(s, 'Two.');
    await s.draft.flush();
    expect(s.saves.map((save) => [save.basedOn, save.payload.markdown])).toEqual([
      ['r0', 'One.'],
      ['r1', 'Two.'],
    ]);
    expect(s.saves[1]?.basedOnRegion).toEqual(OWNER_REGION);
    expect(s.draft.snapshot().status).toBe('saved');
  });

  it('reads the surface before saving for good, for an edit it hasn’t reported yet', async () => {
    const s = session();
    s.surface.text = 'Typed, not yet reported.';
    await s.draft.saveOrThrow();
    expect(s.saves.map((save) => save.payload.markdown)).toEqual(['Typed, not yet reported.']);
  });

  it('shows an edit the surface hasn’t reported yet as unsaved, until it saves', async () => {
    const s = session();
    s.surface.text = 'Typed.';
    s.draft.editing();
    expect(s.draft.snapshot().status).toBe('pending');
    await s.draft.flush();
    expect(s.draft.snapshot().status).toBe('saved');
    // Reported after it was saved, it's no change.
    s.draft.edit('Typed.');
    expect(s.draft.snapshot().status).toBe('saved');
    expect(s.saves.map((save) => save.payload.markdown)).toEqual(['Typed.']);
  });

  it('shows an edit typed as a save finishes as unsaved, with nothing else to save', async () => {
    const s = session();
    type(s, 'Saved.');
    s.afterSave(() => {
      s.surface.text = 'Saved, and typed.';
      s.draft.editing();
    });
    await s.draft.flushSaves();
    expect(s.draft.snapshot().status).toBe('pending');
    expect(s.draft.hasUnsaved()).toBe(true);
    s.afterSave(() => {});
    type(s, 'Saved, and typed.');
    await s.draft.flush();
    expect(s.draft.snapshot().status).toBe('saved');
    expect(s.saves.map((save) => save.payload.markdown)).toEqual(['Saved.', 'Saved, and typed.']);
  });

  it('carries extensions over, and saves a change made from outside the surface', async () => {
    const s = session(opened('[[Plan]]', { plan: 'p-plan' }));
    s.surface.text = '[[Plan]], typed.';
    s.draft.revise((current) => {
      // The draft as it is now, an edit not yet reported included.
      expect(current.markdown).toBe('[[Plan]], typed.');
      return { extensions: { 'wikistow.cover': { format: 1, emoji: '🌱' } } };
    });
    await s.draft.flush();
    expect(s.saves[0]?.payload.markdown).toBe('[[Plan]], typed.');
    expect(s.saves[0]?.payload.extensions).toEqual({
      other: { kept: true },
      [LINKS_NAMESPACE]: { format: 1, links: [{ key: 'plan', pageId: 'p-plan' }] },
      'wikistow.cover': { format: 1, emoji: '🌱' },
    });
  });

  it('works out the first save’s table for the region the draft was opened in', async () => {
    const share: Region = {
      kind: 'share',
      spaceId: SpaceId.parse('s-1'),
      shareId: ShareId.parse('sh-1'),
    };
    const s = session(opened('[[Plan]]', { plan: 'p-plan', old: 'p-old' }), undefined, share);
    type(s, '[[Plan]] again');
    await s.draft.flush();
    expect(s.saves[0]?.tableRegion).toEqual(share);
    // An old key no link uses any more isn't carried.
    expect(s.saves[0]?.payload.extensions[LINKS_NAMESPACE]).toEqual({
      format: 1,
      links: [{ key: 'plan', pageId: 'p-plan' }],
    });
    // The save's own region from then on.
    type(s, '[[Plan]] once more');
    await s.draft.flush();
    expect(s.saves[1]?.tableRegion).toEqual(OWNER_REGION);
  });

  it('keeps the table as opened when its links can’t be read in time', async () => {
    const table = { plan: 'p-plan', old: 'p-old' };
    const s = session(opened('[[Plan]]', table), undefined, OWNER_REGION, async () => {
      throw new Error('Reading the Markdown took too long');
    });
    type(s, '[[Plan]] again');
    await s.draft.flush();
    expect(s.saves[0]?.payload.extensions[LINKS_NAMESPACE]).toEqual(
      opened('[[Plan]]', table).extensions[LINKS_NAMESPACE],
    );
  });

  describe('a save that renames a link', () => {
    const rename = (input: SaveInput) => ({
      ...input.payload,
      markdown: input.payload.markdown.replace('[[Plan]]', '[[Roadmap]]'),
    });

    it('leaves the text alone when the person typed on during the save, and renames it next time', async () => {
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      const s = session(opened('See [[Plan]].'), async (input) => {
        await held;
        return rename(input);
      });
      // Opened, its table cut to its links, so the first save starts at once.
      s.draft.open();
      await new Promise((resolve) => setTimeout(resolve));
      type(s, 'See [[Plan]] now.');
      const saving = s.draft.flushSaves();
      type(s, 'See [[Plan]] now, and more.');
      release();
      await saving;
      // The rewrite of the first save was never shown; the second save
      // builds on the text typed, and its rewrite is.
      expect(s.saves.map((save) => save.payload.markdown)).toEqual([
        'See [[Plan]] now.',
        'See [[Plan]] now, and more.',
      ]);
      expect(s.surface.replaced).toEqual(['See [[Roadmap]] now, and more.']);
    });
  });

  describe('someone else saving', () => {
    it('is not its own saves, and is a conflict for anyone else’s', async () => {
      const s = session();
      type(s, 'Mine.');
      await s.draft.flush();
      s.draft.noticeHead(RevisionId.parse('r1'));
      expect(s.draft.snapshot().status).toBe('saved');
      s.draft.noticeHead(RevisionId.parse('r-theirs'));
      expect(s.draft.snapshot().status).toBe('conflict');
      type(s, 'Mine, typed after.');
      await s.draft.flush();
      expect(s.saves).toHaveLength(1);
      // The edit is held back by the conflict, so that is what leaving names.
      await expect(s.draft.saveOrThrow()).rejects.toThrow(
        'Someone else changed this draft. Choose which to keep first.',
      );
    });

    it('stops at a stale head found by a save, keeping the edit', async () => {
      const s = session(opened(), () => {
        throw new ApiError(409, 'stale-head', 'Someone else saved');
      });
      type(s, 'Mine.');
      await s.draft.flush();
      expect(s.draft.snapshot().status).toBe('conflict');
      expect(s.draft.hasUnsaved()).toBe(true);
      await expect(s.draft.saveOrThrow()).rejects.toThrow('Choose which to keep first.');
    });
  });

  describe('a page picked for an ambiguous link', () => {
    it('is shown, and sent with every save', async () => {
      const s = session(opened('[[Notes]]'));
      expect(s.draft.chooseLink('notes', PageId.parse('p-home'))).toBe(true);
      expect(s.draft.snapshot().links.get('notes')).toBe('p-home');
      await s.draft.flush();
      type(s, '[[Notes]] again');
      await s.draft.flush();
      expect(s.saves.map((save) => save.linkChoices)).toEqual([
        new Map([['notes', 'p-home']]),
        new Map([['notes', 'p-home']]),
      ]);
    });
  });

  describe('attachments', () => {
    const png = new File([new Uint8Array([1, 2, 3])], 'a [photo].png', { type: 'image/png' });
    const pdf = new File([new Uint8Array([4])], 'plan.pdf', { type: 'application/pdf' });

    it('puts files pasted where the surface says, as images or links', async () => {
      const s = session();
      const placed: string[][] = [];
      s.draft.attach([png, pdf], (links) => {
        placed.push(links);
        return true;
      });
      expect(s.draft.snapshot().uploading).toBe(true);
      await s.draft.flush();
      expect(placed).toEqual([
        ['![a \\[photo\\].png](attachment:a-a [photo].png)', '[plan.pdf](attachment:a-plan.pdf)'],
      ]);
      expect(s.draft.snapshot().attachments.map((a) => a.id)).toEqual([
        'a-a [photo].png',
        'a-plan.pdf',
      ]);
      expect(s.saves.at(-1)?.payload.attachments).toHaveLength(2);
      expect(s.draft.snapshot().uploading).toBe(false);
    });

    it('adds files after the text when the editor they were dropped in has gone', async () => {
      const s = session(opened('Text.'));
      // The person switched editors while it uploaded.
      s.draft.attach([pdf], () => false);
      await s.draft.flush();
      expect(s.surface.text).toBe('Text.\n\n[plan.pdf](attachment:a-plan.pdf)');
      expect(s.saves.at(-1)?.payload.markdown).toBe(s.surface.text);
    });

    it('adds nothing once the draft has left the screen or the vault locked', async () => {
      for (const leave of ['close', 'lock'] as const) {
        const s = session();
        const placed: string[][] = [];
        s.draft.attach([pdf], (links) => {
          placed.push(links);
          return true;
        });
        if (leave === 'close') s.draft.close();
        else s.lock();
        await s.draft.flush();
        expect(placed).toEqual([]);
        expect(s.saves).toEqual([]);
      }
    });
  });
});
