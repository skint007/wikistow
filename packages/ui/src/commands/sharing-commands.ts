import {
  groupOperations,
  IdentityId,
  ownerOperations,
  saveContacts,
  ShareId,
  sharingOperations,
  spaceOperations,
  SpaceId,
  type ClientContext,
  type Lookup,
  type PublicIdentity,
} from '@wikistow/client';
import { GroupId } from '@wikistow/contracts';
import { z } from 'zod';
import { runCommand, type Command, type CommandEnv } from './command';

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
const Grant = { role: Role, canPublish: z.boolean() };
const ShareRef = z.object({ spaceId: SpaceId, shareId: ShareId });

const command = <Input extends z.ZodType>(
  id: string,
  input: Input,
  requires: Command<Input, SharingEnv>['requires'],
  run: Command<Input, SharingEnv>['run'],
): Command<Input, SharingEnv> => ({ id, input, requires, run });

const owner = ['unlocked-vault', 'space-owner'] as const;

/**
 * Make a folder, or the space, a share, once the owner has looked over the
 * preview: with people, groups of the space, or both.
 */
export const createShare = command(
  'share.create',
  z
    .object({
      preview: made<sharingOperations.SharePreview>(),
      people: z.array(z.object({ person: Person, ...Grant })).default([]),
      groups: z.array(z.object({ groupId: GroupId, ...Grant })).default([]),
    })
    .refine(({ people, groups }) => people.length + groups.length > 0, 'Nobody to share with'),
  owner,
  async ({ preview, people, groups }, { ctx, onProgress }) => {
    await sharingOperations.shareFolder(ctx, {
      preview,
      people,
      groups,
      ...(onProgress ? { onProgress } : {}),
    });
  },
);

/** Give someone a direct grant in a share, or change it, sealing their keys by their access. */
export const addMember = command(
  'share.add-member',
  ShareRef.extend({ person: Person, ...Grant }),
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

// A change to who has access that the owner confirmed (protocol sections
// 7.8 and 7.9), worked out by the client's `plan*` operations: its
// envelopes and rotations go in one request. Each kind is its own command.
const groupChange = (id: string, kind: groupOperations.GroupAction['kind']) =>
  command(
    id,
    z.object({
      change: made<groupOperations.GroupChange>().refine(
        (change) => change.action.kind === kind,
        `Not a ${kind}`,
      ),
    }),
    owner,
    async ({ change }, { ctx }) => groupOperations.applyGroupChange(ctx, change),
  );

export const groupChangeCommands = {
  /** Delete a group, out of every folder it has. */
  'delete-group': groupChange('group.delete', 'delete-group'),
  /** Add someone to a group, sealing them every folder it has. */
  'add-member': groupChange('group.add-member', 'add-member'),
  /** Put an agent in a group; it gets nothing until its person confirms. */
  'add-agent': groupChange('group.add-agent', 'add-agent'),
  /** Take someone out of a group, rotating where their access drops. */
  'remove-member': groupChange('group.remove-member', 'remove-member'),
  /** Share a folder with a group, or change its access there. */
  'set-share-group': groupChange('share.set-group', 'set-share-group'),
  /** Take a group out of a folder. */
  'remove-share-group': groupChange('share.remove-group', 'remove-share-group'),
  /** Drop someone's direct grant, keeping what their groups give them. */
  'remove-direct': groupChange('share.remove-direct', 'remove-direct'),
  /** Remove someone from every share and group in the space. */
  'remove-everywhere': groupChange('share.remove-everywhere', 'remove-everywhere'),
  /** Seal their keys to someone waiting for them. */
  'give-access': groupChange('share.give-access', 'give-access'),
} satisfies Record<groupOperations.GroupAction['kind'], unknown>;

/** Send a group change the owner confirmed, as the command named for what it does. */
export const sendGroupChange = (change: groupOperations.GroupChange, env: SharingEnv) =>
  runCommand(groupChangeCommands[change.action.kind], { change }, env);

/** Make a group in a space, its name sealed to the owners. */
export const createGroup = command(
  'group.create',
  z.object({ spaceId: SpaceId, name: z.string().trim().min(1).max(200) }),
  owner,
  async (input, { ctx }) => {
    await groupOperations.createGroup(ctx, input);
  },
);

/** Rename a group, as a new version of the name the owner was shown. */
export const renameGroup = command(
  'group.rename',
  z.object({
    spaceId: SpaceId,
    groupId: GroupId,
    current: made<groupOperations.Group['name'] & {}>(),
    name: z.string().trim().min(1).max(200),
  }),
  owner,
  async (input, { ctx }) => {
    await groupOperations.renameGroup(ctx, input);
  },
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

/** Delete the space for everyone, once the owner has typed its name. */
export const deleteSpace = command(
  'space.delete',
  z.object({ spaceId: SpaceId, permissionVersion: z.number().int() }),
  owner,
  async (input, { ctx }) => spaceOperations.deleteSpace(ctx, input),
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
