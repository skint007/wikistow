// The owner actions of sharing (protocol sections 6.7 and 7.3 to 7.5):
// finding a person, making a share, adding a member or making them an
// editor, rotating keys, removing or demoting someone, and Shared with me.
// Each seals only to people the trust store allows, and draws a rotation's
// recipients from envelopes this app verified, never from the server alone.
import {
  groupRoutes,
  peopleRoutes,
  sharingRoutes,
  type FolderId,
  type FolderKeyEnvelope,
  type GroupId,
  type IdentityId,
  type KeyWrap,
  type PageId,
  type ShareId,
  type SpaceId,
} from '@wikistow/contracts';
import { ApiError, outcomeUnknown } from '../api/client.ts';
import { isUsableLabel, pinLabel } from '../contacts.ts';
import { CryptoError } from '../errors.ts';
import {
  folderKeyOf,
  metadataWrapSubject,
  newFolderKeys,
  revisionWrapSubject,
  sealFolderKeys,
  servedKeyMaterial,
  wrapContentKey,
  type FolderKeys,
  type HeldKeyVersion,
} from '../folder-keys.ts';
import { isAgentId, keyHash, type PublicIdentity } from '../identity.ts';
import { FolderId as FolderIdSchema, newId, ShareId as ShareIdSchema } from '../ids.ts';
import { highestWritable, requireNotBehind } from '../key-versions.ts';
import { unsealMetadataKey } from '../metadata.ts';
import { unsealRevisionKey } from '../revision.ts';
import { OWNER_REGION, sameRegion, type Region } from '../regions.ts';
import { planRotation, sealRotation, type RotationPlan } from '../rotation.ts';
import { sodium } from '../sodium.ts';
import { verifyEnrollment, type Lookup } from '../trust.ts';
import {
  firstSightIn,
  forgetSpaces,
  lookupPeople,
  pinAuthors,
  spaceKeys,
  type SpaceKeys,
} from './keys.ts';
import { openServedMetadata, treeTarget, type LoadedMetadata } from './records.ts';
import { saveContacts, type ClientContext } from './session.ts';
import { loadTree } from './spaces.ts';

/** A member's role in a share. */
export type ShareRole = sharingRoutes.ShareRole;

/** Someone to share with: picked or found by email (`listPeople`, `findPerson`), with a role. */
export type Invitee = { person: Lookup; role: ShareRole; canPublish?: boolean };

/** One of the space's groups to share with, with its access (section 7.8). */
export type GroupGrant = { groupId: GroupId; role: ShareRole; canPublish?: boolean };

const higherRole = (a: ShareRole, b: ShareRole | undefined): ShareRole =>
  a === 'editor' || b === 'editor' ? 'editor' : a;

/**
 * The role each human member of the space's groups gets through them, by
 * identity, with their directory entry, where `roleOf` gives each group's
 * role (null for none). Agents are left to their person (section 9.4).
 */
async function groupRoles(
  ctx: ClientContext,
  spaceId: SpaceId,
  roleOf: (group: {
    groupId: GroupId;
    shares: readonly { shareId: ShareId; role: ShareRole }[];
  }) => ShareRole | null,
) {
  const out = new Map<string, { person: Lookup; role: ShareRole }>();
  const { groups } = await ctx.api.call(groupRoutes.listGroups, { params: { spaceId } });
  for (const group of groups) {
    const role = roleOf(group);
    if (!role) continue;
    for (const member of group.members) {
      if (isAgentId(member.identity.id)) continue;
      const best = higherRole(role, out.get(member.identity.id)?.role);
      out.set(member.identity.id, { person: { ...member, foundBy: null }, role: best });
    }
  }
  return out;
}

/**
 * The person whose account has exactly this email, if they have a vault
 * (section 7.3), as a lookup that remembers the typed email: sealing to
 * them checks the key by ID and by that email (section 8.4), and a person
 * seen for the first time is labelled with it.
 */
export async function findPerson(ctx: ClientContext, email: string): Promise<Lookup | null> {
  const { person } = await ctx.api.call(peopleRoutes.lookupPerson, { body: { email } });
  return person && { ...person, foundBy: email };
}

/**
 * Everyone on the server who could be shared with (section 7.3), each as a
 * lookup by the email the directory lists them with, as if that email were
 * typed: picking one checks and labels their key as `findPerson` does. Also
 * the accounts without a vault yet, by name and email, which can't be picked.
 */
export async function listPeople(ctx: ClientContext) {
  const { people, withoutVault } = await ctx.api.call(peopleRoutes.listPeople);
  return {
    people: people.map((person): Lookup => ({ ...person, foundBy: person.email })),
    withoutVault,
  };
}

/**
 * Rename a contact: the name in their label, which is how this person's apps
 * name them from then on (section 8.2). Their ID, key hash and email stay.
 * The server's name for them is never copied in; the person types the new
 * one. Only a pinned person with a usable label can be renamed, to a name a
 * label may hold, or it throws `malformed`.
 */
