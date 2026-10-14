import {
  agentOperations,
  FolderId,
  IdentityId,
  ShareId,
  sharingOperations,
  SpaceId,
  type ClientContext,
} from '@wikistow/client';
import { z } from 'zod';
import { PartlyDone } from '../agents/messages';
import { chatStore } from '../ai/chat';
import type { Command, CommandEnv } from './command';

/**
 * Where an agent command runs: the open session, and who hears what a
 * command found out (the claim a code named, or the agent approved).
 */
export type AgentEnv = CommandEnv & {
  ctx: ClientContext;
  onClaim?: (claim: agentOperations.Claim) => void;
  onApproved?: (agentId: IdentityId) => void;
  /** Hears each part of a long approval as it starts. */
  onStep?: (step: ApprovalStep) => void;
};

/** A part of an approval: the approval itself, then each pick made a share. */
export type ApprovalStep =
  | { kind: 'approving' }
  | { kind: 'sharing'; spaceId: SpaceId; folderId: FolderId | null };

// Claims come from the client's own operations, which already checked them.
const Claim = z.custom<agentOperations.Claim>(
  (value) => typeof value === 'object' && value !== null && 'enrollmentId' in value,
);
const Role = z.enum(['reader', 'editor']);

/** Where an agent may work: a folder, or the space for null, and its access there. */
const Pick = z.object({
  spaceId: SpaceId,
  folderId: FolderId.nullable(),
  role: Role,
  canPublish: z.boolean(),
  /** In the owner region: it becomes a share, with the agent its only member. */
  newShare: z.boolean(),
  /** The share the folder must be in, if the pick names one; null for a new share. */
  shareId: ShareId.nullable().optional(),
});
type Pick = z.output<typeof Pick>;

// A pick inside a share, checked against the share it names (if it names one).
const inShare = ({ spaceId, folderId, role, canPublish, shareId }: Pick) => ({
  spaceId,
  folderId,
  role,
  canPublish,
  ...(shareId ? { shareId } : {}),
});

const command = <Input extends z.ZodType>(
  id: string,
  input: Input,
  run: Command<Input, AgentEnv>['run'],
): Command<Input, AgentEnv> => ({ id, input, requires: ['unlocked-vault'], run });

// A pick in the owner region, made a share with the agent in it (protocol section 9.4).
async function pickNewShare(ctx: ClientContext, agentId: IdentityId, pick: Pick) {
  const preview = await sharingOperations.previewShare(ctx, {
    spaceId: pick.spaceId,
    rootId: pick.folderId,
  });
  await agentOperations.pickInOwnerRegion(ctx, {
    agentId,
    preview,
    role: pick.role,
    canPublish: pick.canPublish,
  });
}

/** Claim the enrollment a lookup code names; `onClaim` gets what to compare. */
export const claimAgent = command(
  'agent.claim',
  z.object({ lookupCode: z.string().min(1).max(32) }),
  async ({ lookupCode }, { ctx, onClaim }) => {
    onClaim?.(await agentOperations.claimEnrollment(ctx, lookupCode));
  },
);

/** The fingerprints didn't match, or the person changed their mind. */
export const rejectAgent = command(
  'agent.reject',
  z.object({ claim: Claim }),
  async ({ claim }, { ctx }) => agentOperations.rejectEnrollment(ctx, claim),
);

/**
 * Approve a claimed enrollment the person compared: free the name from a
 * revoked agent first if asked, approve with the picks inside shares, then
 * make each pick in the owner region a share. Picks that fail after the
 * approval are `PartlyDone`: the agent exists, so the person adds them later.
 */
export const approveAgent = command(
  'agent.approve',
  z.object({
    claim: Claim,
    comparedFingerprint: z.string(),
    name: z.string().trim().min(1).max(100),
    renameRevoked: z.object({ agentId: IdentityId, name: z.string().min(1).max(100) }).nullable(),
    picks: z.array(Pick),
  }),
  async (
    { claim, comparedFingerprint, name, renameRevoked, picks },
    { ctx, onApproved, onStep },
  ) => {
    onStep?.({ kind: 'approving' });
    if (renameRevoked) {
      await agentOperations.renameAgent(ctx, renameRevoked.agentId, renameRevoked.name);
    }
    const agentId = await agentOperations.approveEnrollment(ctx, {
      claim,
      comparedFingerprint,
      name,
      picks: picks.filter((pick) => !pick.newShare).map(inShare),
    });
    onApproved?.(agentId);
    const failed: string[] = [];
    let cause: unknown = null;
    for (const pick of picks.filter((p) => p.newShare)) {
      try {
        onStep?.({ kind: 'sharing', spaceId: pick.spaceId, folderId: pick.folderId });
        await pickNewShare(ctx, agentId, pick);
      } catch (error) {
        failed.push(pick.folderId ?? pick.spaceId);
        cause ??= error;
      }
    }
    if (failed.length > 0) throw new PartlyDone(agentId, failed, cause);
  },
);

/** Give an agent a folder, or change its access there. */
export const pickForAgent = command(
  'agent.pick',
  z.object({ agentId: IdentityId, pick: Pick }),
  async ({ agentId, pick }, { ctx }) => {
    if (pick.newShare) return pickNewShare(ctx, agentId, pick);
    await agentOperations.grantAgent(ctx, agentId, inShare(pick));
  },
);

/** Take a folder away from an agent. It keeps the keys it had; owners can rotate them. */
export const removeAgentPick = command(
  'agent.remove-pick',
  z.object({ agentId: IdentityId, spaceId: SpaceId, shareId: ShareId }),
  async ({ agentId, spaceId, shareId }, { ctx }) =>
    agentOperations.removeAgentPick(ctx, agentId, { spaceId, shareId }),
);

/**
 * Revoke an agent: its token ends now, and a chat with it ends here at
 * once. Keys it already holds stay with it.
 */
export const revokeAgent = command(
  'agent.revoke',
  z.object({ agentId: IdentityId }),
  async ({ agentId }, { ctx }) => {
    await agentOperations.revokeAgent(ctx, agentId);
    chatStore.agentRevoked(agentId);
  },
);

/** Seal to this person's agents the key versions they lack (at every unlock). */
export const resealAgents = command('agents.reseal', z.object({}), async (_input, { ctx }) => {
  await agentOperations.resealAgents(ctx);
});
