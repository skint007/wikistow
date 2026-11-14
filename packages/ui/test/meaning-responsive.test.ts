import {
  generateIdentity,
  IdentityId,
  InstallationId,
  openMeaningIndex,
  PageId,
  quantizeVector,
  RevisionId,
  sealMeaningIndex,
  searchOperations,
  SpaceId,
  type MeaningPassage,
} from '@wikistow/client';
import { describe, expect, it } from 'vite-plus/test';
import { MeaningIndexer, type MeaningWork } from '../src/meaning/meaning-index';

// Typing and searching stay responsive while the background queue runs
// (ADR 0016, step 4). The model runs in a worker, off this thread, so what
// could hold the page up is the queue's own work here: cutting passages,
// hashing them, following the word index as it changes, and sealing the
// kept file. This runs all of it for real, for a library of 2,000 pages,
// with a model that answers at once so the queue goes as fast as it can,
// while a timer ticks as a keypress would and searches run beside it.

const home = SpaceId.parse('home');
const DIMENSIONS = 384;
const PAGES = 2_000;

/** About 1.5 KB of text in three sections, as ADR 0016 assumes a page holds. */
function pageText(n: number) {
  const paragraph = (topic: string) =>
    Array.from(
      { length: 6 },
      (_, i) => `The ${topic} of page ${n} goes on, line ${i}, about winter pressure and soup.`,
    ).join(' ');
  return [
    '# Plan',
    paragraph('plan'),
    '# Notes',
    paragraph('notes'),
    '# Later',
    paragraph('later'),
  ].join('\n');
}

function wordIndex(count: number, version = 1) {
  const index = new searchOperations.PageIndex();
  for (let n = 0; n < count; n++) {
    const text = pageText(n);
    index.addText(
      {
        spaceId: home,
        pageId: PageId.parse(`page-${n}`),
        revisionId: RevisionId.parse(`page-${n}-${n < 10 ? version : 1}`),
        parentId: null,
        folderIds: [],
        path: ['Home'],
        draft: false,
        unpublished: false,
      },
      {
        title: `Page ${n}`,
        text,
        headings: [...text.matchAll(/^# /gm)].map(({ index }) => index),
        updated: new Date(Date.UTC(2026, 10, 1) + n * 60_000).toISOString(),
      },
    );
  }
  return index;
}

/** A unit vector of the model's length, from a number. */
function vector(seed: number) {
  const values = new Float32Array(DIMENSIONS);
  for (let i = 0; i < DIMENSIONS; i++) values[i] = Math.sin(seed * 31 + i);
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
}

describe('the background queue', () => {
  it('keeps typing and searching responsive while it runs', async () => {
    const keeper = {
      installationId: InstallationId.parse('test-installation'),
      identity: generateIdentity({ id: IdentityId.parse('alice'), kind: 'human' }),
    };
    const model = 'a'.repeat(64);
    // Most pages kept from before, so each write seals some 4,000 vectors.
    const before = wordIndex(PAGES);
    const kept = new Map<RevisionId, MeaningPassage[]>();
    for (const [n, page] of before.pages().entries()) {
      if (n % 10 === 0) continue;
      kept.set(page.doc.revisionId, [
        { hash: 'AAAAAAAAAAAAAAAAAAAAAA', start: 0, vector: quantizeVector(vector(n)) },
        { hash: 'AAAAAAAAAAAAAAAAAAAAAQ', start: 300, vector: quantizeVector(vector(n + 0.5)) },
      ]);
    }
    let sealed: Uint8Array | null = sealMeaningIndex(keeper, kept, model);
    let writes = 0;
    let embedded = 0;
    const work: MeaningWork = {
      embedder: {
        count: async (words) => words.map((word) => Math.ceil(word.length / 3)),
        embed: async (_kind, texts) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          embedded += texts.length;
          return { vectors: texts.map((_, i) => vector(embedded + i)) };
        },
        stop: () => {},
      },
      file: async () => ({
        read: async () => sealed,
        write: async (next) => {
          sealed = next;
          writes++;
        },
      }),
      seal: (vectors) => sealMeaningIndex(keeper, vectors, model),
      open: (bytes) => openMeaningIndex(keeper, bytes, model),
      busy: () => false,
      idle: () => new Promise((resolve) => setTimeout(resolve, 0)),
    };
    // The word index as it changes meanwhile, built beforehand: building it
    // is the word index's work, not the queue's.
    const after = wordIndex(PAGES - 5, 2);
    const indexer = new MeaningIndexer(work);
    indexer.indexChanged(before);
    // Running once it has opened what it kept, which it does once, at unlock.
    await new Promise<void>((resolve) => {
      const stop = indexer.subscribe(() => {
        stop();
        resolve();
      });
    });

    // A keypress each 16 ms, a frame's time, and how late each lands.
    const late: number[] = [];
    let last = performance.now();
    const typing = setInterval(() => {
      const now = performance.now();
      late.push(now - last - 16);
      last = now;
    }, 16);
    // A search as typing pauses, by words and by meaning, timed.
    const wordSearches: number[] = [];
    const meaningSearches: number[] = [];
    let index = before;
    const searching = setInterval(() => {
      let started = performance.now();
      index.search('winter pressure soup');
      wordSearches.push(performance.now() - started);
      started = performance.now();
      indexer.nearest(vector(7), 5);
      meaningSearches.push(performance.now() - started);
    }, 150);
    // Pages change as the queue goes, and some leave, which keeps the file at once.
    const changing = setTimeout(() => {
      index = after;
      indexer.indexChanged(index);
    }, 1_000);

    await new Promise((resolve) => setTimeout(resolve, 4_000));
    clearInterval(typing);
    clearInterval(searching);
    clearTimeout(changing);
    indexer.stop();

    // The queue got on: pages embedded, the file kept, after a page left.
    expect(embedded).toBeGreaterThan(100);
    expect(writes).toBeGreaterThanOrEqual(1);
    const worst = (times: number[]) => Math.max(...times);
    // No keypress waited past the 100 ms within which an answer feels
    // immediate (RAIL), and no search took a long task's 50 ms.
    expect(late.length).toBeGreaterThan(100);
    expect(worst(late)).toBeLessThan(100);
    expect(worst(wordSearches)).toBeLessThan(50);
    expect(worst(meaningSearches)).toBeLessThan(50);
  }, 30_000);
});