export async function renameContact(
  ctx: ClientContext,
  identityId: string,
  name: string,
): Promise<void> {
  const { shared, private: own } = ctx.contacts.book.payloads;
  const pin = shared.contacts.find((c) => c.identity.id === identityId);
  const label = pin && pinLabel(pin, own.labels);
  if (!label) throw new CryptoError('malformed', `${identityId} has no label to rename`);
  if (label.name === name) return;
  const renamed = { name, email: label.email };
  if (!isUsableLabel(renamed)) throw new CryptoError('malformed', 'A label can’t hold that name');
  const { id, keyHash: hashed } = label;
  await saveContacts(ctx, [{ kind: 'relabel', id, keyHash: hashed, label: renamed }], {
    holds: (payloads) =>
      payloads.private.labels.some((l) => l.id === id && l.keyHash === hashed && l.name === name),
  });
}

/**
 * The space's keys, worked out afresh for an owner action, which must be
 * one this person may take there: an owner the app accepts itself as, who
 * has confirmed the owner who added them and named them back (section 6.5).
 * Otherwise `unaccepted-owner`.
 */
export async function ownerKeys(ctx: ClientContext, spaceId: SpaceId): Promise<SpaceKeys> {
  const keys = await spaceKeys(ctx, spaceId, { refresh: true });
  const self = ctx.identity.public;
  if (!keys.listed.some((owner) => owner.identity.id === self.id) || !keys.owners.opens(self)) {
    if (keys.owners.adderToConfirm) {
      throw new CryptoError('unaccepted-owner', 'Confirm the owner who added you first');
    }
    throw new CryptoError('unaccepted-owner', 'This app does not accept you as an owner here');
  }
  const adder = keys.owners.adder;
  if (adder && !namedBack(keys, self, adder)) {
    throw new CryptoError('unaccepted-owner', 'Name the owner who added you first');
  }
  return keys;
}

/** Whether `self` has signed a statement naming `adder` at their key. */
export const namedBack = (keys: SpaceKeys, self: PublicIdentity, adder: PublicIdentity) =>
  keys.statements.some(
    (s) =>
      s.signerId === self.id &&
      s.signerKeyVersion === self.keyVersion &&
      s.owner.id === adder.id &&
      s.owner.keyHash === keyHash(adder),
  );

/**
 * How far a long operation has got: the records it has done so far, of the
 * `total` the server counted in the scope when it sent the latest part.
 */
export type Progress = (progress: { records: number; total: number }) => void;

/** One page of a scope's records, with this person's key material for each. */
type Scanned = Awaited<ReturnType<typeof scanPage>>['records'][number];

const scanPage = (
  ctx: ClientContext,
  spaceId: SpaceId,
  query: { scope: 'subtree' | 'owner-region'; rootId?: FolderId | PageId; after?: string },
) => ctx.api.call(sharingRoutes.records, { params: { spaceId }, query });

/**
 * Every retained record in a scope, part by part, with each one's content
 * key recovered through this person's own key material and checked against
 * the record (section 6.7, step 3). Every record must be in region `from`,
 * the owner region unless given, or it is `region-mismatch`: one the server
 * says is elsewhere isn't where the operation thinks it is. `use` gets the
 * record and its key, which is wiped as soon as it returns. After each
 * part, `onProgress` gets how many records were done so far, and of how many.
 */
export async function forEachRecordKey(
  ctx: ClientContext,
  keys: SpaceKeys,
  spaceId: SpaceId,
  scope: { scope: 'subtree' | 'owner-region'; rootId?: FolderId | PageId },
  use: (
    item:
      | { kind: 'revision'; record: ReturnType<typeof unsealRevisionKey>['record'] }
      | { kind: 'metadata'; record: ReturnType<typeof unsealMetadataKey>['record'] },
    contentKey: Uint8Array,
  ) => void,
  { onProgress, from = OWNER_REGION }: { onProgress?: Progress | undefined; from?: Region } = {},
): Promise<void> {
  let after: string | undefined;
  let done = 0;
  do {
    const page = await scanPage(ctx, spaceId, { ...scope, ...(after ? { after } : {}) });
    await pinAuthors(
      ctx,
      page.records.map((item: Scanned) =>
        item.kind === 'revision' ? item.revision.record : item.metadata.record,
      ),
    );
    for (const item of page.records) {
      if ((item.wrap === null) !== (from.kind === 'owner')) {
        throw new CryptoError('region-mismatch', `A record there isn't in ${describeRegion(from)}`);
      }
      const common = {
        reader: ctx.identity,
        trust: ctx.trust,
        owners: keys.owners.opens,
        ...servedKeyMaterial({ wrap: item.wrap, envelopes: item.envelopes, keyring: ctx.keyring }),
      };
      const opened =
        item.kind === 'revision'
          ? {
              kind: 'revision' as const,
              ...unsealRevisionKey({
                ...common,
                revision: item.revision,
                expect: {
                  installationId: ctx.installationId,
                  spaceId,
                  pageId: item.revision.record.pageId,
                  revisionId: item.revision.record.revisionId,
                },
              }),
            }
          : {
              kind: 'metadata' as const,
              ...unsealMetadataKey({
                ...common,
                metadata: item.metadata,
                expect: {
                  installationId: ctx.installationId,
                  spaceId,
                  subjectKind: item.metadata.record.subjectKind,
                  subjectId: item.metadata.record.subjectId,
                  metadataRevisionId: item.metadata.record.metadataRevisionId,
                },
              }),
            };
      try {
        if (!sameRegion(opened.region, from)) {
          throw new CryptoError(
            'region-mismatch',
            `A record there isn't in ${describeRegion(from)}`,
          );
        }
        use(
          opened.kind === 'revision'
            ? { kind: 'revision', record: opened.record }
            : { kind: 'metadata', record: opened.record },
          opened.contentKey,
        );
      } finally {
        sodium.memzero(opened.contentKey);
      }
    }
    done += page.records.length;
    onProgress?.({ records: done, total: Math.max(done, page.total) });
    after = page.next ?? undefined;
  } while (after);
}

