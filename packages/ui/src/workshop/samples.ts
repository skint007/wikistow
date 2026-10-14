import {
  PluginError,
  type Json,
  type PageChange,
  type PageHandle,
  type PageRef,
  type Pages,
  type PageVersion,
} from '@wikistow/plugin-sdk';
import type { Caller } from '../plugins/pages';
import type { ShownPage } from '../plugins/runtime';

/** The space the workshop's sample pages are in, which no real page is. */
export const SAMPLE_SPACE = 'workshop-samples';

/**
 * A page of the workshop's own (#257): disposable text the preview shows
 * and the plugin being built reads and changes. Nothing here reaches the
 * server. A real page comes in only as a copy the person chose to take.
 */
export type Sample = {
  pageId: string;
  title: string;
  markdown: string;
  data: Json | null;
  /** Counts every change, the base a plugin's save names. */
  revision: number;
  /** Counts changes made outside the preview's editor, which shows them afresh. */
  outside: number;
  /** The real page it is a copy of, by title, if the person took one. */
  copyOf: string | null;
};

const unloaded = () => new PluginError('unloaded', 'The plugin was turned off');
const elsewhere = () =>
  new PluginError('not-found', 'The workshop’s preview has only its own sample pages');

/** The workshop's sample pages, in the order they were made. */
export function sampleStore() {
  let samples: Sample[] = [];
  let made = 0;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };

  /** The preview's editor of each sample shown: each hands over what is typed in it. */
  const editors = new Map<string, () => void>();
  /** What is typed in a sample's editor, into the store first, as the app saves a draft's typing before a plugin reads or edits it. */
  const flush = (pageId: string) => editors.get(pageId)?.();

  const find = (ref: PageRef) =>
    ref.spaceId === SAMPLE_SPACE
      ? samples.find((sample) => sample.pageId === ref.pageId)
      : undefined;

  const set = (pageId: string, change: Partial<Sample>, outside: boolean) => {
    samples = samples.map((sample) =>
      sample.pageId === pageId
        ? {
            ...sample,
            ...change,
            revision: sample.revision + 1,
            outside: sample.outside + (outside ? 1 : 0),
          }
        : sample,
    );
    changed();
  };

  const add = (page: Pick<Sample, 'title' | 'markdown' | 'data' | 'copyOf'>): Sample => {
    made += 1;
    const sample: Sample = { ...page, pageId: `sample-${made}`, revision: 1, outside: 0 };
    samples = [...samples, sample];
    changed();
    return sample;
  };

  const versionOf = (sample: Sample, version: PageVersion['version']): PageVersion => ({
    spaceId: SAMPLE_SPACE,
    pageId: sample.pageId,
    folderId: null,
    title: sample.title,
    markdown: sample.markdown,
    revision: String(sample.revision),
    version,
    data: sample.data,
  });

  /** Apply a plugin's `change` to `ref` on top of `base`; a newer revision is a conflict. */
  const save = (ref: PageRef, base: string, change: PageChange) => {
    const sample = find(ref);
    if (!sample) throw elsewhere();
    if (String(sample.revision) !== base) {
      throw new PluginError('conflict', 'This sample changed since that revision; read it again');
    }
    set(
      sample.pageId,
      {
        ...(change.title === undefined ? {} : { title: change.title }),
        ...(change.markdown === undefined ? {} : { markdown: change.markdown }),
        ...(change.data === undefined ? {} : { data: change.data }),
      },
      true,
    );
    const saved = find(ref);
    if (!saved) throw elsewhere();
    return versionOf(saved, 'draft');
  };

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => samples,

    /** Add a sample page, or with `pageId` replace one's title and text. */
    put({
      pageId,
      title,
      markdown,
      copyOf = null,
    }: {
      pageId?: string | undefined;
      title: string;
      markdown: string;
      copyOf?: string | null;
    }): Sample {
      if (pageId === undefined) return add({ title, markdown, data: null, copyOf });
      if (!samples.some((sample) => sample.pageId === pageId)) {
        throw new Error(`There’s no sample page ${pageId}.`);
      }
      set(pageId, { title, markdown, copyOf }, true);
      const sample = samples.find((s) => s.pageId === pageId);
      if (!sample) throw new Error(`There’s no sample page ${pageId}.`);
      return sample;
    },

    /** The preview's editor shows `pageId`, and `flush` hands over what is typed, until the returned function runs. */
    editing(pageId: string, handOver: () => void) {
      editors.set(pageId, handOver);
      return () => {
        if (editors.get(pageId) === handOver) editors.delete(pageId);
      };
    },

    /** Every sample with what is typed in its editor, for reading them all. */
    flushed() {
      for (const pageId of editors.keys()) flush(pageId);
      return samples;
    },

    /**
     * The person typed in the preview's editor, which already shows it, drawn
     * for the sample's `outside` count. Its new revision, or null if nothing
     * changed, or the report is from an editor a change from outside replaced.
     */
    typed(pageId: string, markdown: string, outside: number): string | null {
      const sample = samples.find((s) => s.pageId === pageId);
      if (!sample || sample.outside !== outside || sample.markdown === markdown) return null;
      set(pageId, { markdown }, false);
      return String(sample.revision + 1);
    },

    /**
     * The page operations the plugin in the preview gets: its sample pages
     * only, within the access its manifest asks for. Folders and moves
     * aren't in a workshop.
     */
    pages(caller: Caller): Pages {
      const allow = (needs: 'read' | 'write') => {
        if (!caller.live()) throw unloaded();
        if (caller.access === 'none' || (needs === 'write' && caller.access !== 'write')) {
          throw new PluginError(
            'not-granted',
            needs === 'write'
              ? 'Its manifest doesn’t ask to change pages ("access": "write")'
              : 'Its manifest asks for no page access ("access")',
          );
        }
        if (needs === 'write') caller.write();
      };
      return {
        async read(ref) {
          allow('read');
          flush(ref.pageId);
          const sample = find(ref);
          if (!sample) throw elsewhere();
          return versionOf(sample, 'draft');
        },
        async list({ spaceId, folderId }) {
          allow('read');
          if (spaceId !== SAMPLE_SPACE || folderId !== null) throw elsewhere();
          return samples.map((sample) => ({
            kind: 'page',
            spaceId: SAMPLE_SPACE,
            pageId: sample.pageId,
            title: sample.title,
          }));
        },
        async search(text, options) {
          allow('read');
          for (const pageId of editors.keys()) flush(pageId);
          const needle = text.toLowerCase();
          return samples
            .filter((sample) =>
              `${sample.title}\n${sample.markdown}`.toLowerCase().includes(needle),
            )
            .slice(0, options?.limit ?? 20)
            .map((sample) => ({
              spaceId: SAMPLE_SPACE,
              pageId: sample.pageId,
              title: sample.title,
              draft: true,
            }));
        },
        async create({ spaceId, folderId }, { title, markdown = '', data }) {
          allow('write');
          if (spaceId !== SAMPLE_SPACE || folderId !== null) throw elsewhere();
          const sample = add({ title, markdown, data: data ?? null, copyOf: null });
          caller.wrote({ spaceId: SAMPLE_SPACE, pageId: sample.pageId }, String(sample.revision));
          return versionOf(sample, 'draft');
        },
        async createFolder() {
          allow('write');
          throw new PluginError('unsupported', 'The workshop’s preview has no folders');
        },
        async saveDraft(ref, { base, ...change }) {
          allow('write');
          flush(ref.pageId);
          const saved = save(ref, base, change);
          caller.wrote(ref, saved.revision);
          return saved;
        },
        async move() {
          allow('write');
          throw new PluginError('unsupported', 'The workshop’s preview has no folders');
        },
      };
    },

    /**
     * The handle a command or view gets for a sample shown: it reads the
     * sample as it is now, and, in the preview's editor, `edit` changes it
     * as the person's edit would, on top of what it last read.
     */
    handle(caller: Caller, shown: ShownPage): PageHandle {
      let lastRead: string | null = null;
      return {
        page: { ...shown.page },
        read: async () => {
          if (!caller.live()) throw unloaded();
          flush(shown.page.pageId);
          const sample = find(shown.page);
          if (!sample) throw elsewhere();
          lastRead = String(sample.revision);
          return versionOf(sample, shown.version);
        },
        edit:
          shown.version === 'draft'
            ? async (change: PageChange) => {
                if (!caller.live()) throw unloaded();
                caller.write();
                // What was typed since it read makes its edit a conflict, as in a draft.
                flush(shown.page.pageId);
                const sample = find(shown.page);
                if (!sample) throw elsewhere();
                const saved = save(shown.page, lastRead ?? String(sample.revision), change);
                lastRead = saved.revision;
                return saved;
              }
            : null,
      };
    },
  };
}

export type SampleStore = ReturnType<typeof sampleStore>;
