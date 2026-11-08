import { createContext, use, useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import type { PaletteEntry } from './palette';

type Offer = { entries: () => readonly PaletteEntry[]; shownBy: (() => Element | null) | null };

/** The commands offered to the palette now, by what is mounted (`usePaletteEntries`). */
export class PaletteOffers {
  #offers = new Set<Offer>();
  #listeners = new Set<() => void>();
  // Counts offers coming and going, for an open palette to list them again.
  #version = 0;

  add(offer: Offer): () => void {
    this.#offers.add(offer);
    this.#changed();
    return () => {
      this.#offers.delete(offer);
      this.#changed();
    };
  }

  #changed() {
    this.#version++;
    for (const listener of this.#listeners) listener();
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  version = () => this.#version;

  /** Every entry offered by what is shown. */
  list(): PaletteEntry[] {
    return [...this.#offers]
      .filter(({ shownBy }) => {
        if (!shownBy) return true;
        const element = shownBy();
        return element !== null && element.checkVisibility();
      })
      .flatMap(({ entries }) => entries());
  }
}

const OffersContext = createContext<PaletteOffers | null>(null);

/** Where `usePaletteEntries` offers commands, and the palette finds them. */
export const PaletteOffersProvider = OffersContext;

const unsubscribed = () => () => {};
const none = () => 0;

/** What the palette lists now: the entries offered, listed again as offers come and go. */
export function usePaletteList(): PaletteEntry[] {
  const offers = use(OffersContext);
  useSyncExternalStore(offers?.subscribe ?? unsubscribed, offers?.version ?? none);
  return offers?.list() ?? [];
}

/**
 * Offer `entries` to the palette while the caller is mounted, as they are at
 * its latest render. With `shownBy`, only while that element is shown: the
 * wide layout's sidebar stays mounted, hidden, on phones.
 */
export function usePaletteEntries(
  entries: readonly PaletteEntry[],
  shownBy?: RefObject<Element | null>,
) {
  const offers = use(OffersContext);
  const latest = useRef(entries);
  useEffect(() => {
    latest.current = entries;
  });
  useEffect(
    () =>
      offers?.add({
        entries: () => latest.current,
        shownBy: shownBy ? () => shownBy.current : null,
      }),
    [offers, shownBy],
  );
}