const describeRegion = (region: Region) =>
  region.kind === 'owner' ? 'the owner region' : `share ${region.shareId}`;

/** Seal one key version to each recipient, both keys for an editor or owner, the published key for a reader. */
export const sealVersion = (
  ctx: ClientContext,
  spaceId: SpaceId,
  shareId: ShareId,
  keyVersion: number,
  keys: Pick<FolderKeys, 'publishedKey'> & { draftKey: Uint8Array | null },
  recipients: readonly { identity: PublicIdentity; role: ShareRole }[],
): FolderKeyEnvelope[] =>
  recipients.map(({ identity, role }) => {
    if (role === 'editor' && !keys.draftKey) {
      throw new CryptoError('missing-key', `No draft key for version ${keyVersion} of ${shareId}`);
    }
    return sealFolderKeys({
      sealer: ctx.identity,
      installationId: ctx.installationId,
      spaceId,
      shareId,
      keyVersion,
      recipient: identity,
      keys: { draftKey: role === 'editor' ? keys.draftKey : null, publishedKey: keys.publishedKey },
    });
  });

// Each invitee with the key to seal to, through the trust store, all or nothing.
function withKeys(ctx: ClientContext, people: readonly Invitee[]) {
  const keys = ctx.trust.recipients(people.map((p) => p.person));
  return people.map((invitee, i) => {
    const identity = keys[i];
    if (!identity) throw new CryptoError('malformed', 'Nobody to share with');
    return { ...invitee, identity };
  });
}

/**
 * What making a share over `rootId` (the whole space for `null`) will move
 * out of the owner region (section 6.7, step 1): the folders and pages under
 * it, by decrypted name, from the server's tree, for the owner to look over
 * and confirm. `shareFolder` wraps nothing outside it.
 */
export type SharePreview = {
  spaceId: SpaceId;
  rootId: FolderId | null;
  folders: readonly { id: FolderId; parentId: FolderId | null; metadata: LoadedMetadata | null }[];
  pages: readonly { id: PageId; parentId: FolderId | null; title: string | null }[];
};

/** The preview of a new share over `rootId`, or the whole space for `null` (section 6.7, step 1). */
export async function previewShare(
  ctx: ClientContext,
  { spaceId, rootId }: { spaceId: SpaceId; rootId: FolderId | null },
): Promise<SharePreview> {
  await ownerKeys(ctx, spaceId);
  const tree = await loadTree(ctx, spaceId);
  // Sharing the whole space wraps its name, which the owner must have seen.
  if (rootId === null && !tree.space?.metadata) {
    throw new CryptoError('binding-mismatch', 'This app can’t open the space’s name');
  }
  const under = new Set<FolderId>();
  if (rootId !== null) {
    if (!tree.folders.some((folder) => folder.id === rootId)) {
      throw new ApiError(404, 'not-found', 'There is no such folder');
    }
    under.add(rootId);
    for (let grew = true; grew;) {
      grew = false;
      for (const folder of tree.folders) {
        if (folder.parentId && under.has(folder.parentId) && !under.has(folder.id)) {
          under.add(folder.id);
          grew = true;
        }
      }
    }
  }
  const inside = (parentId: FolderId | null) =>
    rootId === null || (!!parentId && under.has(parentId));
  return {
    spaceId,
    rootId,
    folders: tree.folders
      .filter((folder) => folder.id === rootId || inside(folder.parentId))
      .map(({ id, parentId, metadata }) => ({ id, parentId, metadata })),
    pages: tree.pages
      .filter((page) => inside(page.parentId))
      .map(({ id, parentId, title }) => ({ id, parentId, title })),
  };
}

