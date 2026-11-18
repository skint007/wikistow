import {
  PageId,
  quantizeVector,
  RevisionId,
  searchOperations,
  SpaceId,
  type KeptMeaning,
  type MeaningPassage,
} from '@wikistow/client';
import { describe, expect, it, vi } from 'vite-plus/test';
import { MeaningIndexer, type MeaningWork } from '../src/meaning/meaning-index';
import {
  closeEnough,
  cutFrom,
  MEANING_FLOOR,
  MEANING_GAP,
  MEANING_LIMIT,
  meaningText,
  MeaningReader,
  passageSnippet,
  queueSource,
  type ReaderWork,
} from '../src/meaning/search';

const home = SpaceId.parse('home');

type Page = { pageId: string; revisionId: string; title: string; text: string };

function wordIndex(pages: readonly Page[]): searchOperations.PageIndex {
  const index = new searchOperations.PageIndex();
  for (const page of pages) {
    index.addText(
      {
        spaceId: home,
        pageId: PageId.parse(page.pageId),
        revisionId: RevisionId.parse(page.revisionId),
        parentId: null,
        folderIds: [],
        path: ['Home'],
        draft: false,
        unpublished: false,
      },
      { title: page.title, text: page.text },
    );
  }
  return index;
}

const passage = (start: number, ...vector: number[]): MeaningPassage => ({
  hash: `h${start}-${vector.join(',')}`,
  start,
  vector: quantizeVector(Float32Array.from(vector)),
});

const beach: Page = {
  pageId: 'beach',
  revisionId: 'beach-1',
  title: 'Summer holiday in Cornwall',
  text: 'We rented a cottage.\nThe kids swam.',
};
const boiler: Page = {
  pageId: 'boiler',
  revisionId: 'boiler-1',
  title: 'Boiler service',
  text: 'Serviced every October.',
};
const ferry: Page = {
  pageId: 'ferry',
  revisionId: 'ferry-2',
  title: 'Ferry',
  text: 'To the island.',
};

/** Each page's passages: the beach's second passage is nearest [1, 0, 0]. */
const KEPT: KeptMeaning = new Map([
  [RevisionId.parse('beach-1'), [passage(0, 0, 1, 0), passage(21, 1, 0, 0)]],
  [RevisionId.parse('boiler-1'), [passage(0, 0, 0, 1)]],
  // An older version than the index shows: not this page's now.
  [RevisionId.parse('ferry-1'), [passage(0, 1, 0.1, 0)]],
]);

function readerWork(kept: KeptMeaning | null = KEPT) {
  const sealed = new Uint8Array([1]);
  const embedder = {
    embed: vi.fn(async (_kind: 'query', texts: string[]) => ({
      vectors: texts.map(() => Float32Array.from([1, 0, 0])),
    })),
    load: vi.fn(async () => ({ from: 'cache' })),
    stop: vi.fn(),
  };
  const file = vi.fn(async () => ({
    read: async () => (kept ? sealed : null),
    write: async () => {},
  }));
  const open = vi.fn(() => kept);
  const work: ReaderWork = { embedder, file, open, idle: async () => {} };
  return { work, embedder, file, open };
}

describe('meaningText', () => {
  it('embeds the words without filters or quotes, once they hold three letters', () => {
    expect(meaningText('trip to the coast')).toBe('trip to the coast');
    expect(meaningText('tag:recipes something warming')).toBe('something warming');
    expect(meaningText('"beach holiday" status:done')).toBe('beach holiday');
    expect(meaningText('tag:soup')).toBeNull();
    expect(meaningText('ab')).toBeNull();
    expect(meaningText('a b c')).toBe('a b c');
    expect(meaningText('12 34')).toBeNull();
    expect(meaningText('  ')).toBeNull();
  });
});

describe('closeEnough', () => {
  it('keeps pages above the floor and near the best, five at most', () => {
    const hits = (...scores: number[]) => scores.map((score) => ({ score }));
    expect(closeEnough(hits(0.7, 0.65, MEANING_FLOOR - 0.01))).toEqual(hits(0.7, 0.65));
    expect(closeEnough(hits(0.75, 0.75 - MEANING_GAP - 0.01))).toEqual(hits(0.75));
    expect(closeEnough(hits(0.49, 0.45))).toEqual([]);
    expect(closeEnough(hits(0.6, 0.6, 0.6, 0.6, 0.6, 0.6))).toHaveLength(MEANING_LIMIT);
    expect(closeEnough([])).toEqual([]);
  });
});

