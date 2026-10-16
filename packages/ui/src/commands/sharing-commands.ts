import {
  groupOperations,
  IdentityId,
  ownerOperations,
  saveContacts,
  ShareId,
  sharingOperations,
  SpaceId,
  type ClientContext,
  type Lookup,
  type PublicIdentity,
} from '@wikistow/client';
import { z } from 'zod';
import type { Command, CommandEnv } from './command';

/**
 * Where a sharing command runs: the open session, and who hears how a long
 * one is getting on.
 */
export type SharingEnv = CommandEnv & {
  ctx: ClientContext;
  onProgress?: sharingOperations.Progress;
};

// Plans, previews and lookups come from the client's own operations, which
// already checked them; the command only checks it got one.
const made = <T>() => z.custom<T>((value) => typeof value === 'object' && value !== null);

const Person = made<Lookup>();
const Role = z.enum(['reader', 'editor']);
const ShareRef = z.object({ spaceId: SpaceId, shareId: ShareId });

const command = <Input extends z.ZodType>(
  id: string,
  input: Input,
  requires: Command<Input, SharingEnv>['requires'],
  run: Command<Input, SharingEnv>['run'],
): Command<Input, SharingEnv> => ({ id, input, requires, run });

const owner = ['unlocked-vault', 'space-owner'] as const;

/** Make a folder, or the space, a share, once the owner has looked over the preview. */
export const createShare = command(
  'share.create',
  z.object({
    preview: made<sharingOperations.SharePreview>(),
    people: z.array(z.object({ person: Person, role: Role, canPublish: z.boolean() })).min(1),
  }),
  owner,
  async ({ preview, people }, { ctx, onProgress }) => {
    await sharingOperations.shareFolder(ctx, {
      preview,
      people,
      ...(onProgress ? { onProgress } : {}),
    });
  },
);

/** Add someone to a share, make a reader an editor, or share again after a key change. */
export const addMember = command(
  'share.add-member',
  ShareRef.extend({ person: Person, role: Role, canPublish: z.boolean() }),
  owner,
  async (input, { ctx }) => sharingOperations.addMember(ctx, input),
);

/** Turn an editor's publish rights on or off. No keys change. */
export const setPublishRights = command(
  'share.set-publish',
  ShareRef.extend({ identityId: IdentityId, canPublish: z.boolean() }),
  owner,
  async (input, { ctx }) => sharingOperations.setPublishRights(ctx, input),
);

/** Send a key rotation the owner confirmed: a removal, a demotion, or a plain rotation. */
export const rotateShare = command(
  'share.rotate',
  z.object({ planned: made<sharingOperations.PlannedRotation>() }),
  owner,
  async ({ planned }, { ctx }) => {
    await sharingOperations.applyShareRotation(ctx, planned);
  },
);

/** Remove someone from every share and group in the space, in one request. */
export const removeEverywhere = command(
  'share.remove-everywhere',
  z.object({ change: made<groupOperations.GroupChange>() }),
  owner,
  async ({ change }, { ctx }) => groupOperations.applyGroupChange(ctx, change),
);

/** Accept a person's changed key after the warning (protocol section 8.4). */
export const confirmKey = command(
  'contact.confirm-key',
  z.object({ person: Person }),
  ['unlocked-vault'],
  async ({ person }, { ctx }) => {
    ctx.trust.confirmKey(person);
    await saveContacts(ctx, [], { confirm: true });
  },
);

/** Refuse a person's changed key: it is never sealed to, and nothing it signed is accepted. */
export const declineKey = command(
  'contact.decline-key',
  z.object({ identity: made<PublicIdentity>() }),
  ['unlocked-vault'],
  async ({ identity }, { ctx }) => {
    ctx.trust.declineKey(identity);
    await saveContacts(ctx);
  },
);

/** Make someone a co-owner: every key in the space is sealed to them. */
export const addCoOwner = command(
  'owner.add',
  z.object({ spaceId: SpaceId, person: Person }),
  owner,
  async ({ spaceId, person }, { ctx, onProgress }) =>
    ownerOperations.addCoOwner(ctx, { spaceId, person, ...(onProgress ? { onProgress } : {}) }),
);

/** A new owner confirms the owner who added them, and names them back (section 6.5). */
export const confirmAdder = command(
  'owner.confirm-adder',
  z.object({ spaceId: SpaceId, adder: made<PublicIdentity>() }),
  ['unlocked-vault'],
  async (input, { ctx }) => ownerOperations.confirmOwner(ctx, input),
);

/** Send an owner's removal the owner confirmed, rotating every share. Also retries one. */
export const removeOwner = command(
  'owner.remove',
  z.object({ removal: made<ownerOperations.PlannedOwnerRemoval>() }),
  owner,
  async ({ removal }, { ctx }) => ownerOperations.applyOwnerRemoval(ctx, removal),
);

/**
 * The new owner, after a transfer, sends the key renewal they confirmed:
 * every share the previous owner still knows the keys of (section 7.6).
 */
export const finishTransfer = command(
  'owner.finish-transfer',
  z.object({ renewal: made<ownerOperations.PlannedTransferRenewal>() }),
  owner,
  async ({ renewal }, { ctx }) => ownerOperations.finishTransfer(ctx, renewal),
);