/**
 * Make a folder, or the whole space, a share, and share it with `people`
 * (sections 6.7 and 7.3). Call it once the owner has confirmed `preview`:
 * it wraps every retained record of the previewed folders and pages (and
 * the space's name, for a space share) under version 1 of a new share, and
 * seals version 1 to every sealing owner and to each person, through the
 * trust store, all or nothing. The records come from the server's scan, so
 * a record of anything the owner wasn't shown, or a previewed node whose
 * records the scan leaves out, stops it (`binding-mismatch`) before
 * anything is sent. So does a previewed folder whose name this app couldn't
 * open, a page with no title, or a node whose parents, as previewed, don't
 * lead to the root: every record of the owner region opens for an owner, so
 * such an entry is a lie or damage, and wrapping it would share what the
 * owner couldn't see. A key change anywhere stops it (`identity-key-changed`).
 * `onProgress` hears as each part of the records is wrapped. With `groups`,
 * each member of them gets version 1 too, at their highest role, unless
 * their key changed: they wait (section 7.9). Returns the share's ID.
 */
export async function shareFolder(
  ctx: ClientContext,
  {
    preview,
    people,
    groups = [],
    agents = [],
    onProgress,
  }: {
    preview: SharePreview;
    people: readonly Invitee[];
    groups?: readonly GroupGrant[];
    /**
     * This person's own agents to grant the whole new share, for a pick in
     * the owner region (section 9.4). Each gets version 1 from this app.
     */
    agents?: readonly { agentId: IdentityId; role: ShareRole; canPublish?: boolean }[];
    onProgress?: Progress;
  },
): Promise<ShareId> {
  const { spaceId, rootId } = preview;
  requireReviewable(preview);
  const keys = await ownerKeys(ctx, spaceId);
  const owners = keys.owners.sealingOwners();
  const viaGroups =
    groups.length === 0
      ? new Map<string, { person: Lookup; role: ShareRole }>()
      : await groupRoles(
          ctx,
          spaceId,
          (group) => groups.find((g) => g.groupId === group.groupId)?.role ?? null,
        );
  // A direct member in a group gets their higher role; the rest of the
  // groups' members are sealed to unless their key changed.
  const invited = withKeys(ctx, people).map((invitee) => ({
    ...invitee,
    sealed: higherRole(invitee.role, viaGroups.get(invitee.identity.id)?.role),
  }));
  const groupOnly = [...viaGroups.values()].filter(({ person }) => {
    const check = ctx.trust.check(person.identity, person.email);
    return (
      !invited.some((i) => i.identity.id === person.identity.id) &&
      check.kind !== 'changed' &&
      check.kind !== 'removed'
    );
  });
  const grouped = withKeys(ctx, groupOnly);
  const ownAgents = agents.map((grant) => ({
    ...grant,
    agent: ownAgentToSeal(ctx, grant.agentId),
  }));
  const { permissionVersion } = await treeTarget(ctx, spaceId, rootId);
  const folders = new Set<string>(preview.folders.map((folder) => folder.id));
  const pages = new Set<string>(preview.pages.map((page) => page.id));
  // Every previewed node, and the space for a space share, until a record of it is scanned.
  const unseen = new Set<string>([...folders, ...pages, ...(rootId === null ? [spaceId] : [])]);
  // The keys about to be sealed to are pinned first (section 8.3), so a
  // later session warns if one changes.
  await saveContacts(ctx, [], {
    sealTo: [...invited, ...grouped].map(({ identity }) => identity),
  });
  const shareId = newId(ShareIdSchema);
  if (ownAgents.length > 0) {
    // The agents' lists hold the share before its keys are sealed to them.
    const added = ownAgents.map(({ agentId, role }) => ({
      agentId,
      share: { spaceId, shareId, drafts: role === 'editor' },
    }));
    await saveContacts(
      ctx,
      added.map(({ agentId, share }) => ({
        kind: 'agent-shares' as const,
        agentId,
        set: [share],
        unset: [],
      })),
      {
        holds: ({ shared }) =>
          added.every(({ agentId, share }) =>
            shared.agents.some(
              (entry) =>
                entry.enrollment.agent.id === agentId &&
                entry.shares.some((s) => s.shareId === shareId && s.drafts === share.drafts),
            ),
          ),
      },
    );
  }
  const folderKeys = newFolderKeys();
  try {
    const wraps: { subjectKind: 'revision' | 'metadata'; versionId: string; wrap: KeyWrap }[] = [];
    await forEachRecordKey(
      ctx,
      keys,
      spaceId,
      { scope: 'subtree', ...(rootId ? { rootId } : {}) },
      (item, contentKey) => {
        // Only what the owner was shown. Names above a folder share, and
        // pages elsewhere, stay in the owner region (section 7.7).
        const node =
          item.kind === 'revision'
            ? pages.has(item.record.pageId) && item.record.pageId
            : item.record.subjectKind === 'space'
              ? rootId === null && item.record.subjectId === spaceId && spaceId
              : folders.has(item.record.subjectId) && item.record.subjectId;
        if (!node) {
          throw new CryptoError('binding-mismatch', 'A record there is outside the preview');
        }
        unseen.delete(node);
        const subject =
          item.kind === 'revision'
            ? revisionWrapSubject(item.record)
            : metadataWrapSubject(item.record);
        const folderKey = folderKeyOf(folderKeys, subject.audienceClass);
        if (!folderKey) throw new CryptoError('missing-key', 'A new share has every key');
        wraps.push({
          subjectKind: item.kind,
          versionId: subject.versionId,
          wrap: wrapContentKey({
            installationId: ctx.installationId,
            subject,
            shareId,
            keyVersion: 1,
            folderKey,
            contentKey,
          }),
        });
      },
      { onProgress },
    );
    if (unseen.size > 0) {
      throw new CryptoError('binding-mismatch', 'The server left out records of the preview');
    }
    const envelopes = sealVersion(ctx, spaceId, shareId, 1, folderKeys, [
      ...owners.map((identity) => ({ identity, role: 'editor' as const })),
      ...invited.map(({ identity, sealed }) => ({ identity, role: sealed })),
      ...grouped.map(({ identity, role }) => ({ identity, role })),
      ...ownAgents.map(({ agent, role }) => ({ identity: agent, role })),
    ]);
    await ctx.api.call(sharingRoutes.makeShare, {
      params: { spaceId },
      body: {
        shareId,
        rootId,
        wraps,
        envelopes,
        members: invited.map(({ identity, role, canPublish = false }) => ({
          identityId: identity.id,
          keyVersion: identity.keyVersion,
          role,
          canPublish: role === 'editor' && canPublish,
        })),
        agentGrants: ownAgents.map(({ agentId, role, canPublish = false }) => ({
          agentId,
          folderId: null,
          role,
          canPublish: role === 'editor' && canPublish,
        })),
        groups: groups.map(({ groupId, role, canPublish = false }) => ({
          groupId,
          role,
          canPublish: role === 'editor' && canPublish,
        })),
        permissionVersion,
      },
    });
  } catch (error) {
    // Refused, so the share was never made: the agents' lists mustn't keep
    // it. Without an answer it may have been, and the entries stay.
    if (ownAgents.length > 0 && !outcomeUnknown(error)) {
      const unset = [{ spaceId, shareId }];
      await saveContacts(
        ctx,
        ownAgents.map(({ agentId }) => ({
          kind: 'agent-shares' as const,
          agentId,
          set: [],
          unset,
        })),
        {
          holds: ({ shared }) =>
            !shared.agents.some((entry) => entry.shares.some((s) => s.shareId === shareId)),
        },
      ).catch(() => {});
    }
    throw error;
  } finally {
    sodium.memzero(folderKeys.draftKey);
    sodium.memzero(folderKeys.publishedKey);
  }
  forgetSpaces(ctx);
  return shareId;
}

