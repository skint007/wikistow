import { foldersUnder } from '@wikistow/client';
import { shareCovering } from '../sharing/model';

/** What choosing where a page or folder goes needs to know of the tree. Pure, so it is table-tested. */
export type MoveTree<F extends string = string> = {
  /**
   * The caller's role in the space, and whether this app opened its own
   * name (false when it failed its checks; one in a newer format opened),
   * or null for someone who holds only folders.
   */
  space: { role: 'reader' | 'editor' | 'owner'; opened: boolean } | null;
  shares: readonly {
    shareId: string;
    rootId: string | null;
    role: 'reader' | 'editor' | 'owner';
  }[];
  folders: readonly { id: F; parentId: F | null; name: string | null }[];
};

/** A place a node can move to: a folder, or the top of the space for null, with its names from the top. */
export type Destination<F extends string = string> = { parentId: F | null; path: string[] };

/**
 * Where `node` can move (section 10), in path order: anywhere the caller
 * can edit, but not into itself or anything under it, nor where it is
 * already. Someone who isn't an owner moves only within the share it is
 * in. A share root, or a folder holding one, never goes into a share.
 * Folders whose name this app can't open aren't offered, nor is the top of
 * a space whose own name failed its checks: nothing can be written under it.
 */
export function moveDestinations<F extends string>(
  tree: MoveTree<F>,
  node: { id: string; kind: 'folder' | 'page'; parentId: F | null },
  { owner }: { owner: boolean },
): Destination<F>[] {
  // A page holds nothing; a folder goes with everything under it.
  const under = node.kind === 'folder' ? foldersUnder(tree.folders, node.id) : new Set<string>();
  const holdsShare = tree.shares.some((s) => s.rootId !== null && under.has(s.rootId));
  const at = (parentId: string | null) => shareCovering(tree, parentId);
  const here = at(node.kind === 'folder' ? node.id : node.parentId);
  const roleAt = (parentId: string | null) => at(parentId)?.role ?? tree.space?.role;
  const names = new Map(tree.folders.map((f) => [f.id, f] as const));
  const pathOf = (parentId: F | null) => {
    const path: string[] = [];
    for (let id = parentId; id !== null && path.length <= tree.folders.length;) {
      const folder = names.get(id);
      if (!folder) break;
      path.unshift(folder.name ?? 'Unreadable folder');
      id = folder.parentId;
    }
    return path;
  };
  const candidates: (F | null)[] = [
    ...(tree.space?.opened ? [null] : []),
    ...tree.folders.filter((f) => f.name !== null).map((f) => f.id),
  ];
  return candidates
    .filter((parentId) => {
      if (parentId === node.parentId || (parentId !== null && under.has(parentId))) return false;
      const role = roleAt(parentId);
      if (role !== 'editor' && role !== 'owner') return false;
      if (holdsShare && at(parentId) !== null) return false;
      return owner || (here !== null && at(parentId)?.shareId === here.shareId);
    })
    .map((parentId) => ({ parentId, path: pathOf(parentId) }))
    .sort((a, b) => a.path.join('\u0000').localeCompare(b.path.join('\u0000')));
}
