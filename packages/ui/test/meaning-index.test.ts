import {
  estimateTokens,
  meaningBytes,
  PageId,
  readMeaningBytes,
  RevisionId,
  searchOperations,
  SpaceId,
  type KeptMeaning,
} from '@wikistow/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  DRAFT_PAUSE_MS,
  MeaningIndexer,
  meaningProgress,
  type MeaningFile,
  type MeaningWork,
} from '../src/meaning/meaning-index';
import { KEEP_AT_MOST_MS, KEEP_MS } from '../src/data/index-tracker';
import { ModelUnavailable } from '../src/meaning/embedder';

const home = SpaceId.parse('home');
const rev = (id: string) => RevisionId.parse(id);

/** How long the fake model takes over each passage. */
const EMBED_MS = 200;

type Page = {
  pageId: string;
  revisionId: string;
  title: string;
  text: string;
  updated?: string;
  /** A draft readers don't see, which this person can edit. */
  draft?: boolean;
};

/** A word index holding `pages`, each as the index reduces it. */
function wordIndex(pages: readonly Page[]): searchOperations.PageIndex {
  const index = new searchOperations.PageIndex();
  for (const page of pages) {
    index.addText(
      {
        spaceId: home,
        pageId: PageId.parse(page.pageId),
        revisionId: rev(page.revisionId),
        parentId: null,
        folderIds: [],
        path: ['Home'],
        draft: page.draft ?? false,
        unpublished: false,
      },
      {
        title: page.title,
        text: page.text,
        headings: [...page.text.matchAll(/^# /gm)].map(({ index }) => index),
        updated: page.updated ?? '2026-11-13T10:00:00.000Z',
      },
    );
  }
  return index;
}

const WORDS = ['beach', 'boiler', 'soup'] as const;

/** A vector that says which of `WORDS` the text holds, with a constant so none is zeros. */
function fakeVector(text: string): Float32Array {
  const lower = text.toLowerCase();
  return Float32Array.from([...WORDS.map((word) => (lower.includes(word) ? 1 : 0)), 0.1]);
}

/** A section of about `words` words, each a token, under a heading. */
const section = (heading: string, word: string, words: number) =>
  `# ${heading}\n${Array.from({ length: words }, (_, i) => (i % 10 === 0 ? word : 'and')).join(' ')}`;

function fakeWork() {
  const embedded: string[] = [];
  const counted: string[][] = [];
  const writes: KeptMeaning[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  let kept: Uint8Array | null = null;
  const file: MeaningFile = {
    read: async () => {
      if (state.unreadable) throw new Error('IndexedDB refused');
      return kept;
    },
    write: async (sealed) => {
      kept = sealed;
      writes.push(readMeaningBytes(sealed)!);
    },
  };
  const state = {
    busy: false,
    /** Reading the kept file fails. */
    unreadable: false,
    failNext: false,
    /** The model won't load, this many times more. */
    unavailable: 0,
    /** Fail every passage holding this. */
    failOn: null as string | null,
    file: file as MeaningFile | null,
  };
  const embedder = {
    count: vi.fn(async (words: string[]) => {
      if (state.unavailable > 0) {
        state.unavailable--;
        throw new ModelUnavailable(new Error('No model'));
      }
      counted.push(words);
      return words.map(estimateTokens);
    }),
    embed: vi.fn(async (_kind: 'passage', texts: string[]) => {
      inFlight++;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, EMBED_MS));
      inFlight--;
      if (state.failNext) {
        state.failNext = false;
        throw new Error('The embedding worker stopped.');
      }
      if (state.failOn && texts.some((text) => text.includes(state.failOn!))) {
        throw new Error('The model failed.');
      }
      embedded.push(...texts);
      return { vectors: texts.map(fakeVector), tokens: texts.map(() => 1) };
    }),
    stop: vi.fn(),
  };
  const work: MeaningWork = {
    embedder,
    file: async () => state.file,
    seal: meaningBytes,
    open: readMeaningBytes,
    busy: () => state.busy,
    idle: async () => {},
  };
  return {
    work,
    state,
    embedder,
    embedded,
    counted,
    writes,
    keep: (vectors: KeptMeaning) => {
      kept = meaningBytes(vectors);
    },
    mostInFlight: () => mostInFlight,
  };
}

/** Run timers until nothing is left to embed, a few minutes at most. */
async function settle(minutes = 5) {
  await vi.advanceTimersByTimeAsync(minutes * 60_000);
}

const beach: Page = {
  pageId: 'beach',
  revisionId: 'beach-1',
  title: 'Summer holiday',
  text: 'A week at the beach in Cornwall.',
};
const boiler: Page = {
  pageId: 'boiler',
  revisionId: 'boiler-1',
  title: 'The boiler',
  text: 'The boiler loses pressure every winter.',
};
const soupBook: Page = {
  pageId: 'soups',
  revisionId: 'soups-1',
  title: 'Soups',
  text: [section('Bean soup', 'soup', 180), section('Leek soup', 'soup', 180)].join('\n'),
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MeaningIndexer', () => {
  it('embeds each page once the word index is built, one passage at a time', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    const seen: (ReturnType<MeaningIndexer['status']> | null)[] = [];
    indexer.subscribe(() => seen.push(indexer.status()));
    await settle();
    expect(fake.embedder.embed).not.toHaveBeenCalled();
    expect(indexer.status()).toBeNull();

    indexer.indexChanged(wordIndex([beach, boiler, soupBook]));
    await settle();
    // The book is two passages, one a section; each passage is asked alone.
    expect(fake.embedded).toHaveLength(4);
    expect(fake.embedder.embed.mock.calls.every(([, texts]) => texts.length === 1)).toBe(true);
    expect(fake.mostInFlight()).toBe(1);
    expect(fake.embedded.filter((text) => text.startsWith('Soups\n# Bean soup'))).toHaveLength(1);
    expect(indexer.status()).toEqual({ pages: 3, total: 3 });
    expect(seen[0]).toEqual({ pages: 0, total: 3 });
    expect(seen.map((status) => status?.pages)).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(meaningProgress({ pages: 340, total: 1200 })).toBe(
      'By meaning: 340 of 1,200 pages so far',
    );
    expect(meaningProgress({ pages: 3, total: 3 })).toBeNull();
    // Passages are cut by the tokenizer's count of each word, asked once a page.
    expect(fake.counted).toHaveLength(3);
    expect(fake.counted[0]).toEqual([...new Set(fake.counted[0])]);
  });

  it('rests between passages, as long as half the last one took', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach, boiler]));
    await vi.advanceTimersByTimeAsync(EMBED_MS + 1);
    expect(fake.embedded).toHaveLength(1);
    // Resting: half of 200 ms.
    await vi.advanceTimersByTimeAsync(EMBED_MS / 2 - 10);
    expect(fake.embedder.embed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(EMBED_MS + 20);
    expect(fake.embedded).toHaveLength(2);
  });

  it('a clock set back doesn’t hold the queue up for as long', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach, boiler]));
    await vi.advanceTimersByTimeAsync(EMBED_MS + 1);
    expect(fake.embedded).toHaveLength(1);
    vi.setSystemTime(Date.now() - 3_600_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.embedded).toHaveLength(2);
  });

  it('cuts passages by the count the tokenizer gives', async () => {
    const fake = fakeWork();
    // Each word three tokens: the boiler's 7 words and title fit; the book's sections don't.
    fake.embedder.count.mockImplementation(async (words: string[]) => words.map(() => 3));
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([soupBook]));
    await settle();
    // 180 words of 3 tokens each, past 256: each section cut in three.
    expect(fake.embedded.length).toBeGreaterThanOrEqual(6);
  });

  it('opens the kept vectors before anything, and embeds only versions without them', async () => {
    const fake = fakeWork();
    fake.keep(
      new Map([
        [
          rev('beach-1'),
          [
            {
              hash: 'AAAAAAAAAAAAAAAAAAAAAA',
              start: 0,
              vector: { scale: 1, values: new Int8Array(4) },
            },
          ],
        ],
        // A version no page shows any more.
        [
          rev('gone-1'),
          [
            {
              hash: 'AAAAAAAAAAAAAAAAAAAAAA',
              start: 0,
              vector: { scale: 1, values: new Int8Array(4) },
            },
          ],
        ],
      ]),
    );
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach, boiler]));
    await settle();
    expect(fake.embedded).toEqual(['The boiler\nThe boiler loses pressure every winter.']);
    expect(indexer.status()).toEqual({ pages: 2, total: 2 });
    // What a page no longer shows went at once.
    expect([...fake.writes[0]!.keys()]).toEqual([rev('beach-1')]);
    expect([...fake.writes.at(-1)!.keys()].sort()).toEqual([rev('beach-1'), rev('boiler-1')]);
  });

  it('a new version embeds only the passages whose text changed', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([soupBook]));
    await settle();
    expect(fake.embedded).toHaveLength(2);
    const changed = {
      ...soupBook,
      revisionId: 'soups-2',
      text: [section('Bean soup', 'soup', 180), section('Pea soup', 'soup', 180)].join('\n'),
    };
    indexer.indexChanged(wordIndex([changed]));
    await settle();
    expect(fake.embedded).toHaveLength(3);
    expect(fake.embedded[2]).toMatch(/^Soups\n# Pea soup\n/);
    // The version before went, at once: it isn't this person's draft.
    expect([...fake.writes.at(-1)!.keys()]).toEqual([rev('soups-2')]);
  });

  it('embeds a draft being typed once its saves pause for 30 s, the version before standing in', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach, boiler]));
    await settle();
    expect(fake.embedded).toHaveLength(2);
    const query = Float32Array.from([0, 0, 1, 0]);
    const soupScore = () =>
      indexer.nearest(query, 5).find((hit) => hit.pageId === 'beach')?.score ?? 0;
    expect(soupScore()).toBeLessThan(0.5);

    const draft = (n: number) => ({
      ...beach,
      revisionId: `beach-d${n}`,
      text: `A week at the beach in Cornwall, and soup ${n}.`,
    });
    const save = (n: number) =>
      indexer.saved({
        spaceId: home,
        pageId: PageId.parse('beach'),
        revisionId: rev(`beach-d${n}`),
        basedOn: rev(n === 1 ? 'beach-1' : `beach-d${n - 1}`),
      });
    save(1);
    indexer.indexChanged(wordIndex([draft(1), boiler]));
    await vi.advanceTimersByTimeAsync(20_000);
    save(2);
    indexer.indexChanged(wordIndex([draft(2), boiler]));
    await vi.advanceTimersByTimeAsync(DRAFT_PAUSE_MS - 1_000);
    expect(fake.embedded).toHaveLength(2);
    // The version before stands in, and counts as done.
    expect(indexer.status()).toEqual({ pages: 2, total: 2 });
    expect(indexer.nearest(Float32Array.from([1, 0, 0, 0]), 1)[0]?.pageId).toBe('beach');
    await vi.advanceTimersByTimeAsync(1_000 + EMBED_MS + 10);
    expect(fake.embedded).toEqual([
      expect.any(String),
      expect.any(String),
      'Summer holiday\nA week at the beach in Cornwall, and soup 2.',
    ]);
    expect(soupScore()).toBeGreaterThan(0.5);
    // Only the draft is kept now.
    await settle(1);
    expect([...fake.writes.at(-1)!.keys()].sort()).toEqual([rev('beach-d2'), rev('boiler-1')]);
  });

  it('a draft waiting while other pages are embedded is embedded once its pause ends', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach]));
    await settle();
    const others = Array.from({ length: 300 }, (_, i) => ({
      pageId: `p${i}`,
      revisionId: `p${i}-1`,
      title: `Page ${i}`,
      text: `Text of page ${i}.`,
      updated: '2026-11-01T10:00:00.000Z',
    }));
    const draft = (n: number) => ({ ...beach, revisionId: `beach-d${n}`, text: `Soup ${n}.` });
    const ref = { spaceId: home, pageId: PageId.parse('beach') };
    indexer.saved({ ...ref, revisionId: rev('beach-d1'), basedOn: rev('beach-1') });
    indexer.indexChanged(wordIndex([draft(1), ...others]));
    await vi.advanceTimersByTimeAsync(10_000);
    indexer.saved({ ...ref, revisionId: rev('beach-d2'), basedOn: rev('beach-d1') });
    indexer.indexChanged(wordIndex([draft(2), ...others]));
    // Past the first save's pause, the second's still on: the others go on.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.embedded).not.toContain('Summer holiday\nSoup 2.');
    await vi.advanceTimersByTimeAsync(11_000);
    expect(fake.embedded).toContain('Summer holiday\nSoup 2.');
  });

  it('a draft saved elsewhere, as in another tab, waits for its versions to pause too', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach, boiler]));
    await settle();
    const writes = fake.writes.length;
    const draft = (n: number) => ({
      ...beach,
      revisionId: `beach-d${n}`,
      text: `A week at the beach, and soup ${n}.`,
      draft: true,
    });
    // No save heard here: only the word index shows each new draft.
    indexer.indexChanged(wordIndex([draft(1), boiler]));
    await vi.advanceTimersByTimeAsync(10_000);
    indexer.indexChanged(wordIndex([draft(2), boiler]));
    await vi.advanceTimersByTimeAsync(DRAFT_PAUSE_MS - 1_000);
    expect(fake.embedded).toHaveLength(2);
    // The version before stood in, so nothing was let go of, or written.
    expect(indexer.status()).toEqual({ pages: 2, total: 2 });
    expect(fake.writes).toHaveLength(writes);
    await settle(1);
    expect(fake.embedded.at(-1)).toBe('Summer holiday\nA week at the beach, and soup 2.');
  });

  it('a save into the queue, on its base, embeds the page again once saves pause', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach]));
    await settle();
    const ref = { spaceId: home, pageId: PageId.parse('beach') };
    indexer.saved({ ...ref, revisionId: rev('beach-1'), basedOn: rev('beach-1') });
    indexer.indexChanged(wordIndex([{ ...beach, text: 'Soup on the beach.' }]));
    await vi.advanceTimersByTimeAsync(DRAFT_PAUSE_MS - 1_000);
    expect(fake.embedded).toHaveLength(1);
    await settle(1);
    expect(fake.embedded).toEqual([expect.any(String), 'Summer holiday\nSoup on the beach.']);
  });

  it('gives up a page that changes while it is embedded, and takes its new version', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([soupBook]));
    await vi.advanceTimersByTimeAsync(EMBED_MS / 2);
    const changed = { ...soupBook, revisionId: 'soups-2', title: 'Winter soups' };
    indexer.indexChanged(wordIndex([changed]));
    await settle();
    // The first passage, asked of the old version, is never kept.
    expect(fake.embedded.filter((text) => text.startsWith('Winter soups'))).toHaveLength(2);
    expect([...fake.writes.at(-1)!.keys()]).toEqual([rev('soups-2')]);
  });

  it('a page edited between its passages embeds only the passage that changed', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([soupBook]));
    // The first passage done, resting before the second.
    await vi.advanceTimersByTimeAsync(EMBED_MS + 10);
    expect(fake.embedded).toHaveLength(1);
    const changed = {
      ...soupBook,
      revisionId: 'soups-2',
      text: [section('Bean soup', 'soup', 180), section('Pea soup', 'soup', 180)].join('\n'),
    };
    indexer.indexChanged(wordIndex([changed]));
    await settle();
    expect(fake.embedded).toHaveLength(2);
    expect(fake.embedded[1]).toMatch(/^Soups\n# Pea soup\n/);
  });

  it('a page that leaves takes its vectors with it, and the file is written at once', async () => {
    const fake = fakeWork();
    let idle = true;
    const indexer = new MeaningIndexer({
      ...fake.work,
      // At once means without waiting for a moment free.
      idle: () => (idle ? Promise.resolve() : new Promise(() => {})),
    });
    indexer.indexChanged(wordIndex([beach, boiler]));
    await settle();
    idle = false;
    const writes = fake.writes.length;
    indexer.indexChanged(wordIndex([boiler]));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.writes).toHaveLength(writes + 1);
    expect([...fake.writes.at(-1)!.keys()]).toEqual([rev('boiler-1')]);
    expect(indexer.nearest(Float32Array.from([1, 0, 0, 0]), 5).map((hit) => hit.pageId)).toEqual([
      'boiler',
    ]);
    expect(indexer.status()).toEqual({ pages: 1, total: 1 });
  });

  it('a draft of this person’s that leaves is let go of in the file at once too', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach, boiler]));
    await settle();
    indexer.saved({
      spaceId: home,
      pageId: PageId.parse('beach'),
      revisionId: rev('beach-d1'),
      basedOn: rev('beach-1'),
    });
    indexer.indexChanged(wordIndex([{ ...beach, revisionId: 'beach-d1' }, boiler]));
    await settle();
    expect([...fake.writes.at(-1)!.keys()].sort()).toEqual([rev('beach-d1'), rev('boiler-1')]);
    const writes = fake.writes.length;
    // Deleted, or its space no longer shared.
    indexer.indexChanged(wordIndex([boiler]));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.writes).toHaveLength(writes + 1);
    expect([...fake.writes.at(-1)!.keys()]).toEqual([rev('boiler-1')]);
  });

  it('an index built offline from the pages kept alone lets go of nothing', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach, boiler]));
    await settle();
    const writes = fake.writes.length;
    // Offline, the beach wasn't kept on this device: the index lacks it.
    indexer.indexChanged(wordIndex([boiler]), { partial: true });
    await settle(1);
    expect(fake.writes).toHaveLength(writes);
    expect(indexer.status()).toEqual({ pages: 1, total: 1 });
    // Back online, it is there, with its vectors: nothing embedded again.
    indexer.indexChanged(wordIndex([beach, boiler]));
    await settle(1);
    expect(fake.embedded).toHaveLength(2);
    expect(indexer.status()).toEqual({ pages: 2, total: 2 });
  });

  it('a draft embedded while the index is partial lets go of nothing either', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach, boiler]));
    await settle();
    const ref = { spaceId: home, pageId: PageId.parse('beach') };
    const draft = { ...beach, revisionId: 'beach-d1', text: 'Soup at the beach.' };
    indexer.saved({ ...ref, revisionId: rev('beach-d1'), basedOn: rev('beach-1') });
    indexer.indexChanged(wordIndex([draft, boiler]));
    // Offline within the pause, and the boiler isn't kept on this device.
    indexer.indexChanged(wordIndex([draft]), { partial: true });
    await settle(1);
    expect(fake.embedded).toHaveLength(3);
    expect([...fake.writes.at(-1)!.keys()].sort()).toEqual([
      rev('beach-1'),
      rev('beach-d1'),
      rev('boiler-1'),
    ]);
    // Back online: the boiler needs nothing, and the version before goes.
    indexer.indexChanged(wordIndex([draft, boiler]));
    await settle(1);
    expect(fake.embedded).toHaveLength(3);
    expect([...fake.writes.at(-1)!.keys()].sort()).toEqual([rev('beach-d1'), rev('boiler-1')]);
  });

  it('after access changes, a partial index keeps nothing until a whole one comes', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach, boiler]));
    await settle();
    const writes = fake.writes.length;
    indexer.indexGone();
    // Rebuilt offline: the beach's space may be the one lost.
    indexer.indexChanged(wordIndex([boiler, soupBook]), { partial: true });
    await settle();
    expect(fake.embedded).toHaveLength(4);
    expect(fake.writes).toHaveLength(writes);
    indexer.indexChanged(wordIndex([boiler, soupBook]));
    await vi.advanceTimersByTimeAsync(0);
    expect([...fake.writes.at(-1)!.keys()].sort()).toEqual([rev('boiler-1'), rev('soups-1')]);
  });

  it('a page’s second failure as the index goes leaves the status as it went', async () => {
    const fake = fakeWork();
    fake.state.failOn = 'Cornwall';
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach]));
    // The first failure, then the retry a minute later, which fails as the index goes.
    await vi.advanceTimersByTimeAsync(60_000 + EMBED_MS * 1.5);
    expect(fake.embedder.embed).toHaveBeenCalledTimes(2);
    indexer.indexGone();
    await settle();
    expect(indexer.status()).toBeNull();
  });

  it('a draft saved while the word index is built afresh still waits, the version before standing in', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([soupBook]));
    await settle();
    expect(fake.embedded).toHaveLength(2);
    indexer.indexGone();
    const draft = {
      ...soupBook,
      revisionId: 'soups-d1',
      draft: true,
      text: [section('Bean soup', 'soup', 180), section('Pea soup', 'soup', 180)].join('\n'),
    };
    indexer.indexChanged(wordIndex([draft]));
    await vi.advanceTimersByTimeAsync(DRAFT_PAUSE_MS - 1_000);
    expect(fake.embedded).toHaveLength(2);
    expect(indexer.status()).toEqual({ pages: 1, total: 1 });
    await settle(1);
    // Only the section that changed.
    expect(fake.embedded).toHaveLength(3);
  });

  it('a draft embedded under a partial index between two rebuilds lets the version before go', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach]));
    await settle();
    indexer.indexGone();
    const draft = { ...beach, revisionId: 'beach-d1', text: 'Soup at the beach.', draft: true };
    indexer.indexChanged(wordIndex([draft]), { partial: true });
    await settle(1);
    expect(fake.embedded).toHaveLength(2);
    indexer.indexGone();
    indexer.indexChanged(wordIndex([draft]));
    await vi.advanceTimersByTimeAsync(0);
    expect([...fake.writes.at(-1)!.keys()]).toEqual([rev('beach-d1')]);
  });

  it('the same index, no longer partial once updated online, lets go as a whole one', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach, boiler]));
    await settle();
    const offline = wordIndex([boiler]);
    indexer.indexChanged(offline, { partial: true });
    await settle(1);
    const writes = fake.writes.length;
    // Back online, the update found nothing changed: the same index, whole.
    indexer.indexChanged(offline);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.writes).toHaveLength(writes + 1);
    expect([...fake.writes.at(-1)!.keys()]).toEqual([rev('boiler-1')]);
  });

  it('while the word index is built afresh, as access changes, nothing is found or kept', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach, boiler]));
    await settle();
    const writes = fake.writes.length;
    indexer.indexGone();
    expect(indexer.nearest(Float32Array.from([1, 1, 1, 1]), 5)).toEqual([]);
    expect(indexer.status()).toBeNull();
    // A page saved meanwhile waits for the new index.
    indexer.saved({
      spaceId: home,
      pageId: PageId.parse('beach'),
      revisionId: rev('beach-1'),
      basedOn: rev('beach-1'),
    });
    await settle(2);
    expect(fake.writes).toHaveLength(writes);
    expect(fake.embedded).toHaveLength(2);
    // The new index lost the beach: its vectors go, from the file at once.
    indexer.indexChanged(wordIndex([boiler]));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.writes).toHaveLength(writes + 1);
    expect([...fake.writes.at(-1)!.keys()]).toEqual([rev('boiler-1')]);
    expect(indexer.status()).toEqual({ pages: 1, total: 1 });
  });

  it('keeps the file once embedding pauses, and at least once a minute while it goes on', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    const pages = Array.from({ length: 400 }, (_, i) => ({
      pageId: `p${i}`,
      revisionId: `p${i}-1`,
      title: `Page ${i}`,
      text: `Text of page ${i}.`,
    }));
    indexer.indexChanged(wordIndex(pages));
    // 400 passages of 200 ms, resting 100 ms after each: two minutes.
    await vi.advanceTimersByTimeAsync(KEEP_AT_MOST_MS + 1_000);
    expect(fake.writes).toHaveLength(1);
    const first = fake.writes[0]!.size;
    expect(first).toBeGreaterThan(150);
    expect(first).toBeLessThan(250);
    await vi.advanceTimersByTimeAsync(KEEP_AT_MOST_MS);
    expect(fake.writes).toHaveLength(2);
    await settle();
    expect(fake.writes.at(-1)!.size).toBe(400);
    const done = fake.writes.length;
    await vi.advanceTimersByTimeAsync(KEEP_MS * 4);
    expect(fake.writes).toHaveLength(done);
  });

  it('writes nothing over a kept file it couldn’t read', async () => {
    const fake = fakeWork();
    fake.state.unreadable = true;
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach]));
    await settle();
    expect(fake.embedded).toHaveLength(1);
    expect(fake.writes).toHaveLength(0);
  });

  it('keeps nothing where the device keeps no file', async () => {
    const fake = fakeWork();
    fake.state.file = null;
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach]));
    await settle();
    expect(fake.embedded).toHaveLength(1);
    expect(fake.writes).toHaveLength(0);
  });

  it('waits while a page opens or the word index updates', async () => {
    const fake = fakeWork();
    fake.state.busy = true;
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach, boiler]));
    await settle(1);
    // Counting a page's tokens waits too: the worker is asked nothing.
    expect(fake.embedder.count).not.toHaveBeenCalled();
    expect(fake.embedder.embed).not.toHaveBeenCalled();
    fake.state.busy = false;
    await settle(1);
    expect(fake.embedded).toHaveLength(2);
  });

  it('a page whose passage fails twice is passed over, and the others go on', async () => {
    const fake = fakeWork();
    fake.state.failOn = 'Cornwall';
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach, boiler]));
    await settle();
    expect(fake.embedded).toEqual(['The boiler\nThe boiler loses pressure every winter.']);
    // It can't be found by meaning, so it isn't counted.
    expect(indexer.status()).toEqual({ pages: 1, total: 1 });
    // Its next version is tried again.
    fake.state.failOn = null;
    indexer.indexChanged(wordIndex([{ ...beach, revisionId: 'beach-2' }, boiler]));
    await settle();
    expect(indexer.status()).toEqual({ pages: 2, total: 2 });
  });

  it('stopped while waiting to try again, it stays stopped', async () => {
    const fake = fakeWork();
    fake.state.failNext = true;
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach]));
    await vi.advanceTimersByTimeAsync(1_000);
    indexer.stop();
    // No timer left holding the page it was on.
    expect(vi.getTimerCount()).toBe(0);
    await settle(2);
    expect(indexer.status()).toBeNull();
    expect(fake.embedded).toHaveLength(0);
  });

  it('a page that failed once, then embedded, isn’t passed over at its next failure', async () => {
    const fake = fakeWork();
    fake.state.failNext = true;
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach]));
    await settle(2);
    expect(fake.embedded).toHaveLength(1);
    // Saved into the queue, on its base: embedded again, failing once.
    const ref = { spaceId: home, pageId: PageId.parse('beach') };
    indexer.saved({ ...ref, revisionId: rev('beach-1'), basedOn: rev('beach-1') });
    indexer.indexChanged(wordIndex([{ ...beach, text: 'Soup on the beach.' }]));
    fake.state.failNext = true;
    await settle(3);
    expect(fake.embedded.at(-1)).toBe('Summer holiday\nSoup on the beach.');
    expect(indexer.status()).toEqual({ pages: 1, total: 1 });
  });

  it('a page passed over as it failed is tried again after a save into the queue', async () => {
    const fake = fakeWork();
    fake.state.failOn = 'Cornwall';
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach]));
    await settle();
    expect(indexer.status()).toEqual({ pages: 0, total: 0 });
    fake.state.failOn = null;
    const ref = { spaceId: home, pageId: PageId.parse('beach') };
    indexer.saved({ ...ref, revisionId: rev('beach-1'), basedOn: rev('beach-1') });
    indexer.indexChanged(wordIndex([{ ...beach, text: 'Soup on the beach.' }]));
    await settle(2);
    expect(fake.embedded).toEqual(['Summer holiday\nSoup on the beach.']);
    expect(indexer.status()).toEqual({ pages: 1, total: 1 });
  });

  it('a model that can’t load is tried again each minute, no page passed over', async () => {
    const fake = fakeWork();
    fake.state.unavailable = 3;
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach]));
    await vi.advanceTimersByTimeAsync(3 * 60_000 - 1_000);
    expect(fake.embedded).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.embedded).toHaveLength(1);
    expect(indexer.status()).toEqual({ pages: 1, total: 1 });
  });

  it('a page whose tokens can’t be counted twice is passed over too', async () => {
    const fake = fakeWork();
    fake.embedder.count.mockImplementation(async (words: string[]) => {
      if (words.includes('Cornwall.')) throw new Error('The embedding worker stopped.');
      return words.map(estimateTokens);
    });
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach, boiler]));
    await settle();
    expect(fake.embedded).toEqual(['The boiler\nThe boiler loses pressure every winter.']);
    expect(indexer.status()).toEqual({ pages: 1, total: 1 });
  });

  it('a flush waits for a write already under way', async () => {
    const fake = fakeWork();
    // Once embedded, a moment free comes only when let through.
    let gated = false;
    const waiting: (() => void)[] = [];
    const indexer = new MeaningIndexer({
      ...fake.work,
      idle: () =>
        gated ? new Promise<void>((resolve) => waiting.push(resolve)) : Promise.resolve(),
    });
    indexer.indexChanged(wordIndex([beach]));
    await vi.advanceTimersByTimeAsync(EMBED_MS + 10);
    expect(fake.embedded).toHaveLength(1);
    gated = true;
    // The write after it starts, and waits for a moment free.
    await vi.advanceTimersByTimeAsync(KEEP_MS);
    expect(waiting).toHaveLength(1);
    let flushed = false;
    const flushing = indexer.flush().then(() => (flushed = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(flushed).toBe(false);
    expect(fake.writes).toHaveLength(0);
    waiting.shift()!();
    await flushing;
    expect(fake.writes).toHaveLength(1);
  });

  it('flushes what it made before handing the queue to another tab', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach, boiler]));
    await vi.advanceTimersByTimeAsync(EMBED_MS * 2);
    expect(fake.writes).toHaveLength(0);
    await indexer.flush();
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]!.size).toBeGreaterThanOrEqual(1);
    // Nothing waits to be kept: no second write.
    await indexer.flush();
    expect(fake.writes).toHaveLength(1);
  });

  it('tries again a minute after the worker fails', async () => {
    const fake = fakeWork();
    fake.state.failNext = true;
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach]));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.embedded).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fake.embedded).toHaveLength(1);
  });

  it('stopping, as a lock does, drops the vectors and the worker, and keeps nothing after', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach, boiler, soupBook]));
    await vi.advanceTimersByTimeAsync(EMBED_MS * 2);
    const writes = fake.writes.length;
    indexer.stop();
    expect(fake.embedder.stop).toHaveBeenCalled();
    expect(indexer.status()).toBeNull();
    expect(indexer.nearest(Float32Array.from([1, 1, 1, 1]), 5)).toEqual([]);
    await settle();
    expect(fake.embedded.length).toBeLessThanOrEqual(2);
    expect(fake.writes).toHaveLength(writes);
    indexer.indexChanged(wordIndex([beach]));
    await settle();
    expect(fake.embedded.length).toBeLessThanOrEqual(2);
  });

  it('finds the nearest pages by their best passage, with only those a filter keeps', async () => {
    const fake = fakeWork();
    const indexer = new MeaningIndexer(fake.work);
    indexer.indexChanged(wordIndex([beach, boiler, soupBook]));
    await settle();
    const hits = indexer.nearest(Float32Array.from([0, 0, 1, 0]), 2);
    expect(hits.map((hit) => hit.pageId)).toEqual(['soups', expect.any(String)]);
    // Its first section's text, after its heading.
    expect(hits[0]?.passage.start).toBe('# Bean soup\n'.length);
    expect(hits[0]?.score).toBeGreaterThan(0.9);
    const filtered = indexer.nearest(
      Float32Array.from([0, 0, 1, 0]),
      2,
      (entry) => entry.pageId !== 'soups',
    );
    expect(filtered.map((hit) => hit.pageId)).not.toContain('soups');
  });
});