// One of this person's agents to seal to: in their own contacts record, not
// revoked, with an enrollment that verifies under their key (section 9.4).
function ownAgentToSeal(ctx: ClientContext, agentId: IdentityId): PublicIdentity {
  const { shared } = ctx.contacts.book.payloads;
  const entry = shared.agents.find((agent) => agent.enrollment.agent.id === agentId);
  if (!entry || shared.revokedAgents.some((revoked) => revoked.agentId === agentId)) {
    throw new CryptoError('wrong-recipient', 'Keys go only to this person’s own live agents');
  }
  verifyEnrollment({
    installationId: ctx.installationId,
    owner: ctx.identity.public,
    enrollment: entry.enrollment,
  });
  return entry.enrollment.agent;
}

// Refuse a preview the owner couldn't have looked over (see `shareFolder`).
function requireReviewable({ rootId, folders, pages }: SharePreview) {
  if (rootId !== null && !folders.some((folder) => folder.id === rootId)) {
    throw new CryptoError('malformed', 'The preview must hold the share root');
  }
  const parents = new Map<FolderId, FolderId | null>();
  for (const folder of folders) {
    if (folder.metadata === null) {
      throw new CryptoError('binding-mismatch', `This app can't open the name of ${folder.id}`);
    }
    parents.set(folder.id, folder.parentId);
  }
  // Whether a node under `parentId` is inside the share, by the previewed parents alone.
  const leadsToRoot = (parentId: FolderId | null) => {
    let id = parentId;
    for (let steps = 0; steps <= parents.size; steps++) {
      if (id === rootId) return true;
      if (id === null || !parents.has(id)) return false;
      id = parents.get(id) ?? null;
    }
    return false;
  };
  for (const folder of folders) {
    if (folder.id !== rootId && !leadsToRoot(folder.parentId)) {
      throw new CryptoError('binding-mismatch', `${folder.id} isn't under the share root`);
    }
  }
  for (const page of pages) {
    if (page.title === null) {
      throw new CryptoError('binding-mismatch', `This app can't open the title of ${page.id}`);
    }
    if (!leadsToRoot(page.parentId)) {
      throw new CryptoError('binding-mismatch', `${page.id} isn't under the share root`);
    }
  }
}

