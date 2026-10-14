/** Who can do what in a share, and where shares sit in a tree. Pure, so it is table-tested. */

/** What the Share dialog offers: a reader, an editor, or an editor who can also publish. */
export type Access = 'reader' | 'editor' | 'publisher';

export const ACCESS_LABELS: Record<Access, string> = {
  reader: 'Reader',
  editor: 'Editor',
  publisher: 'Editor + publish',
};

export const isAccess = (value: string): value is Access => Object.hasOwn(ACCESS_LABELS, value);

/** A member's role and publish rights, as the server keeps them. */
export type Grant = { role: 'reader' | 'editor'; canPublish: boolean };

export const accessOf = ({ role, canPublish }: Grant): Access =>
  role === 'reader' ? 'reader' : canPublish ? 'publisher' : 'editor';

export const grantOf = (access: Access): Grant => ({
  role: access === 'reader' ? 'reader' : 'editor',
  canPublish: access === 'publisher',
});

/**
 * What changing a member's access takes (protocol section 7.4). Publish
 * rights change no keys. Making a reader an editor seals them every draft
 * key. Making an editor a reader is a key rotation, so they get no later
 * drafts.
 */
export type AccessChange =
  | { kind: 'none' }
  | { kind: 'publish'; canPublish: boolean }
  | { kind: 'promote'; canPublish: boolean }
  | { kind: 'demote' };

export function accessChange(from: Access, to: Access): AccessChange {
  if (from === to) return { kind: 'none' };
  if (to === 'reader') return { kind: 'demote' };
  if (from === 'reader') return { kind: 'promote', canPublish: to === 'publisher' };
  return { kind: 'publish', canPublish: to === 'publisher' };
}

/**
 * What a new member receives along with access (section 7.3), after their
 * name: a share keeps its history, and every key version goes to them.
 */
export function historyNotice(access: Access): string {
  return access === 'reader'
    ? 'will get every published version kept here, older ones included, but no drafts.'
    : 'will get every published version and every draft kept here, older ones included.';
}

/** A share as the tree lists it: a folder, or the whole space for a null root. */
export type ShareRef = { rootId: string | null };

/** Where a folder, or the space for null, stands for sharing. Shares never nest (section 6.1). */
export type ShareTarget<S extends ShareRef> =
  /** It is a share already: manage who has access. */
  | { kind: 'shared'; share: S }
  /** It is inside a share, or in a shared space: share that instead. */
  | { kind: 'inside'; share: S }
  /** A folder inside it is shared, so it can't be. */
  | { kind: 'holds'; share: S }
  /** It can become a share. */
  | { kind: 'new' };

type Folder = { id: string; parentId: string | null };

/** The folders from `folderId` up to the top, nearest first. Stops on a loop. */
function ancestry(folders: readonly Folder[], folderId: string | null): string[] {
  const parents = new Map(folders.map((f) => [f.id, f.parentId]));
  const chain: string[] = [];
  for (let id = folderId; id !== null && !chain.includes(id); id = parents.get(id) ?? null) {
    chain.push(id);
  }
  return chain;
}

export function shareTarget<S extends ShareRef>(
  { shares, folders }: { shares: readonly S[]; folders: readonly Folder[] },
  rootId: string | null,
): ShareTarget<S> {
  const own = shares.find((share) => share.rootId === rootId);
  if (own) return { kind: 'shared', share: own };
  if (rootId === null) {
    const [any] = shares;
    return any ? { kind: 'holds', share: any } : { kind: 'new' };
  }
  const around = shareCovering({ shares, folders }, rootId);
  if (around) return { kind: 'inside', share: around };
  const below = shares.find(
    (share) => share.rootId !== null && ancestry(folders, share.rootId).includes(rootId),
  );
  return below ? { kind: 'holds', share: below } : { kind: 'new' };
}

/**
 * The share a node under `parentId` is in (null for a top-level node): the
 * nearest share root at or above it, or the space's share. Null when it is
 * in no share.
 */
export function shareCovering<S extends ShareRef>(
  { shares, folders }: { shares: readonly S[]; folders: readonly Folder[] },
  parentId: string | null,
): S | null {
  for (const id of ancestry(folders, parentId)) {
    const share = shares.find((s) => s.rootId === id);
    if (share) return share;
  }
  return shares.find((s) => s.rootId === null) ?? null;
}
