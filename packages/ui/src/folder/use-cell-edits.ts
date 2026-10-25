import {
  foldPropertyName,
  pageOperations,
  setProperty,
  splitFrontmatter,
  type PageId,
  type PropertyValue,
  type RevisionId,
  type SpaceId,
} from '@wikistow/client';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { pageQuery, searchIndexChanged, treeQuery } from '../data/queries';
import { lineBreakOf } from '../page/editor/surface';
import { readWikilinks } from '../page/page-reader';
import { joinPage } from '../page/properties';
import { useClient } from '../vault/store';
import { cellProblem, nextOwnWrite, type CellProblem, type OwnWrite } from './folder-model';

/** A cell's edit: the page, the version it read and builds on, and the value set. */
export type CellEdit = {
  pageId: PageId;
  /** The version the index showed the cell, which an own write stands in for (`OwnWrite`). */
  indexed: RevisionId;
  /**
   * The version the cell read: the index's, or this view's own write on top
   * of it. An edit made while the page saves builds on that save instead.
   */
  basedOn: RevisionId;
  /** The Markdown the cell showed: that version's, with any edits here still saving. */
  markdown: string;
  /** The column, which a problem is shown on. */
  column: string;
  /** The key set, as the page writes it (`cellKey`). */
  key: string;
  value: PropertyValue;
};

/**
 * Saves a cell's value as its page's draft: `setDraftProperty`, reading
 * links as the editor does, unless a test stands in for the server.
 */
export type SaveProperty = (
  input: Omit<Parameters<typeof pageOperations.setDraftProperty>[1], 'read'>,
) => Promise<pageOperations.PropertySet>;

const cellId = (pageId: PageId, column: string) => `${pageId} ${foldPropertyName(column)}`;

function without<K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  const next = new Map(map);
  next.delete(key);
  return next;
}

/** How a save in a page's line ended: the version the next builds on, or null if it failed. */
type Settled = { basedOn: RevisionId } | null;

/**
 * Edits to a folder table's cells, each saved as that page's draft with the
 * value-only edit (`setDraftProperty`), against the version the cell read.
 * A page's edits are saved in turn, each on the one before, so cells on one
 * page can be edited one after another; while any saves, the page shows the
 * edits made here, and once saved, its own write until the index catches up
 * (`OwnWrite`). A conflict (the draft moved on) or a refusal stays on its
 * cell until the person dismisses it or edits the cell again; nothing is
 * overwritten. An edit waiting on one that fails isn't saved either.
 */
export function useCellEdits(spaceId: SpaceId, save?: SaveProperty) {
  const ctx = useClient();
  const setDraftProperty: SaveProperty =
    save ?? ((input) => pageOperations.setDraftProperty(ctx, { ...input, read: readWikilinks }));
  const queryClient = useQueryClient();
  const [own, setOwn] = useState<ReadonlyMap<PageId, OwnWrite>>(new Map());
  // Each page being saved, and its Markdown with every edit made to it here.
  const [saving, setSaving] = useState<ReadonlyMap<PageId, string>>(new Map());
  const [problems, setProblems] = useState<ReadonlyMap<string, CellProblem>>(new Map());
  // Each page's last save not yet done, which the next waits for.
  const lines = useRef(new Map<PageId, Promise<Settled>>());

  const dismiss = (pageId: PageId, column: string) =>
    setProblems((current) => without(current, cellId(pageId, column)));
  const fail = (id: string, problem: CellProblem): Settled => {
    setProblems((current) => new Map(current).set(id, problem));
    return null;
  };

  async function saveCell(cell: CellEdit, before: Promise<Settled> | undefined): Promise<Settled> {
    const id = cellId(cell.pageId, cell.column);
    let basedOn = cell.basedOn;
    if (before) {
      const settled = await before;
      if (!settled) {
        // What the earlier edit's cell says stays, if it was this cell: a conflict, say.
        setProblems((current) =>
          current.has(id)
            ? current
            : new Map(current).set(id, {
                kind: 'failed',
                message: 'An earlier change to this page wasn’t saved, so this one wasn’t either.',
              }),
        );
        return null;
      }
      basedOn = settled.basedOn;
    }
    try {
      const result = await setDraftProperty({
        page: { spaceId, pageId: cell.pageId },
        basedOn,
        key: cell.key,
        value: cell.value,
      });
      if (!result.ok) return fail(id, { kind: 'failed', message: result.reason });
      if (!result.written) return { basedOn };
      const { revisionId, payload } = result.written;
      setOwn((current) =>
        new Map(current).set(
          cell.pageId,
          nextOwnWrite(current.get(cell.pageId), cell.indexed, {
            revisionId,
            markdown: payload.markdown,
          }),
        ),
      );
      void queryClient.invalidateQueries({ queryKey: treeQuery(ctx, spaceId).queryKey });
      void queryClient.invalidateQueries({ queryKey: pageQuery(ctx, cell.pageId).queryKey });
      return { basedOn: revisionId };
    } catch (error) {
      return fail(id, cellProblem(error));
    }
  }

  function edit(cell: CellEdit) {
    const id = cellId(cell.pageId, cell.column);
    // Worked out here first, so the cell shows its new value while it saves.
    const { frontmatter, body } = splitFrontmatter(cell.markdown);
    const preview = setProperty(frontmatter, cell.key, cell.value, lineBreakOf(cell.markdown));
    if (!preview.ok) {
      fail(id, { kind: 'failed', message: preview.reason });
      return;
    }
    dismiss(cell.pageId, cell.column);
    if (preview.frontmatter === frontmatter) return;
    setSaving((current) => new Map(current).set(cell.pageId, joinPage(preview.frontmatter, body)));
    const line = lines.current;
    const run = saveCell(cell, line.get(cell.pageId));
    line.set(cell.pageId, run);
    void run.then(() => {
      if (line.get(cell.pageId) !== run) return;
      line.delete(cell.pageId);
      setSaving((current) => without(current, cell.pageId));
      // After a save or a conflict alike, the index reads the draft as it is now.
      searchIndexChanged(queryClient);
    });
  }

  return {
    own,
    saving,
    problem: (pageId: PageId, column: string) => problems.get(cellId(pageId, column)),
    dismiss,
    edit,
  };
}

export type CellEdits = ReturnType<typeof useCellEdits>;