/**
 * A space's shares and their members, as the server lists them, for its
 * owners. A share of another space is `binding-mismatch`: folder keys are
 * looked up only under the space acted on (section 6.2).
 */
export async function listShares(ctx: ClientContext, spaceId: SpaceId) {
  const { shares } = await ctx.api.call(sharingRoutes.listShares, { params: { spaceId } });
  for (const share of shares) requireInSpace(share, spaceId);
  return shares;
}

// Refuse a share the server says is in `spaceId` but names another space.
function requireInSpace(share: { spaceId: SpaceId; shareId: ShareId }, spaceId: SpaceId) {
  if (share.spaceId !== spaceId) {
    throw new CryptoError('binding-mismatch', `Share ${share.shareId} is in another space`);
  }
}

async function requireShare(ctx: ClientContext, spaceId: SpaceId, shareId: ShareId) {
  const share = (await listShares(ctx, spaceId)).find((s) => s.shareId === shareId);
  if (!share) throw new CryptoError('missing-key', `The server lists no share ${shareId}`);
  return share;
}

/**
 * The keys this app seals each of a share's versions `1` to `current` with,
 * when it gives every version to someone (sections 7.3 and 7.6): one held
 * from an owner in its writing set where it has one, else one it opened.
 * Keys are looked up under the space `keys` were worked out for, never one
 * the server names.
 * The current version must count for writing and not be below the No going
 * back mark (`key-version`), so a version a removed owner made isn't passed
 * on as current. A version it doesn't hold at all is `missing-key`.
 */
export function versionsToGive(
  ctx: ClientContext,
  keys: SpaceKeys,
  { shareId, currentKeyVersion }: { shareId: ShareId; currentKeyVersion: number },
): HeldKeyVersion[] {
  const { spaceId } = keys;
  const held = ctx.keyring.versions(spaceId, shareId);
  const writable = highestWritable({
    keyring: ctx.keyring,
    spaceId,
    shareId,
    writes: keys.owners.writes,
  });
  if (writable) ctx.marks.raise(spaceId, shareId, writable.keyVersion);
  requireNotBehind({ marks: ctx.marks, spaceId, shareId, keyVersion: currentKeyVersion });
  return Array.from({ length: currentKeyVersion }, (_, i) => {
    const keyVersion = i + 1;
    const ofVersion = held.filter((h) => h.keyVersion === keyVersion);
    const chosen = ofVersion.find((h) => keys.owners.writes(h.sealer)) ?? ofVersion[0];
    if (!chosen || (keyVersion === currentKeyVersion && !keys.owners.writes(chosen.sealer))) {
      throw new CryptoError(
        chosen ? 'key-version' : 'missing-key',
        `Version ${keyVersion} of share ${shareId} can't be passed on from this app`,
      );
    }
    return chosen;
  });
}

/**
 * Give `person` a direct grant in a share: add them, or raise their grant
 * (sections 7.3 and 7.4), sealing every key version, with the draft key
 * when they will be an editor, directly or through a group (section 7.8).
 * Lowering a direct grant that a group still covers needs no rotation, so
 * it is this too, sealing the same keys again, which the server allows.
 * Demoting an editor is a rotation (`demoteMember`); dropping a direct
 * grant is `planRemoveDirectGrant`; publish rights alone are
 * `setPublishRights`. After a key change, Give access (`planGiveAccess`)
 * seals to the new key instead.
 */
export async function addMember(
  ctx: ClientContext,
  {
    spaceId,
    shareId,
    person,
    role,
    canPublish = false,
  }: { spaceId: SpaceId; shareId: ShareId } & Invitee,
): Promise<void> {
  const keys = await ownerKeys(ctx, spaceId);
  keys.owners.sealingOwners();
  const [identity] = ctx.trust.recipients([person]);
  if (!identity) throw new CryptoError('malformed', 'Nobody to add');
  await saveContacts(ctx, [], { sealTo: [identity] });
  const share = await requireShare(ctx, spaceId, shareId);
  const viaGroups = await groupRoles(
    ctx,
    spaceId,
    (group) => group.shares.find((s) => s.shareId === shareId)?.role ?? null,
  );
  const sealed = higherRole(role, viaGroups.get(identity.id)?.role);
  const envelopes = versionsToGive(ctx, keys, share).flatMap((held) =>
    sealVersion(ctx, spaceId, shareId, held.keyVersion, held, [{ identity, role: sealed }]),
  );
  const { permissionVersion } = await treeTarget(ctx, spaceId, share.rootId);
  await ctx.api.call(sharingRoutes.addMember, {
    params: { shareId },
    body: {
      member: {
        identityId: identity.id,
        keyVersion: identity.keyVersion,
        role,
        canPublish: role === 'editor' && canPublish,
      },
      envelopes,
      permissionVersion,
    },
  });
}

