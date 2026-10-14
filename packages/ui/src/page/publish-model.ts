import { shareCovering } from '../sharing/model';

/** What choosing where a copy goes needs to know of a space's tree. Pure, so it is table-tested. */
export type PublishTree<F extends string = string> = {
  /**
   * The caller's standing in the space, and whether this app opened its
   * own name (false when it failed its checks; one in a newer format
   * opened), or null for someone who holds only folders.
   */
  space: { role: 'reader' | 'editor' | 'owner'; canPublish: boolean; opened: boolean } | null;
  shares: readonly {
    shareId: string;
    rootId: string | null;
    role: 'reader' | 'editor' | 'owner';
    canPublish: boolean;
  }[];
  folders: readonly { id: F; parentId: F | null; name: string | null }[];
};

/** A place a copy can go: a folder, or the top of the space for null, with its names from the top. */
export type PublishPlace<F extends string = string> = { parentId: F | null; path: string[] };

/**
 * Where in a space the caller can publish a copy (section 13), in path
 * order: wherever they can edit and publish, by the share that covers it,
 * or by their standing in the space outside shares. Folders whose name
 * this app can't open aren't offered, nor is the top of a space whose own
 * name failed its checks: nothing can be written at its top.
 */
export function publishPlaces<F extends string>(tree: PublishTree<F>): PublishPlace<F>[] {
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
  const publishesAt = (parentId: F | null) => {
    const standing = shareCovering(tree, parentId) ?? tree.space;
    return standing !== null && standing.role !== 'reader' && standing.canPublish;
  };
  const candidates: (F | null)[] = [
    ...(tree.space?.opened ? [null] : []),
    ...tree.folders.filter((f) => f.name !== null).map((f) => f.id),
  ];
  return candidates
    .filter(publishesAt)
    .map((parentId) => ({ parentId, path: pathOf(parentId) }))
    .sort((a, b) => a.path.join('\u0000').localeCompare(b.path.join('\u0000')));
}

/** A space a copy can go to, by the name the person sees. */
export type PublishSpace<S extends string = string> = {
  spaceId: S;
  name: string;
  folderOnly: boolean;
};

/**
 * The spaces to offer, besides the source's own: those the person owns or
 * holds whole, by their names, then those they hold only folders of, by the
 * shared folder's name. Each once, in name order.
 */
export function publishSpaces<S extends string>(
  {
    spaces,
    shared,
  }: {
    spaces: readonly { id: S; name: string | null }[];
    shared: readonly { spaceId: S; rootName: string | null }[];
  },
  sourceSpaceId: string,
): PublishSpace<S>[] {
  const out = new Map<S, PublishSpace<S>>();
  for (const space of spaces) {
    if (space.id === sourceSpaceId || space.name === null) continue;
    out.set(space.id, { spaceId: space.id, name: space.name, folderOnly: false });
  }
  for (const item of shared) {
    if (item.spaceId === sourceSpaceId || item.rootName === null || out.has(item.spaceId)) continue;
    out.set(item.spaceId, { spaceId: item.spaceId, name: item.rootName, folderOnly: true });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
