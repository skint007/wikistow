import type { ReadingChange } from '@wikistow/client';

// What the reading view keeps of publications made from changes made while
// reading, by this tab's flushes or by the queue's sender (#695): with no
// imports of the app's own, so what follows the queue can tell it too.

// Each page's publications its flushes made, by the one each replaced:
// kept for the page, not the queue, as one left behind may publish while
// the person is back on the page with another.
const replaced = new Map<string, Map<string, string>>();

/** A flush of `pageId` published `revision` in place of `before`, the publication the person was reading. */
export function notePublished(pageId: string, revision: string, before: string | null) {
  if (before === null) return;
  let page = replaced.get(pageId);
  if (!page) replaced.set(pageId, (page = new Map()));
  page.set(revision, before);
}

/**
 * The publication the person was reading when flushes of `pageId`
 * replaced it, one after another, with `revision`; `revision` itself if
 * none made it. The page keeps one view for them all, so reading goes on
 * where it was.
 */
export function originOf(pageId: string, revision: string): string {
  const page = replaced.get(pageId);
  let origin = revision;
  for (let before = page?.get(origin); before; before = page?.get(origin)) origin = before;
  return origin;
}

// What the queue's sender published of changes made while reading, by
// page, until the page shows that publication: their entry goes first, so
// the page shows them over the one before meanwhile, rather than unticked.
const sent = new Map<string, { revision: string; changes: readonly ReadingChange[]; at: number }>();

// How long the page waits to show the publication, at most, before it shows what it has.
const SHOWN_WITHIN_MS = 30_000;

/** The queue's sender published `changes` of `pageId` as `revision`, in place of `before`. */
export function noteTicksPublished(
  pageId: string,
  revision: string,
  before: string | null,
  changes: readonly ReadingChange[],
) {
  notePublished(pageId, revision, before);
  sent.set(pageId, { revision, changes, at: Date.now() });
}

/**
 * The changes the queue's sender published of `pageId` that the page
 * doesn't show yet, while it shows the publication `shown`; forgotten once
 * it shows the one they made or one after it, or after `SHOWN_WITHIN_MS`.
 */
export function ticksNotShown(pageId: string, shown: string | null): readonly ReadingChange[] {
  const now = sent.get(pageId);
  if (!now) return [];
  const after = shown !== null && originOf(pageId, shown) !== shown;
  if (shown === now.revision || after || Date.now() - now.at > SHOWN_WITHIN_MS) {
    sent.delete(pageId);
    return [];
  }
  return now.changes;
}