/**
 * Turn an editor's publish rights on or off (section 7.4). It changes no
 * keys, so nothing is sealed: the server alone enforces them (A1).
 */
export async function setPublishRights(
  ctx: ClientContext,
  {
    spaceId,
    shareId,
    identityId,
    canPublish,
  }: { spaceId: SpaceId; shareId: ShareId; identityId: IdentityId; canPublish: boolean },
): Promise<void> {
  await ownerKeys(ctx, spaceId);
  const share = await requireShare(ctx, spaceId, shareId);
  const member = share.members.find((m) => m.identityId === identityId);
  if (member?.role !== 'editor') {
    throw new ApiError(404, 'not-found', 'Only an editor of the share has publish rights');
  }
  const { permissionVersion } = await treeTarget(ctx, spaceId, share.rootId);
  await ctx.api.call(sharingRoutes.addMember, {
    params: { shareId },
    body: { member: { ...member, canPublish }, envelopes: [], permissionVersion },
  });
}

/** A rotation worked out for the owner to confirm, with what it is sent with. */
export type PlannedRotation = {
  plan: RotationPlan;
  /** The permission version of the share's root, which the request carries. */
  permissionVersion: number;
};

/**
 * Work out a rotation of one share for the owner to confirm (section 7.5):
 * who keeps it, each with their role, and who is left out and why. `leaveOut`
 * are members removed or left out, `demote` members who become readers.
 * When the action removes an owner (`removing`), envelopes that owner sealed
 * count for this rotation, except for a version this app sealed itself: a
 * removed owner the server still lists can't slip anyone into a version
 * after this app has sealed one without them.
 */
export async function planShareRotation(
  ctx: ClientContext,
  {
    spaceId,
    shareId,
    leaveOut = [],
    demote = [],
    removing,
    keys: given,
  }: {
    spaceId: SpaceId;
    shareId: ShareId;
    leaveOut?: readonly IdentityId[];
    demote?: readonly IdentityId[];
    removing?: PublicIdentity;
    keys?: SpaceKeys;
  },
): Promise<PlannedRotation> {
  const keys = given ?? (await ownerKeys(ctx, spaceId));
  const share = await requireShare(ctx, spaceId, shareId);
  const v = share.currentKeyVersion;
  const { envelopes } = await ctx.api.call(sharingRoutes.versionEnvelopes, {
    params: { shareId, keyVersion: v },
  });
  const self = ctx.identity.public.id;
  const sealedV = ctx.keyring
    .versions(spaceId, shareId)
    .some((held) => held.keyVersion === v && held.sealer.id === self);
  // When this person removes another owner, that owner's envelopes count for
  // the rotation (section 7.6), but not for a version this app sealed.
  const counted =
    removing && removing.id !== self && sealedV
      ? envelopes.filter((e) => e.sealerId !== removing.id)
      : envelopes;
  const directory = await lookupPeople(ctx, [
    ...share.members.map((m) => m.identityId),
    ...envelopes.map((e) => e.sealerId),
  ]);
  const plan = planRotation({
    installationId: ctx.installationId,
    spaceId,
    shareId,
    currentKeyVersion: v,
    envelopes: counted,
    members: share.members,
    owners: keys.owners,
    ...(removing ? { removing } : {}),
    leaveOut,
    demote,
    keyring: ctx.keyring,
    marks: ctx.marks,
    trust: ctx.trust,
    directory,
  });
  const { permissionVersion } = await treeTarget(ctx, spaceId, share.rootId);
  return { plan, permissionVersion };
}

/**
 * Seal a confirmed rotation's new version to its remaining people, by role.
 * The new keys are wiped once sealed; this app opens its own envelope of
 * the new version the next time it works out the space.
 */
export function sealPlanned(ctx: ClientContext, plan: RotationPlan) {
  const keys = newFolderKeys();
  try {
    return {
      expectedKeyVersion: plan.keyVersion - 1,
      removed: plan.removed,
      demoted: plan.demoted,
      envelopes: sealRotation({
        sealer: ctx.identity,
        installationId: ctx.installationId,
        plan,
        keys,
      }),
    };
  } finally {
    sodium.memzero(keys.draftKey);
    sodium.memzero(keys.publishedKey);
  }
}

/**
 * Send a rotation the owner confirmed. If another owner rotated first, the
 * server answers `stale-head`: plan again, and ask the owner again if the
 * remaining people changed. Returns the new key version.
 */
export async function applyShareRotation(
  ctx: ClientContext,
  { plan, permissionVersion }: PlannedRotation,
): Promise<number> {
  await saveContacts(ctx, [], { sealTo: plan.remaining.map(({ identity }) => identity) });
  const { keyVersion } = await ctx.api.call(sharingRoutes.rotate, {
    params: { shareId: plan.shareId },
    body: { ...sealPlanned(ctx, plan), permissionVersion },
  });
  forgetSpaces(ctx);
  return keyVersion;
}