describe('passageSnippet', () => {
  it('starts at the passage, on one line, cut at a word', () => {
    expect(passageSnippet('# Day 1\nWe walked.\nThen ate.', 8)).toBe('We walked. Then ate.');
    const long = `${'word '.repeat(60)}end`;
    const snippet = passageSnippet(long, 0);
    expect(snippet.endsWith('word…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(161);
    // One long word is cut, never between a character's halves.
    const emoji = passageSnippet('😀'.repeat(100), 0);
    expect(emoji.endsWith('😀…')).toBe(true);
  });
});

describe('cutFrom', () => {
  it('says whether passages could be cut from a text: each, in order, starting a word', () => {
    const text = '# Day 1\nWe walked to the bay.\nThen ate.';
    expect(cutFrom(text, [{ start: 0 }, { start: 8 }, { start: 30 }])).toBe(true);
    expect(cutFrom('', [{ start: 0 }])).toBe(true);
    expect(cutFrom(text, [])).toBe(true);
    // Mid-word, past the end, or out of order, as offsets into another text are.
    expect(cutFrom(text, [{ start: 0 }, { start: 10 }])).toBe(false);
    expect(cutFrom(text, [{ start: 0 }, { start: 60 }])).toBe(false);
    expect(cutFrom(text, [{ start: 8 }, { start: 0 }])).toBe(false);
    // At a space, not the word after it.
    expect(cutFrom(text, [{ start: 10 }, { start: 10 }])).toBe(false);
    expect(cutFrom('a  b', [{ start: 2 }])).toBe(false);
  });
});

describe('MeaningReader', () => {
  it('reads the kept vectors when search opens, finding pages by their best passage', async () => {
    const { work, embedder, file } = readerWork();
    const reader = new MeaningReader(work);
    const index = wordIndex([beach, boiler, ferry]);
    // Nothing read until search opens.
    expect(reader.status(index)).toBeNull();
    expect(file).not.toHaveBeenCalled();
    reader.prepare();
    expect(embedder.load).toHaveBeenCalledOnce();
    await reader.refresh();
    // The ferry's version kept isn't the one the index shows.
    expect(reader.status(index)).toEqual({ pages: 2, total: 3 });
    const query = await reader.query('trip to the coast');
    expect(embedder.embed).toHaveBeenCalledWith('query', ['trip to the coast']);
    const hits = reader.nearest(index, query, 5);
    expect(hits.map((hit) => hit.pageId)).toEqual(['beach', 'boiler']);
    expect(hits[0]?.passage.start).toBe(21);
    expect(hits[0]?.current).toBe(true);
    expect(hits[0]?.page.title).toBe('Summer holiday in Cornwall');
    expect(hits[0]?.score).toBeGreaterThan(0.99);
    // What `include` keeps, as filters and the word matches do.
    expect(reader.nearest(index, query, 5, (entry) => entry.pageId !== 'beach')).toHaveLength(1);
  });

  it('says when the vectors change, and drops them and the worker when stopped', async () => {
    const { work, embedder, file } = readerWork();
    const reader = new MeaningReader(work);
    const heard = vi.fn();
    reader.subscribe(heard);
    const before = reader.snapshot();
    await reader.refresh();
    expect(heard).toHaveBeenCalledOnce();
    expect(reader.snapshot()).not.toBe(before);
    reader.stop();
    expect(embedder.stop).toHaveBeenCalledOnce();
    const index = wordIndex([beach]);
    expect(reader.nearest(index, [1, 0, 0], 5)).toEqual([]);
    expect(reader.status(index)).toBeNull();
    await expect(reader.query('coast')).rejects.toThrow();
    // Nothing is read again after.
    reader.prepare();
    await reader.refresh();
    expect(file).toHaveBeenCalledOnce();
  });

  it('opens nothing read after it stopped, and keeps what it read when a read fails', async () => {
    const { work, file, open } = readerWork();
    let release = () => {};
    let idle = false;
    work.idle = () => {
      idle = true;
      return new Promise<void>((resolve) => (release = resolve));
    };
    const reader = new MeaningReader(work);
    const reading = reader.refresh();
    await vi.waitFor(() => expect(idle).toBe(true));
    expect(file).toHaveBeenCalled();
    reader.stop();
    release();
    await reading;
    expect(open).not.toHaveBeenCalled();

    const second = readerWork();
    const again = new MeaningReader(second.work);
    await again.refresh();
    const index = wordIndex([beach]);
    expect(again.status(index)).toEqual({ pages: 1, total: 1 });
    second.work.file = async () => ({
      read: async () => {
        throw new Error('IndexedDB refused');
      },
      write: async () => {},
    });
    await again.refresh();
    expect(again.status(index)).toEqual({ pages: 1, total: 1 });
  });

  it('opens the kept file again only once it has changed', async () => {
    const { work, file, open } = readerWork();
    let bytes = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    // Read afresh each time, as from IndexedDB or the desktop's disk.
    file.mockImplementation(async () => ({
      read: async () => Uint8Array.from(bytes),
      write: async () => {},
    }));
    const reader = new MeaningReader(work);
    const heard = vi.fn();
    reader.subscribe(heard);
    await reader.refresh();
    const first = reader.snapshot();
    await reader.refresh();
    expect(file).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledOnce();
    expect(heard).toHaveBeenCalledOnce();
    expect(reader.snapshot()).toBe(first);
    // Kept again by the queue: opened again.
    bytes = [1, 2, 3, 4, 5, 6, 7, 8, 10];
    await reader.refresh();
    expect(open).toHaveBeenCalledTimes(2);
    expect(heard).toHaveBeenCalledTimes(2);
    // A view not aligned for four bytes at a time: compared a byte at a time.
    const shifted = (...values: number[]) => {
      const view = new Uint8Array(new ArrayBuffer(12), 1, 9);
      view.set(values);
      return view;
    };
    file.mockImplementation(async () => ({
      read: async () => shifted(1, 2, 3, 4, 5, 6, 7, 8, 10),
      write: async () => {},
    }));
    await reader.refresh();
    expect(open).toHaveBeenCalledTimes(2);
    file.mockImplementation(async () => ({
      read: async () => shifted(1, 2, 3, 4, 5, 6, 7, 8, 11),
      write: async () => {},
    }));
    await reader.refresh();
    expect(open).toHaveBeenCalledTimes(3);
    // Gone, and back as it was: opened again.
    file.mockImplementation(async () => ({ read: async () => null, write: async () => {} }));
    await reader.refresh();
    file.mockImplementation(async () => ({
      read: async () => shifted(1, 2, 3, 4, 5, 6, 7, 8, 11),
      write: async () => {},
    }));
    await reader.refresh();
    expect(open).toHaveBeenCalledTimes(4);
  });

  it('says when a page’s kept passages weren’t cut from the text its word index shows', async () => {
    const { work } = readerWork();
    const reader = new MeaningReader(work);
    await reader.refresh();
    // Saved into this device's queue: the same revision ID, with another text.
    const edited = { ...beach, text: 'A cottage, rented.\nSwimming all day.' };
    const [hit] = reader.nearest(wordIndex([edited]), [1, 0, 0], 5);
    expect(hit?.pageId).toBe('beach');
    expect(hit?.current).toBe(false);
  });

  it('has no vectors where none are kept', async () => {
    const { work } = readerWork(null);
    const reader = new MeaningReader(work);
    await reader.refresh();
    const index = wordIndex([beach]);
    expect(reader.status(index)).toEqual({ pages: 0, total: 1 });
    expect(reader.nearest(index, [1, 0, 0], 5)).toEqual([]);
  });
});

describe('queueSource', () => {
  it('embeds the query with the queue’s own worker, as a query', async () => {
    const embed = vi.fn(async (_kind: 'passage' | 'query', texts: string[]) => ({
      vectors: texts.map(() => Float32Array.from([1, 0, 0])),
    }));
    const load = vi.fn(async () => ({}));
    const work: MeaningWork = {
      embedder: { count: async (words) => words.map(() => 1), embed, load, stop: () => {} },
      file: async () => null,
      seal: () => new Uint8Array(),
      open: () => null,
      busy: () => false,
      idle: async () => {},
    };
    const indexer = new MeaningIndexer(work);
    const source = queueSource(indexer);
    expect(queueSource(indexer)).toBe(source);
    source.prepare();
    expect(load).toHaveBeenCalledOnce();
    expect(await source.query('trip to the coast')).toEqual(Float32Array.from([1, 0, 0]));
    expect(embed).toHaveBeenCalledWith('query', ['trip to the coast']);
    indexer.stop();
    await expect(source.query('coast')).rejects.toThrow();
  });
});
