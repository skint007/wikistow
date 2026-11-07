import type { AppLocation, Destination, PageRef, PluginEvents } from '@wikistow/plugin-sdk';
import { PluginError } from '@wikistow/plugin-sdk';

/** The version of a page shown where its route draws it, as `page.shown` tells of it. */
export type PageShown = PluginEvents['page.shown'];

/** Where `navigate` goes: a plugin's destination, with its own plugin's ID for a plugin page. */
export type Place =
  | Exclude<Destination, { kind: 'plugin' }>
  | { kind: 'plugin'; pluginId: string; viewId: string };

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
  let navigator: ((to: Place) => Promise<void>) | null = null;
  const listeners = new Set<() => void>();

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
      return () => {
        if (showing !== owner) return;
        showing = null;
        shown = null;
        update();
      };
    },
    /** Navigate with `go` until the returned function runs. */
    navigateWith(go: (to: Place) => Promise<void>) {
      navigator = go;
      return () => {
        if (navigator === go) navigator = null;
      };
    },
    navigate(to: Place): Promise<void> {
      if (!navigator) return Promise.reject(new PluginError('unsupported', 'Nowhere to go here'));
      return navigator(to);
    },
  };
}

export type PluginLocation = ReturnType<typeof createLocation>;
