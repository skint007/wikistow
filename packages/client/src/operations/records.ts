// How operations open records as the server serves them, and where a
// write's content key goes (protocol sections 6.1, 6.3 and 6.8).
import {
  KeyWrap,
  structureRoutes,
  type FolderId,
  type MetadataRevisionId,
  type PageId,
  type RevisionRecord,
  type RevisionRecordV2,
  type Share,
  type SpaceId,
} from '@wikistow/contracts';
import { ApiError } from '../api/client.ts';
import { CryptoError } from '../errors.ts';
import { recordProtocol } from '../envelope.ts';
import { servedKeyMaterial, type AudienceClass } from '../folder-keys.ts';
import { writeKeyVersion } from '../key-versions.ts';
import {
  openMetadata,
  openMetadataV2,
  type ExpectedMetadata,
  type OpenedMetadata,
} from '../metadata.ts';
import type { OpenedPayload } from '../payload.ts';
import { OWNER_REGION, requireRegion, writeRegion, type Region } from '../regions.ts';
import {
  openRevision,
  openRevisionV2,
  type ExpectedRevision,
  type KeyTarget,
} from '../revision.ts';
import { pinAuthors, spaceKeys, type SpaceKeys } from './keys.ts';
import type { ClientContext } from './session.ts';

/** A record and the key material the server served it with (section 16). */
export type Served = { wrap: unknown; envelopes: readonly unknown[] };

/**
 * A decrypted metadata head: what it says, which version it is, and its
 * region, from the key material it was opened through (section 6.1).
 */
export type LoadedMetadata = {
  head: MetadataRevisionId;
  opened: OpenedMetadata;
  region: Region;
};

/**
 * A decrypted revision: its signed record, what it says, its region, and in
 * a share, the key version of the wrap it was opened through (null in the
 * owner region).
 */
export type OpenedRevision = {
  record: RevisionRecord | RevisionRecordV2;
  opened: OpenedPayload;
  region: Region;
  keyVersion: number | null;
};

/**
 * The space's keys, worked out again if any of `wrapped` names a key
 * version, or a class of one, this app doesn't hold yet: after a rotation,
 * a new share, or a reader made an editor.
 */
export async function keysFor(
  ctx: ClientContext,
  spaceId: SpaceId,
  wrapped: readonly { wrap: unknown; audienceClass: AudienceClass }[],
): Promise<SpaceKeys> {
  const keys = await spaceKeys(ctx, spaceId);
  const lacking = wrapped.some(({ wrap: raw, audienceClass }) => {
    const wrap = KeyWrap.safeParse(raw);
    return (
      wrap.success &&
      ctx.keyring.keysFor(spaceId, wrap.data.shareId, wrap.data.keyVersion, audienceClass)
        .length === 0
    );
  });
  return lacking ? spaceKeys(ctx, spaceId, { refresh: true }) : keys;
}

/**
 * Verify and decrypt a metadata version as served, v1 or v2. Its author
 * must already be pinned (`pinAuthors`). Throws a `CryptoError`.
 */
export function openServedMetadata(
  ctx: ClientContext,
  keys: SpaceKeys,
  served: Served & { metadata: unknown },
  expect: ExpectedMetadata,
): LoadedMetadata {
  const material = servedKeyMaterial({ ...served, keyring: ctx.keyring });
  const args = {
    reader: ctx.identity,
    trust: ctx.trust,
    owners: keys.owners.opens,
    metadata: served.metadata,
    expect,
    ...material,
  };
  const { record, opened, region } =
    recordProtocol(served.metadata, 'Metadata') === 1 ? openMetadata(args) : openMetadataV2(args);
  return { head: record.metadataRevisionId, opened, region };
}

/** Verify and decrypt a revision as served, v1 or v2. Throws a `CryptoError`. */
export function openServedRevision(
  ctx: ClientContext,
  keys: SpaceKeys,
  served: Served & { revision: unknown },
  expect: ExpectedRevision,
): OpenedRevision {
  const material = servedKeyMaterial({ ...served, keyring: ctx.keyring });
  const args = {
    reader: ctx.identity,
    trust: ctx.trust,
    owners: keys.owners.opens,
    revision: served.revision,
    expect,
    ...material,
  };
  const opened =
    recordProtocol(served.revision, 'Revision') === 1 ? openRevision(args) : openRevisionV2(args);
  // It opened through this wrap, so the wrap parses.
  const keyVersion = material.keyring ? KeyWrap.parse(material.wrap).keyVersion : null;
  return { ...opened, keyVersion };
}

