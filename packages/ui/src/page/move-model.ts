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
  return placesWhere(tree, (parentId) => {
    if (parentId === node.parentId || (parentId !== null && under.has(parentId))) return false;
    const role = roleAt(parentId);
    if (role !== 'editor' && role !== 'owner') return false;
    if (holdsShare && at(parentId) !== null) return false;
    return owner || (here !== null && at(parentId)?.shareId === here.shareId);
  });
}

/**
 * Where a copy, or a move from another space, can go in `tree` (ADR 0007),
 * in path order: anywhere the caller can make pages, by the share that
 * covers it, or by their role in the space outside shares. Nothing in
 * `inside`, what is copied when it is in this space, is offered: nothing
 * copies into itself. Its own folder is: a copy can go beside it.
 */
export function copyDestinations<F extends string>(
  tree: MoveTree<F>,
  inside: ReadonlySet<string> = new Set(),
): Destination<F>[] {
  return placesWhere(tree, (parentId) => {
    if (parentId !== null && inside.has(parentId)) return false;
    const role = (shareCovering(tree, parentId) ?? tree.space)?.role;
    return role === 'editor' || role === 'owner';
  });
}

// The top of the space and every folder whose name this app opened, that
// `allowed` lets through, with their names from the top, in path order.
function placesWhere<F extends string>(
  tree: MoveTree<F>,
  allowed: (parentId: F | null) => boolean,
): Destination<F>[] {
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
    .filter(allowed)
    .map((parentId) => ({ parentId, path: pathOf(parentId) }))
    .sort((a, b) => a.path.join('\u0000').localeCompare(b.path.join('\u0000')));
}

/** A space a copy or move can go to, by the name the person sees. */
export type CopySpace<S extends string = string> = {
  spaceId: S;
  name: string;
  /** Held only through a folder shared with the person. */
  folderOnly: boolean;
};

type Role = 'reader' | 'editor' | 'owner';

/**
 * The spaces to offer a copy or move from `sourceSpaceId`: that space
 * first, whatever the person's role (where in it they can make pages is the
 * folder picker's to say), then every other space where they can make
 * pages, by name: those they hold whole by their own names, then those
 * they hold only folders of by the shared folder's name. Each once.
 */
export function copySpaces<S extends string>(
  {
    spaces,
    shared,
  }: {
    spaces: readonly { id: S; name: string | null; role: Role }[];
    shared: readonly { spaceId: S; rootName: string | null; role: Role }[];
  },
  sourceSpaceId: S,
): CopySpace<S>[] {
  const out = new Map<S, CopySpace<S>>();
  for (const space of spaces) {
    if (space.name === null || (space.role === 'reader' && space.id !== sourceSpaceId)) continue;
    out.set(space.id, { spaceId: space.id, name: space.name, folderOnly: false });
  }
  for (const item of shared) {
    if (item.rootName === null || out.has(item.spaceId)) continue;
    if (item.role === 'reader' && item.spaceId !== sourceSpaceId) continue;
    out.set(item.spaceId, { spaceId: item.spaceId, name: item.rootName, folderOnly: true });
  }
  const source = out.get(sourceSpaceId) ?? {
    spaceId: sourceSpaceId,
    name: 'This space',
    folderOnly: false,
  };
  out.delete(sourceSpaceId);
  return [source, ...[...out.values()].sort((a, b) => a.name.localeCompare(b.name))];
}
