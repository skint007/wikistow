import { findProperty, foldPropertyName, type RevisionId } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { errorMessage } from '../errors';
import { propertyLabel } from '../page/property-model';

// A folder's view of the pages directly in it (ADR 0006, decision 8): its
// columns, and what a cell's edit builds on and how it ended.

/** How a folder shows its pages. */
export type FolderLayout = 'list' | 'table';

/** What the device keeps for a folder: its layout, if chosen, and the columns hidden, by folded key. */
export type FolderChoice = { layout: FolderLayout | null; hidden: readonly string[] };

export const NO_CHOICE: FolderChoice = { layout: null, hidden: [] };

/** A property column: the key as first written in the folder, in sentence case. */
export type Column = { key: string; label: string; hidden: boolean };

/**
 * The table's property columns, after the title: `keys` as the index gives
 * them (each once, in the order first used), each hidden or not as kept.
 * Keys are hidden by folded name, so `Cook time` hides `cook_time` too.
 */
export function folderColumns(keys: readonly string[], hidden: readonly string[]): Column[] {
  const off = new Set(hidden);
  return keys.map((key) => ({
    key,
    label: propertyLabel(key),
    hidden: off.has(foldPropertyName(key)),
  }));
}

/** `choice` with the column `key` hidden, or shown again. */
export function withColumn(choice: FolderChoice, key: string, hide: boolean): FolderChoice {
  const folded = foldPropertyName(key);
  const rest = choice.hidden.filter((other) => other !== folded);
  return { ...choice, hidden: hide ? [...rest, folded] : rest };
}

/**
 * The key a cell of the column `column` sets on a page: the page's own
 * spelling of it when it has the property (`findProperty`), else the
 * column's, added at its block's end.
 */
export const cellKey = (properties: readonly { key: string }[], column: string) =>
  findProperty(properties, column)?.key ?? column;

/**
 * A page's draft as this view last wrote it: the version the index showed
 * when it did (`indexed`), and the one it wrote on top. Until the index
 * shows something else, the view shows and builds on its own version.
 */
export type OwnWrite = { indexed: RevisionId; revisionId: RevisionId; markdown: string };

/**
 * The version a page's cells show and their edits build on: this view's
 * own write while the index still shows the version it was made from, else
 * the index's (`indexed`). Once the index moves on, to that write or to
 * someone else's, the index's is the one read.
 */
export const shownVersion = (indexed: RevisionId, own: OwnWrite | undefined) =>
  own && own.indexed === indexed
    ? { revisionId: own.revisionId, markdown: own.markdown }
    : { revisionId: indexed, markdown: null };

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
