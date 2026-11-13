// Walking the folder tree as a server lists it.
import { inTreeOrder, type OrderedNode } from './positions.ts';

/**
 * The folder `rootId` and every folder under it, by the parent links in
 * `folders`: what moves with it, and so where it can't go (section 10).
 * Pages never hold anything, so a page moves alone.
 */
export function foldersUnder(
  folders: readonly { id: string; parentId: string | null }[],
  rootId: string,
): Set<string> {
  const under = new Set<string>([rootId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of folders) {
      if (f.parentId !== null && under.has(f.parentId) && !under.has(f.id)) {
        under.add(f.id);
        grew = true;
      }
    }
  }
  return under;
}

type Listed = { id: string; parentId: string | null; position: string | null };

/** A folder or page in its place in the tree, with the label it is listed by. */
export type TreeChild<F, P> =
  | { kind: 'folder'; node: F; label: string }
  | { kind: 'page'; node: P; label: string };

/** How a folder and a page are named where their names decide the order. */
export type TreeLabels<F, P> = { folder: (folder: F) => string; page: (page: P) => string };

/** A page's title as the tree shows it. */
export const shownTitle = (title: string | null) => (title?.trim() ? title : 'Untitled');

/**
 * The folders and pages directly under `parentId`, or at the top for null,
 * in the order every list shows them (`inTreeOrder`, #400): their folder's
 * own, or by name, folders first.
 */
export function childrenInOrder<F extends Listed, P extends Listed>(
  tree: { folders: readonly F[]; pages: readonly P[] },
  parentId: string | null,
  labels: TreeLabels<F, P>,
): TreeChild<F, P>[] {
  const children: (TreeChild<F, P> & OrderedNode)[] = [
    ...tree.folders
      .filter((folder) => folder.parentId === parentId)
      .map((node) => ({
        kind: 'folder' as const,
        node,
        id: node.id,
        position: node.position,
        label: labels.folder(node),
      })),
    ...tree.pages
      .filter((page) => page.parentId === parentId)
      .map((node) => ({
        kind: 'page' as const,
        node,
        id: node.id,
        position: node.position,
        label: labels.page(node),
      })),
  ];
  return inTreeOrder(children).map((child) =>
    child.kind === 'folder'
      ? { kind: 'folder', node: child.node, label: child.label }
      : { kind: 'page', node: child.node, label: child.label },
  );
}

/**
 * Every folder and page of `tree`, as the sidebar lists them with every
 * folder open: each folder followed by what is in it, each level in its
 * order (`childrenInOrder`). What can't be reached from the top, such as a
 * page in a folder the server left out, comes after, each group under its
 * missing folder in that folder's order.
 */
export function treeInOrder<F extends Listed, P extends Listed>(
  tree: { folders: readonly F[]; pages: readonly P[] },
  labels: TreeLabels<F, P>,
): TreeChild<F, P>[] {
  const out: TreeChild<F, P>[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null) => {
    for (const child of childrenInOrder(tree, parentId, labels)) {
      if (seen.has(child.node.id)) continue;
      seen.add(child.node.id);
      out.push(child);
      if (child.kind === 'folder') walk(child.node.id);
    }
  };
  walk(null);
  const parents = new Set(
    [...tree.folders, ...tree.pages].flatMap((node) =>
      seen.has(node.id) || node.parentId === null ? [] : [node.parentId],
    ),
  );
  for (const parentId of parents) walk(parentId);
  return out;
}
