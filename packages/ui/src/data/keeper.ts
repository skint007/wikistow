import {
  keptOperations,
  type ClientContext,
  type pageOperations,
  type SpaceId,
} from '@wikistow/client';
import { useSyncExternalStore } from 'react';
import { desktop } from '../desktop';
import { deviceSwitch, type DeviceSwitch } from '../shell/device-switch';
import { keptStore } from './kept-store';

/**
 * **Keep for offline** (ADR 0009, decision 1): on for **Every page**, off
 * for **Pages I open**. The desktop app starts on Every page, a browser on
 * Pages I open. A desktop app without a trusted keyring keeps only the
 * pages it opens, in memory, whatever this says. Made when first asked
 * for, as it reads the page's storage.
 */
export const keepEveryPage = (): DeviceSwitch =>
  (setting ??= deviceSwitch('wikistow.keepEveryPage', desktop !== null));
let setting: DeviceSwitch | null = null;

/** How the keeper is getting on, for Settings: its progress while it runs, and how many runs ended. */
type Keeping = { progress: keptOperations.KeepProgress | null; runs: number };

let keeping: Keeping = { progress: null, runs: 0 };
const listeners = new Set<() => void>();
function report(next: Partial<Keeping>) {
  keeping = { ...keeping, ...next };
  for (const listener of listeners) listener();
}

/** The keeper's progress while it runs, and a count of runs ended, to read usage again. */
export const useKeeping = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => keeping,
  );

/** For each session: what changed since the keeper last ran, and whether it runs. */
type Following = {
  spaces: Set<SpaceId> | 'all' | null;
  opened: pageOperations.PageRef[];
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
};
const following = new WeakMap<ClientContext, Following>();

/** How long changes gather before the keeper follows them together. */
const GATHER_MS = 300;

/**
 * Keep pages current after a change (ADR 0009, decision 3): every space,
 * as after unlocking, coming back into view or a change of access, or only
 * `spaces` the server says changed. Changes in the next `GATHER_MS`, and
 * those while it runs, go in one run after. Does nothing for a session
 * that keeps nothing (`keptContent`).
 */
export function keepChanged(ctx: ClientContext, change?: { spaces: readonly SpaceId[] }) {
  note(ctx, change ? change.spaces : 'all', []);
}

/**
 * The page `page` opened in the reader or the draft view: kept from now on
 * with **Pages I open**, and marked as opened on the device with Every page.
 */
export function pageOpened(ctx: ClientContext, page: pageOperations.PageRef) {
  const kept = ctx.keptContent;
  const before = kept?.page(page.spaceId, page.pageId);
  if (!kept || before?.opened) return;
  const ref = { spaceId: page.spaceId, pageId: page.pageId };
  // A page kept already only needs marking; a page not kept is listed.
  void (before ? kept.markOpened(ref) : Promise.resolve(false))
    .then((marked) => {
      if (!marked) note(ctx, [], [ref]);
    })
    .catch(() => {});
}

function note(
  ctx: ClientContext,
  spaces: readonly SpaceId[] | 'all',
  opened: pageOperations.PageRef[],
) {
  if (!ctx.keptContent || ctx.keptContent.closed) return;
  let state = following.get(ctx);
  if (!state) {
    state = { spaces: null, opened: [], timer: null, running: false };
    following.set(ctx, state);
  }
  if (spaces === 'all' || state.spaces === 'all') state.spaces = 'all';
  else if (spaces.length > 0 || opened.length > 0) {
    state.spaces = new Set([...(state.spaces ?? []), ...spaces]);
  }
  state.opened.push(...opened);
  if (state.running) return;
  const waiting = state;
  waiting.timer ??= setTimeout(() => {
    waiting.timer = null;
    void run(ctx, waiting);
  }, GATHER_MS);
}

async function run(ctx: ClientContext, state: Following) {
  const { onDisk } = await keptStore();
  state.running = true;
  try {
    while (state.spaces !== null) {
      const spaces = state.spaces === 'all' ? 'all' : [...state.spaces];
      const opened = state.opened;
      state.spaces = null;
      state.opened = [];
      // Without a keyring, only what this launch opens is kept.
      const scope = onDisk && keepEveryPage().get() ? 'every' : 'opened';
      try {
        await keptOperations.keep(ctx, {
          scope,
          spaces,
          opened,
          onProgress: (progress) => report({ progress }),
        });
      } catch {
        // Locked: nothing more to keep for this session. Access changed:
        // `refreshAccess` noted every space, which the next turn keeps.
        // Anything else, as no answer, waits for the next change, which
        // keeps the pages just opened too.
        if (ctx.keptContent?.closed) return;
        state.opened.push(...opened);
      }
    }
  } finally {
    state.running = false;
    report({ progress: null, runs: keeping.runs + 1 });
  }
}