/** Rotate a share's keys without removing anyone, as after an agent is revoked (section 9.7). */
export const rotateKeys = async (
  ctx: ClientContext,
  args: { spaceId: SpaceId; shareId: ShareId },
) => applyShareRotation(ctx, await planShareRotation(ctx, args));

/** Remove a member from a share, rotating its keys (section 7.5). */
export const removeMember = async (
  ctx: ClientContext,
  { spaceId, shareId, identityId }: { spaceId: SpaceId; shareId: ShareId; identityId: IdentityId },
) =>
  applyShareRotation(
    ctx,
    await planShareRotation(ctx, { spaceId, shareId, leaveOut: [identityId] }),
  );

/** Make an editor a reader: a rotation that seals them only the new published key (section 7.4). */
export const demoteMember = async (
  ctx: ClientContext,
  { spaceId, shareId, identityId }: { spaceId: SpaceId; shareId: ShareId; identityId: IdentityId },
) =>
  applyShareRotation(ctx, await planShareRotation(ctx, { spaceId, shareId, demote: [identityId] }));

/** A share as Shared with me lists it, with its root's name and who shared it. */
export type SharedItem = {
  share: { shareId: ShareId; spaceId: SpaceId; rootId: FolderId | null; currentKeyVersion: number };
  role: ShareRole;
  canPublish: boolean;
  /**
   * The folder the item names, null for a whole space: the share root, or
   * for an agent, the folder it was picked at, which may be inside the share.
   */
  folderId: FolderId | null;
  /** That folder's name, the space's for a space; null when it can't be opened. */
  root: LoadedMetadata | null;
  /**
   * Who shared it, with their label, or null: the owner this app accepted
   * by first sight in the space (section 6.5, step 2), or in a later
   * session, the owner who sealed this person's earliest version of it.
   */
  sharedBy: { identity: PublicIdentity; label: string | null } | null;
};

/**
 * Shared with me (section 7.7): every share in which this person is a
 * member and not an owner, with its root's name decrypted under the
 * share's published key, and who shared it. Nothing above a share root.
 * An agent's share is named by the folder it was picked at instead.
 */
export async function sharedWithMe(ctx: ClientContext): Promise<SharedItem[]> {
  const { shares } = await ctx.api.call(sharingRoutes.sharedWithMe);
  // Each space is worked out afresh once, however many of its shares are listed.
  const spaces = new Map<SpaceId, Promise<SpaceKeys>>();
  const items: SharedItem[] = [];
  for (const { share, role, canPublish, root } of shares) {
    let fresh = spaces.get(share.spaceId);
    if (!fresh)
      spaces.set(share.spaceId, (fresh = spaceKeys(ctx, share.spaceId, { refresh: true })));
    const keys = await fresh;
    // Only the server knows an agent's picks (section 9.4), so for an agent
    // the folder is the one its name record is for.
    const { record } = root.metadata;
    const folderId =
      ctx.agent && record.subjectKind === 'folder'
        ? FolderIdSchema.parse(record.subjectId)
        : share.rootId;
    let name: LoadedMetadata | null = null;
    try {
      await pinAuthors(ctx, [record]);
      const subject =
        folderId === null
          ? { subjectKind: 'space' as const, subjectId: share.spaceId }
          : { subjectKind: 'folder' as const, subjectId: folderId };
      name = openServedMetadata(ctx, keys, root, {
        installationId: ctx.installationId,
        spaceId: share.spaceId,
        ...subject,
        metadataRevisionId: record.metadataRevisionId,
      });
    } catch (error) {
      if (!(error instanceof CryptoError)) throw error;
    }
    items.push({
      share,
      role,
      canPublish,
      folderId,
      root: name,
      sharedBy: sharedByOf(ctx, keys, share.shareId),
    });
  }
  return items;
}

// Who shared: the owner this session's app accepted in the space by first
// sight (section 6.5, step 2). A later session, which accepts nobody by
// first sight, names the accepted owner who sealed this person's earliest
// version of the share instead. Either way, with their pinned label.
function sharedByOf(ctx: ClientContext, keys: SpaceKeys, shareId: ShareId): SharedItem['sharedBy'] {
  const sealer =
    firstSightIn(ctx, keys.spaceId) ??
    ctx.keyring
      .versions(keys.spaceId, shareId)
      .sort((a, b) => a.keyVersion - b.keyVersion)
      .find((held) => keys.owners.opens(held.sealer))?.sealer;
  if (!sealer) return null;
  const { shared, private: own } = ctx.contacts.book.payloads;
  const pin = shared.contacts.find(
    (c) => c.identity.id === sealer.id && keyHash(c.identity) === keyHash(sealer),
  );
  return { identity: sealer, label: pin ? (pinLabel(pin, own.labels)?.name ?? null) : null };
}
