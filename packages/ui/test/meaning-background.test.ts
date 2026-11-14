import {
  generateIdentity,
  IdentityId,
  InstallationId,
  openMeaningIndex,
  PageId,
  RevisionId,
  searchOperations,
  SpaceId,
  type ClientContext,
} from '@wikistow/client';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { KEEP_MS } from '../src/data/index-tracker';

// The queue as the app starts it (`startMeaningIndex`): following the word
// index's query, and sealing for the open session.

const kept = vi.hoisted(() => ({ writes: [] as Uint8Array[], file: null as Uint8Array | null }));

vi.mock('../src/meaning/meaning-file', () => ({
  meaningIndexFile: async () => ({
    read: async () => kept.file,
    write: async (sealed: Uint8Array) => {
      kept.file = sealed;
      kept.writes.push(sealed);
    },
  }),
  dropMeaningIndex: async () => {},
}));

vi.mock('../src/meaning/embedder', async (actual) => {
  const real = await actual<typeof import('../src/meaning/embedder')>();
  class Embedder {
    count = async (words: string[]) => words.map(() => 1);
    embed = async (_kind: string, texts: string[]) => ({
      vectors: texts.map(() => Float32Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0))),
      tokens: texts.map(() => 1),
    });
    stop() {}
  }
  return { ...real, Embedder };
});

const { searchIndexKey } = await import('../src/data/queries');
const { startMeaningIndex } = await import('../src/meaning/background');
const { vaultStore } = await import('../src/vault/store');
const { MEANING_MODEL } = await import('../src/meaning/model');

const home = SpaceId.parse('home');

function wordIndex() {
  const index = new searchOperations.PageIndex();
  index.addText(
    {
      spaceId: home,
      pageId: PageId.parse('beach'),
      revisionId: RevisionId.parse('beach-1'),
      parentId: null,
      folderIds: [],
      path: ['Home'],
      draft: false,
      unpublished: false,
    },
    { title: 'Summer holiday', text: 'A week at the beach.', headings: [] },
  );
  return index;
}

function session() {
  const ctx = {
    identity: generateIdentity({ id: IdentityId.parse('alice'), kind: 'human' }),
    installationId: InstallationId.parse('test-installation'),
  } as unknown as ClientContext;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Built already, and fresh: the queue follows it without building it again.
  queryClient.setQueryData(searchIndexKey, wordIndex());
  return { ctx, queryClient };
}

beforeEach(() => {
  vi.useFakeTimers();
  kept.writes = [];
  kept.file = null;
  vi.stubGlobal('requestIdleCallback', (run: () => void) => setTimeout(run, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the queue in the app', () => {
  it('embeds what the word index holds, and keeps it sealed for this person and model', async () => {
    const { ctx, queryClient } = session();
    const started = startMeaningIndex(queryClient, ctx);
    await vi.advanceTimersByTimeAsync(KEEP_MS + 1_000);
    expect(started.indexer.status()).toEqual({ pages: 1, total: 1 });
    expect(kept.writes).toHaveLength(1);
    const opened = openMeaningIndex(ctx, kept.writes[0]!, MEANING_MODEL.files.model.sha256);
    expect([...opened!.keys()]).toEqual(['beach-1']);
    started.stop();
  });

  it('finds nothing once the word index is reset as access changes', async () => {
    const { ctx, queryClient } = session();
    const started = startMeaningIndex(queryClient, ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      started.indexer.nearest(
        Float32Array.from({ length: 384 }, () => 1),
        5,
      ),
    ).toHaveLength(1);
    // As `refreshAccess` does; the rebuild it starts never finishes here.
    queryClient.setQueryDefaults(searchIndexKey, { queryFn: () => new Promise(() => {}) });
    void queryClient.resetQueries({ queryKey: searchIndexKey });
    await vi.advanceTimersByTimeAsync(0);
    expect(
      started.indexer.nearest(
        Float32Array.from({ length: 384 }, () => 1),
        5,
      ),
    ).toEqual([]);
    expect(started.indexer.status()).toBeNull();
    started.stop();
  });

  it('seals nothing once the vault has locked, before the queue hears of it', async () => {
    const { ctx, queryClient } = session();
    const started = startMeaningIndex(queryClient, ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started.indexer.status()).toEqual({ pages: 1, total: 1 });
    // Locked: the keys are zeroed, and the queue isn't stopped yet.
    vaultStore.lock();
    await vi.advanceTimersByTimeAsync(KEEP_MS + 1_000);
    expect(kept.writes).toEqual([]);
    started.stop();
  });
});
