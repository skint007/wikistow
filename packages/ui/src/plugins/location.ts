import type { HistoryState } from '@tanstack/react-router';
import type { AppLocation, Destination, PageRef, PluginEvents } from '@wikistow/plugin-sdk';
import { PluginError } from '@wikistow/plugin-sdk';

/** The version of a page shown where its route draws it, as `page.shown` tells of it. */
export type PageShown = PluginEvents['page.shown'];

/** Where `navigate` goes: a plugin's destination, with its own plugin's ID for a plugin page or its settings. */
export type Place =
  | Exclude<Destination, { kind: 'plugin' | 'settings' }>
  | { kind: 'plugin'; pluginId: string; viewId: string }
  | { kind: 'settings'; pluginId: string };

/** Goes to a place, with the history state for the entry it makes. */
type Navigator = (to: Place, state: HistoryState) => Promise<void>;
/** Told of a move before it goes, giving any history state for it. */
type Going = (to: Place) => HistoryState | void;

const OTHER: AppLocation = { kind: 'other' };

const sameShown = (a: PageShown | null, b: PageShown | null) =>
  a?.page.spaceId === b?.page.spaceId &&
  a?.page.pageId === b?.page.pageId &&
  a?.version === b?.version &&
  a?.revision === b?.revision;

const samePage = (a: PageRef, b: PageRef) => a.spaceId === b.spaceId && a.pageId === b.pageId;

/**
 * Where the person is, as a runtime's plugins see it (`host.app`): the
 * place the app's router is at (`routed`), with the version a page's
 * route shows there once it has opened (`showing`), and the way to
 * navigate. The app feeds one from its router and page route; the
 * workshop's preview one from its sample pages.
 */
export function createLocation() {
  let routed: AppLocation = OTHER;
  let shown: PageShown | null = null;
  /** Who shows it: only their own end clears it. */
  let showing: object | null = null;
  let location: AppLocation = OTHER;
  let navigator: Navigator | null = null;
  const listeners = new Set<() => void>();
  const goers = new Set<Going>();

  const update = () => {
    location =
      routed.kind === 'page' && shown && samePage(routed, shown.page)
        ? { ...routed, version: shown.version }
        : routed;
    for (const listener of listeners) listener();
  };

  return {
    get: () => location,
    /** The page shown, with its version and revision, or null while none is: a new object only for another. */
    shown: () => shown,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** The router is at `next`. */
    routed(next: AppLocation) {
      if (JSON.stringify(next) === JSON.stringify(routed)) return;
      routed = next;
      update();
    },
    /** A page's route shows `page`, until the returned function runs. */
    showing(page: PageShown) {
      // The same version shown again keeps its object, so it's told once.
      const owner = {};
      showing = owner;
      if (!sameShown(shown, page)) {
        shown = page;
        update();
      }
      // Cleared after the moment, so a route that shows another version
      // (ending one effect, then starting the next) doesn't seem to close.
      return () =>
        queueMicrotask(() => {
          if (showing !== owner) return;
          showing = null;
          shown = null;
          update();
        });
    },
    /** Navigate with `go` until the returned function runs, with the history state `onNavigate`'s listeners gave. */
    navigateWith(go: Navigator) {
      navigator = go;
      return () => {
        if (navigator === go) navigator = null;
      };
    },
    navigate(to: Place): Promise<void> {
      if (!navigator) return Promise.reject(new PluginError('unsupported', 'Nowhere to go here'));
      const state: HistoryState = {};
      for (const going of goers) Object.assign(state, going(to));
      return navigator(to, state);
    },
    /**
     * Call `going` as a plugin navigates, before it goes, even to where the
     * person is already, such as to close search, whose results it drew.
     * What it returns goes in the history entry the move makes, as the
     * drawer's mark of a space opened from its rail (#697).
     */
    onNavigate(going: Going) {
      goers.add(going);
      return () => void goers.delete(going);
    },
  };
}

export type PluginLocation = ReturnType<typeof createLocation>;
