import type { Marked } from '@wikistow/client';
import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import type { Requirement } from './command';

/**
 * A command the palette offers where it is: what the button or menu item
 * that runs it shows and does. Whoever draws that control offers it too,
 * while it is shown (`usePaletteEntries`).
 */
export type PaletteEntry = {
  /** The command it runs: its ID names the row, and its `requires` say whether it's listed. */
  command: { id: string; requires: readonly Requirement[] };
  /** What holds where it is offered. */
  satisfies: (requirement: Requirement) => boolean;
  title: string;
  /** Its key, as ProseMirror names one (`Mod-f`). */
  keys?: string;
  /** The plugin's name, for a plugin's command. */
  plugin?: string;
  /** Why it can't run now, as its control's hint says. It is listed, dimmed. */
  waiting?: string | null;
  /** What its control does. */
  run: () => void;
};

/** A row of the palette: its entry, and its title with what the query matched marked. */
export type PaletteRow = { entry: PaletteEntry; title: Marked };

/**
 * Where `query`'s letters are in `title`, in order, ignoring case and the
 * query's spaces, placed for the best score: more for letters that start a
 * word or follow the one before, less for gaps. Null when they aren't all
 * there.
 */
export function fuzzyMatch(
  query: string,
  title: string,
): { score: number; highlights: Marked['highlights'] } | null {
  const wanted = query.replace(/\s+/g, '').toLowerCase();
  const text = title.toLowerCase();
  if (wanted === '') return { score: 0, highlights: [] };
  const startsWord = (i: number) => i === 0 || !/[\p{L}\p{N}]/u.test(text[i - 1] ?? '');
  const NONE = -Infinity;
  // `scores[j]`: the best score with the letter so far at `j`; `backs[n][j]`
  // where the letter before it is then. A gap costs its length, up to 3.
  let scores: number[] = [];
  const backs: number[][] = [];
  for (let n = 0; n < wanted.length; n++) {
    const next: number[] = Array.from(text, () => NONE);
    const back: number[] = Array.from(text, () => -1);
    // The best of those at least four letters back, which all cost 3.
    let far = NONE;
    let farAt = -1;
    for (let j = 0; j < text.length; j++) {
      const reach = scores[j - 4] ?? NONE;
      if (reach > far) [far, farAt] = [reach, j - 4];
      if (text[j] !== wanted[n]) continue;
      const own = startsWord(j) ? 3 : 0;
      if (n === 0) {
        next[j] = own;
        continue;
      }
      let best = far - 3;
      let at = farAt;
      for (const [k, cost] of [
        [j - 1, -2],
        [j - 2, 1],
        [j - 3, 2],
      ] as const) {
        const score = (scores[k] ?? NONE) - cost;
        if (score > best) [best, at] = [score, k];
      }
      if (best === NONE) continue;
      next[j] = best + own;
      back[j] = at;
    }
    scores = next;
    backs.push(back);
  }
  let score = NONE;
  let last = -1;
  scores.forEach((each, j) => {
    if (each > score) [score, last] = [each, j];
  });
  if (last === -1) return null;
  const at: number[] = [];
  for (let n = wanted.length - 1, j = last; n >= 0; n--) {
    at.unshift(j);
    j = backs[n]?.[j] ?? -1;
  }
  // Letters next to each other are marked as one run.
  const highlights: Marked['highlights'] = [];
  for (const i of at) {
    const run = highlights.at(-1);
    if (run && run.end === i) run.end = i + 1;
    else highlights.push({ start: i, end: i + 1 });
  }
  return { score, highlights };
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

/**
 * What the palette lists for `query`: each command whose requirements hold
 * where it is offered, once, that matches. Those in `recent` come first, the
 * latest first, then the best matches, then by title.
 */
export function paletteRows(
  entries: readonly PaletteEntry[],
  query: string,
  recent: readonly string[],
): PaletteRow[] {
  const seen = new Set<string>();
  const rows: (PaletteRow & { score: number; used: number })[] = [];
  for (const entry of entries) {
    const { id, requires } = entry.command;
    if (seen.has(id) || !requires.every(entry.satisfies)) continue;
    seen.add(id);
    const match = fuzzyMatch(query, entry.title);
    if (!match) continue;
    const used = recent.indexOf(id);
    rows.push({
      entry,
      title: { text: entry.title, highlights: match.highlights },
      score: match.score,
      used: used === -1 ? Infinity : used,
    });
  }
  return rows
    .sort(
      (a, b) =>
        a.used - b.used || b.score - a.score || collator.compare(a.entry.title, b.entry.title),
    )
    .map(({ entry, title }) => ({ entry, title }));
}

/**
 * The palette's shortcut: Ctrl+Shift+P (Cmd+Shift+P on Apple systems), as
 * in VS Code, or F1, for Firefox, which keeps Ctrl+Shift+P for a private
 * window and never hands it to the page.
 */
export const isPaletteKey = (
  // Autofill sends keydown events with no key at all.
  event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'> & {
    key?: string | undefined;
  },
  apple: boolean,
) =>
  event.key === 'F1'
    ? !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
    : event.key?.toLowerCase() === 'p' &&
      (apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
      event.shiftKey &&
      // Ctrl+Shift+Alt+P is safe mode's.
      !event.altKey;

const RECENT_KEY = 'wikistow.recentCommands';
const KEPT = 20;
const Recent = z.array(z.string()).catch([]);

function readRecent(): string[] {
  try {
    return Recent.parse(JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

let recent = readRecent();
const listeners = new Set<() => void>();

/** The commands run from the palette on this device, the latest first, by ID. */
export const recentCommands = {
  get: () => recent,
  /** Put `id` first. */
  used: (id: string) => {
    recent = [id, ...recent.filter((kept) => kept !== id)].slice(0, KEPT);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {
      // Not kept past this run.
    }
    for (const listener of listeners) listener();
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};

export const useRecentCommands = () =>
  useSyncExternalStore(recentCommands.subscribe, recentCommands.get);