/**
 * Open a space's or folder's current name as served, pinning its author if
 * seen for the first time. Which version is the head is the server's word
 * (A2); everything else is checked against the request, and its region
 * comes from the key material it opened through.
 */
export async function openName(
  ctx: ClientContext,
  subject: { spaceId: SpaceId; subjectKind: 'space' | 'folder'; subjectId: string },
  served: structureRoutes.ServedMetadata,
): Promise<LoadedMetadata> {
  await pinAuthors(ctx, [served.metadata.record]);
  const keys = await keysFor(ctx, subject.spaceId, [
    { wrap: served.wrap, audienceClass: 'metadata' },
  ]);
  return openServedMetadata(ctx, keys, served, {
    installationId: ctx.installationId,
    ...subject,
    metadataRevisionId: served.metadata.record.metadataRevisionId,
  });
}

/**
 * Where a new node inside `parentId`, or at the top of the space, goes: the
 * server's word on its parent (the share there, and the permission version
 * the write carries), and the region it takes, which is that of its
 * parent's current name record as this app opens it (section 6.1).
 */
export async function newNodeTarget(
  ctx: ClientContext,
  spaceId: SpaceId,
  parentId: FolderId | null,
) {
  const target = await treeTarget(ctx, spaceId, parentId);
  // Only folders and the space have names; anything else holds no nodes.
  if (!target.name) throw new ApiError(404, 'not-found', 'There is no such folder');
  const parentName = await openName(
    ctx,
    parentId === null
      ? { spaceId, subjectKind: 'space', subjectId: spaceId }
      : { spaceId, subjectKind: 'folder', subjectId: parentId },
    target.name,
  );
  return { ...target, region: writeRegion({ kind: 'new-node', parentName: parentName.region }) };
}

/**
 * Where a node is as the server says, for a write there: the share whose
 * region holds it (or none), the permission version the write carries,
 * and, for a folder or the space, its current name record. A share of
 * another space is `binding-mismatch`.
 */
export async function treeTarget(
  ctx: ClientContext,
  spaceId: SpaceId,
  nodeId: FolderId | PageId | null,
) {
  const target = await ctx.api.call(structureRoutes.target, {
    params: { spaceId },
    query: nodeId === null ? {} : { nodeId },
  });
  if (target.share && target.share.spaceId !== spaceId) {
    throw new CryptoError('binding-mismatch', 'The server puts the node in another space’s share');
  }
  return target;
}

/**
 * Where a write in `region` puts its content key (section 6.8), after
 * checking the region, which comes from this app's records, is where the
 * server's tree puts the write (`share`, or none for the owner region): a
 * key wrap under the highest key version that counts for writing, or
 * envelopes to the space's sealing owners. Throws `region-mismatch`,
 * `key-version`, `missing-key` or `unaccepted-owner`.
 */
export function keyTargetFor(
  ctx: ClientContext,
  keys: SpaceKeys,
  region: Region,
  share: Pick<Share, 'spaceId' | 'shareId' | 'currentKeyVersion'> | null,
): KeyTarget {
  requireRegion({
    write: region,
    tree: share ? { kind: 'share', spaceId: share.spaceId, shareId: share.shareId } : OWNER_REGION,
  });
  if (region.kind === 'owner' || !share) return { recipients: keys.owners.sealingOwners() };
  const version = writeKeyVersion({
    keyring: ctx.keyring,
    marks: ctx.marks,
    spaceId: region.spaceId,
    shareId: region.shareId,
    writes: keys.owners.writes,
    currentKeyVersion: share.currentKeyVersion,
  });
  return { share: version };
}

/**
 * Run a write with the space's keys, and once more with keys worked out
 * again if they were out of date: the server refused it for a newer key
 * version (`key-version`) or other owners (`recipients-mismatch`), or this
 * app found it lacked a key it may now hold (`missing-key`), as when a
 * reader was made an editor. The write seals everything afresh each time.
 */
export async function withFreshKeys<T>(
  ctx: ClientContext,
  spaceId: SpaceId,
  write: (keys: SpaceKeys) => Promise<T>,
): Promise<T> {
  try {
    return await write(await spaceKeys(ctx, spaceId));
  } catch (error) {
    const stale =
      (error instanceof ApiError &&
        (error.code === 'key-version' || error.code === 'recipients-mismatch')) ||
      (error instanceof CryptoError && error.code === 'missing-key');
    if (!stale) throw error;
    return write(await spaceKeys(ctx, spaceId, { refresh: true }));
  }
}
