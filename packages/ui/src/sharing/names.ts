import type { spaceOperations } from '@wikistow/client';

export type Tree = Awaited<ReturnType<typeof spaceOperations.loadTree>>;

/** A space's or folder's decrypted name, or null when this app couldn't open it. */
export const nameOf = (
  metadata: spaceOperations.LoadedMetadata | null | undefined,
): string | null => (metadata?.opened.kind === 'current' ? metadata.opened.metadata.name : null);

/** What a share is called: its root folder's name, or the space's for a space share. */
export function shareName(tree: Tree | undefined, rootId: string | null): string {
  if (rootId === null) return nameOf(tree?.space?.metadata) ?? 'This space';
  return nameOf(tree?.folders.find((f) => f.id === rootId)?.metadata) ?? 'Unreadable folder';
}

/** What the share with this ID is called, from the shares the tree lists. */
export const shareNameById = (tree: Tree | undefined, shareId: string): string =>
  shareName(tree, tree?.shares.find((s) => s.shareId === shareId)?.rootId ?? null);
