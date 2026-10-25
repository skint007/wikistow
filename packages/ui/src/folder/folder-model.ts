import { findProperty, foldPropertyName, type RevisionId } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { errorMessage } from '../errors';
import { propertyLabel } from '../page/property-model';

// A folder's view of the pages directly in it (ADR 0006, decision 8): its
// columns, and what a cell's edit builds on and how it ended.

/** How a folder shows its pages. */
export type FolderLayout = 'list' | 'table';

/**
 * What the device keeps for a folder: its layout, if chosen, and the
 * columns hidden, each as its folded key's tag (`ColumnTag`), so no
 * property's name is stored in the clear.
 */
export type FolderChoice = { layout: FolderLayout | null; hidden: readonly string[] };

export const NO_CHOICE: FolderChoice = { layout: null, hidden: [] };

/** A folded key's tag on this device (`deviceTag`, in the app). */
export type ColumnTag = (folded: string) => string;

/** A property column: the key as first written in the folder, in sentence case. */
export type Column = { key: string; label: string; hidden: boolean };

/**
 * The table's property columns, after the title: `keys` as the index gives
 * them (each once, in the order first used), each hidden or not as kept.
 * Keys are hidden by folded name, so `Cook time` hides `cook_time` too.
 */
export function folderColumns(
  keys: readonly string[],
  hidden: readonly string[],
  tag: ColumnTag,
): Column[] {
  const off = new Set(hidden);
  return keys.map((key) => ({
    key,
    label: propertyLabel(key),
    hidden: off.has(tag(foldPropertyName(key))),
  }));
}

/** `choice` with the column `key` hidden, or shown again. */
export function withColumn(
  choice: FolderChoice,
  key: string,
  hide: boolean,
  tag: ColumnTag,
): FolderChoice {
  const tagged = tag(foldPropertyName(key));
  const rest = choice.hidden.filter((other) => other !== tagged);
  return { ...choice, hidden: hide ? [...rest, tagged] : rest };
}

/**
 * The key a cell of the column `column` sets on a page: the page's own
 * spelling of it when it has the property (`findProperty`), else the
 * column's, added at its block's end.
 */
export const cellKey = (properties: readonly { key: string }[], column: string) =>
  findProperty(properties, column)?.key ?? column;

/**
 * A page's draft as this view last wrote it, and the versions that write
 * stands in for: the one the index showed when this view first wrote, and
 * the view's own writes since, which an index built meanwhile may show.
 */
export type OwnWrite = {
  over: readonly RevisionId[];
  revisionId: RevisionId;
  markdown: string;
};

/**
 * The version a page's cells show and their edits build on: this view's
 * own last write while the index shows a version it stands in for, else
 * the index's (`indexed`). Once the index shows that write, or someone
 * else's, the index's is the one read.
 */
export const shownVersion = (indexed: RevisionId, own: OwnWrite | undefined) =>
  own?.over.includes(indexed)
    ? { revisionId: own.revisionId, markdown: own.markdown }
    : { revisionId: indexed, markdown: null };

/**
 * The own write after `written`, made on a cell that read the index's
 * `indexed`: one more in `previous`'s line while that still stands, else
 * the first over `indexed`.
 */
export const nextOwnWrite = (
  previous: OwnWrite | undefined,
  indexed: RevisionId,
  written: { revisionId: RevisionId; markdown: string },
): OwnWrite => ({
  over: previous?.over.includes(indexed) ? [...previous.over, previous.revisionId] : [indexed],
  ...written,
});

/** Why a cell's edit wasn't saved. */
export type CellProblem = { kind: 'conflict' } | { kind: 'failed'; message: string };

/**
 * What a cell shows for a save that failed: a conflict when the draft moved
 * on since the version the cell read (`stale-head`), as nothing was
 * overwritten, else why.
 */
export const cellProblem = (error: unknown): CellProblem =>
  error instanceof ApiError && error.code === 'stale-head'
    ? { kind: 'conflict' }
    : { kind: 'failed', message: errorMessage(error) };
