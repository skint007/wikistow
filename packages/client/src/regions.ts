import type { ShareId, SpaceId } from '@wikistow/contracts';
import { CryptoError } from './errors.ts';

/**
 * What protects a record's content key (section 6.1): one share's folder
 * keys, or the space's owner region, where it is sealed to each owner. A
 * share is named by its space too, never by `shareId` alone (section 6.2).
 */
export type Region = { kind: 'owner' } | { kind: 'share'; spaceId: SpaceId; shareId: ShareId };

export const OWNER_REGION: Region = { kind: 'owner' };

export const sameRegion = (a: Region, b: Region): boolean =>
  a.kind === 'owner'
    ? b.kind === 'owner'
    : b.kind === 'share' && a.spaceId === b.spaceId && a.shareId === b.shareId;

const describe = (region: Region) =>
  region.kind === 'owner' ? 'the owner region' : `share ${region.shareId}`;

/**
 * Where the server's tree and shares put a node, or the space's name: the
 * share rooted at the node or its nearest ancestor that is a share root,
 * else the space share if there is one, else the owner region. For a node
 * not yet created, pass its parent; for one at the top of the space, the
 * space. The tree is the server's word, so a client only ever compares this
 * with the region its records give (`requireRegion`), and never writes by it.
 */
export function regionInTree({
  subject,
  parentOf,
  shares,
}: {
  subject: { kind: 'space' } | { kind: 'node'; nodeId: string };
  /** A node's parent, `null` at the top of the space, `undefined` for a node not in the tree. */
  parentOf: (nodeId: string) => string | null | undefined;
  /** The space's shares: a `Share`'s `spaceId`, `shareId` and `rootId` are enough. */
  shares: readonly { spaceId: SpaceId; shareId: ShareId; rootId: string | null }[];
}): Region {
  const rootedAt = (rootId: string | null) => shares.find((share) => share.rootId === rootId);
  const visited = new Set<string>();
  let node = subject.kind === 'node' ? subject.nodeId : null;
  while (node !== null) {
    if (visited.has(node)) throw new CryptoError('malformed', 'The tree has a cycle');
    visited.add(node);
    const share = rootedAt(node);
    if (share) return { kind: 'share', spaceId: share.spaceId, shareId: share.shareId };
    const parent = parentOf(node);
    if (parent === undefined) throw new CryptoError('malformed', `The tree has no node ${node}`);
    node = parent;
  }
  const spaceShare = rootedAt(null);
  return spaceShare
    ? { kind: 'share', spaceId: spaceShare.spaceId, shareId: spaceShare.shareId }
    : OWNER_REGION;
}

/**
 * The region a write lands in, from records this app opened, never from the
 * tree (sections 6.1 and 6.8):
 * - a new page or folder: the region of its parent's own name record, that
 *   is the current metadata of the parent folder, or of the space at the top;
 * - a write based on a record: that record's region;
 * - a write with `basedOn: null` on an existing page: its current draft's
 *   region if this app opened it, else its current published record's. Both
 *   opened in different regions, or neither opened, is `region-mismatch`.
 */
export function writeRegion(
  source:
    | { kind: 'new-node'; parentName: Region }
    | { kind: 'based-on'; basedOn: Region }
    | { kind: 'existing-page'; draft: Region | null; published: Region | null },
): Region {
  switch (source.kind) {
    case 'new-node':
      return source.parentName;
    case 'based-on':
      return source.basedOn;
    case 'existing-page': {
      const { draft, published } = source;
      if (draft && published && !sameRegion(draft, published)) {
        throw new CryptoError(
          'region-mismatch',
          `The page's draft is in ${describe(draft)} but its published version in ${describe(published)}`,
        );
      }
      const region = draft ?? published;
      if (!region) {
        throw new CryptoError('region-mismatch', 'No opened version of the page gives its region');
      }
      return region;
    }
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

/**
 * Refuse a write whose region, from this app's records, isn't where the
 * server's tree and shares put it (section 6.8). Content changes region only
 * through a new share or a move, so a mismatch means the server relabelled
 * the tree, and is reported as `region-mismatch`.
 */
export function requireRegion({ write, tree }: { write: Region; tree: Region }): void {
  if (!sameRegion(write, tree)) {
    throw new CryptoError(
      'region-mismatch',
      `This write belongs in ${describe(write)}, but the server puts it in ${describe(tree)}`,
    );
  }
}
