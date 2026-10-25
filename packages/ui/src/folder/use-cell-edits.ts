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
import { useState } from 'react';
import { pageQuery, searchIndexChanged, treeQuery } from '../data/queries';
import { lineBreakOf } from '../page/editor/surface';
import { readWikilinks } from '../page/page-reader';
import { joinPage } from '../page/properties';
import { useClient } from '../vault/store';
import { cellProblem, type CellProblem, type OwnWrite } from './folder-model';

/** A cell's edit: the page, the version it read and builds on, and the value set. */
export type CellEdit = {
  pageId: PageId;
  /** The version the index shows, which `OwnWrite.indexed` keeps. */
  indexed: RevisionId;
  /** The version the cell read: the index's, or this view's own write on top of it. */
  basedOn: RevisionId;
  /** That version's Markdown. */
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

/**
 * Edits to a folder table's cells, each saved as that page's draft with the
 * value-only edit (`setDraftProperty`), against the version the cell read,
 * one save per page at a time. While it saves, the page shows the edit made
 * here; once saved, its own write until the index catches up (`OwnWrite`).
 * A conflict (the draft moved on) or a refusal stays on its cell until the
 * person dismisses it or edits the cell again; nothing is overwritten.
 */
export function useCellEdits(spaceId: SpaceId, save?: SaveProperty) {
  const ctx = useClient();
  const setDraftProperty: SaveProperty =
    save ?? ((input) => pageOperations.setDraftProperty(ctx, { ...input, read: readWikilinks }));
  const queryClient = useQueryClient();
  const [own, setOwn] = useState<ReadonlyMap<PageId, OwnWrite>>(new Map());
  // Each page being saved, and its Markdown as the edit makes it.
  const [saving, setSaving] = useState<ReadonlyMap<PageId, string>>(new Map());
  const [problems, setProblems] = useState<ReadonlyMap<string, CellProblem>>(new Map());

  const dismiss = (pageId: PageId, column: string) =>
    setProblems((current) => without(current, cellId(pageId, column)));

  async function edit(cell: CellEdit) {
    const id = cellId(cell.pageId, cell.column);
    const page = { spaceId, pageId: cell.pageId };
    // Worked out here first, so the cell shows its new value while it saves.
    const { frontmatter, body } = splitFrontmatter(cell.markdown);
    const preview = setProperty(frontmatter, cell.key, cell.value, lineBreakOf(cell.markdown));
    if (!preview.ok) {
      setProblems((current) =>
        new Map(current).set(id, { kind: 'failed', message: preview.reason }),
      );
      return;
    }
    dismiss(cell.pageId, cell.column);
    if (preview.frontmatter === frontmatter) return;
    setSaving((current) => new Map(current).set(cell.pageId, joinPage(preview.frontmatter, body)));
    try {
      const result = await setDraftProperty({
        page,
        basedOn: cell.basedOn,
        key: cell.key,
        value: cell.value,
      });
      if (!result.ok) {
        setProblems((current) =>
          new Map(current).set(id, { kind: 'failed', message: result.reason }),
        );
      } else if (result.written) {
        const { revisionId, payload } = result.written;
        setOwn((current) =>
          new Map(current).set(cell.pageId, {
            indexed: cell.indexed,
            revisionId,
            markdown: payload.markdown,
          }),
        );
        void queryClient.invalidateQueries({ queryKey: treeQuery(ctx, spaceId).queryKey });
        void queryClient.invalidateQueries({ queryKey: pageQuery(ctx, cell.pageId).queryKey });
      }
    } catch (error) {
      setProblems((current) => new Map(current).set(id, cellProblem(error)));
    } finally {
      setSaving((current) => without(current, cell.pageId));
      // After a save or a conflict alike, the index reads the draft as it is now.
      searchIndexChanged(queryClient);
    }
  }

  return {
    own,
    saving,
    problem: (pageId: PageId, column: string) => problems.get(cellId(pageId, column)),
    dismiss,
    edit: (cell: CellEdit) => void edit(cell),
  };
}

export type CellEdits = ReturnType<typeof useCellEdits>;
