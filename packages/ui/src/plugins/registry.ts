import {
  REGIONS,
  isRegion,
  isReplaceable,
  type AppEvents,
  type BlockProps,
  type Disposer,
  type PageHandle,
  type PageRef,
  type Regions,
  type Replacements,
  type Settings,
  type View,
} from '@wikistow/plugin-sdk';
import type { OutputResult } from '@wikistow/plugin-sdk/protocol';
import type { ReadField } from './block-form';
import type { BlockProperties } from './block-properties';

/** Which of a plugin's code registered something: what goes wrong with it is said as that part's. */
export type Part = 'app' | 'script';

/**
 * What a plugin's handlers hear: app code's events, and its own settings
 * changing, which `host.settings.on('changed')` listens for.
 */
export type HostEvents = AppEvents & { 'settings.changed': Settings };

/** One event of type `E`, with its payload: `HostEvent` when `E` is every event. */
export type EventOf<E extends keyof HostEvents> = {
  [K in E]: { event: K; payload: HostEvents[K] };
}[E];

export type HostEvent = EventOf<keyof HostEvents>;

/** What a script's block shows for its source on a page: its fields as read, and its outputs or why they failed. */
export type BlockResults = {
  fields: Record<string, ReadField>;
  outputs: Record<string, OutputResult> | { error: string };
};

export type CommandEntry = {
  id: string;
  title: string;
  part: Part;
  run: (page: PageHandle) => Promise<void>;
};

export type BlockEntry = {
  type: string;
  part: Part;
  view: View<BlockProps>;
  /** A script's block: what it shows for `source` on `page`. Null for app code's. */
  results:
    | ((page: PageRef, source: string, properties: BlockProperties) => Promise<BlockResults>)
    | null;
};

/** Inline code app code draws, its view drawn as a block's. */
export type InlineEntry = { type: string; view: View<BlockProps> };

export type HandlerEntry<E extends keyof HostEvents> = {
  part: Part;
  run: (event: EventOf<E>) => Promise<void>;
};

type Handlers = { [E in keyof HostEvents]: Set<HandlerEntry<E>> };

/** A region's contributions, by their IDs. */
type Contributions = { [R in keyof Regions]: Map<string, Regions[R]> };

/**
 * A record with `make(region)` for every region in the SDK's table, which
 * must give `T`'s entry for that region.
 */
export function perRegion<T extends { [R in keyof Regions]: unknown }>(
  make: (region: keyof Regions) => unknown,
): T {
  // Unchecked: TypeScript can't type a record built from a list of names entry by entry, so
  // nothing checks that `make` gives each region the right kind of value.
  return Object.fromEntries(
    Object.keys(REGIONS)
      .filter(isRegion)
      .map((r) => [r, make(r)]),
  ) as T;
}

/** A record with `make(region)` for every region a plugin can replace, as `perRegion` makes one. */
export function perReplaceable<T extends { [R in keyof Replacements]: unknown }>(
  make: (region: keyof Replacements) => unknown,
): T {
  // Unchecked, as `perRegion` is.
  return Object.fromEntries(
    Object.keys(REGIONS)
      .filter(isReplaceable)
      .map((r) => [r, make(r)]),
  ) as T;
}

/**
 * Everything one activation of a plugin registered, from its app code and
 * its script alike: commands, blocks and inline code by ID, event
 * handlers, what it put in each region, and the one view it draws in place
 * of each region it replaces. Each entry runs itself, so whoever reads the
 * registry doesn't ask where an entry came from. `changed` is told of
 * every change.
 *
 * An ID registered again replaces the entry before it, whichever part
 * registered either; the replaced entry's disposer then does nothing.
 */
export function createRegistry(changed: () => void) {
  const commands = new Map<string, CommandEntry>();
  const blocks = new Map<string, BlockEntry>();
  const inline = new Map<string, InlineEntry>();
  const handlers: Handlers = {
    'page.shown': new Set(),
    'draft.saved': new Set(),
    'index.changed': new Set(),
    'location.changed': new Set(),
    'settings.changed': new Set(),
  };
  const regions = perRegion<Contributions>(() => new Map());
  // A plugin replaces each region with one view at a time.
  const replacements: { [R in keyof Replacements]?: Replacements[R] } = {};

  const keyed = <V>(map: Map<string, V>, key: string, value: V): Disposer => {
    map.set(key, value);
    changed();
    return () => {
      if (map.get(key) !== value) return;
      map.delete(key);
      changed();
    };
  };

  return {
    commands: (): Iterable<CommandEntry> => commands.values(),
    command: (id: string) => commands.get(id),
    blocks: (): Iterable<BlockEntry> => blocks.values(),
    inline: (): Iterable<InlineEntry> => inline.values(),
    /** What `region` holds, in the order it was registered. */
    region: <R extends keyof Regions>(region: R): Iterable<Regions[R]> => regions[region].values(),
    /** The view this plugin draws in place of `region`, if any. */
    replacement: <R extends keyof Replacements>(region: R): Replacements[R] | undefined =>
      replacements[region],
    /** Each handler of `event`, to run with it. */
    handlersOf: <E extends keyof HostEvents>(event: EventOf<E>) =>
      [...handlers[event.event]].map(({ part, run }) => ({ part, run: () => run(event) })),

    addCommand: (entry: CommandEntry) => keyed(commands, entry.id, entry),
    addBlock: (entry: BlockEntry) => keyed(blocks, entry.type, entry),
    addInline: (entry: InlineEntry) => keyed(inline, entry.type, entry),
    addHandler<E extends keyof HostEvents>(event: E, entry: HandlerEntry<E>): Disposer {
      const set: Handlers[E] = handlers[event];
      set.add(entry);
      // Handlers aren't shown anywhere, so nothing is told.
      return () => void set.delete(entry);
    },
    addContribution: <R extends keyof Regions>(region: R, contribution: Regions[R]) =>
      keyed(regions[region], contribution.id, contribution),
    addReplacement<R extends keyof Replacements>(
      region: R,
      replacement: Replacements[R],
    ): Disposer {
      replacements[region] = replacement;
      changed();
      return () => {
        if (replacements[region] !== replacement) return;
        delete replacements[region];
        changed();
      };
    },
  };
}

export type Registry = ReturnType<typeof createRegistry>;
