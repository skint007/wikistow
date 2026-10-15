import { z } from 'zod';

const AGENT_PREFIX = 'agent-';

/**
 * An agent's ID: `agent-` and a 32-byte hash in its one canonical text form.
 * Agent IDs are derived from the agent's owner and keys (see the client's
 * `agentIdentityId`), never chosen.
 */
export const AGENT_ID = /^agent-[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

// IDs of encrypted records are made by clients (they're bound into signatures
// and ciphertext before upload), so the server only checks their shape. An
// ID that starts with `agent-` is valid only as a full agent ID, in every
// field, so a human or a node can never pose as an agent.
const id = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .refine((value) => !value.startsWith(AGENT_PREFIX) || AGENT_ID.test(value), {
    message: 'An agent- ID must be a full agent ID',
  });

export const InstallationId = id.brand<'InstallationId'>();
export type InstallationId = z.infer<typeof InstallationId>;
export const AccountId = id.brand<'AccountId'>();
export type AccountId = z.infer<typeof AccountId>;
export const IdentityId = id.brand<'IdentityId'>();
export type IdentityId = z.infer<typeof IdentityId>;
/** A human's identity ID. Never starts with `agent-`. */
export const HumanId = IdentityId.refine((value) => !value.startsWith(AGENT_PREFIX), {
  message: 'Not a human ID',
});
/** An agent's identity ID (see `AGENT_ID`). */
export const AgentId = IdentityId.refine((value) => AGENT_ID.test(value), {
  message: 'Not an agent ID',
});
export const SpaceId = id.brand<'SpaceId'>();
export type SpaceId = z.infer<typeof SpaceId>;
/** A share: a folder or space with its own folder keys. Unique across the installation. */
export const ShareId = id.brand<'ShareId'>();
export type ShareId = z.infer<typeof ShareId>;
/** A group of people in one space that shares go to as one. Made by clients. */
export const GroupId = id.brand<'GroupId'>();
export type GroupId = z.infer<typeof GroupId>;
export const FolderId = id.brand<'FolderId'>();
export type FolderId = z.infer<typeof FolderId>;
export const PageId = id.brand<'PageId'>();
export type PageId = z.infer<typeof PageId>;
export const RevisionId = id.brand<'RevisionId'>();
export type RevisionId = z.infer<typeof RevisionId>;
export const MetadataRevisionId = id.brand<'MetadataRevisionId'>();
export type MetadataRevisionId = z.infer<typeof MetadataRevisionId>;
/** A folder or page: anything in a space's tree. */
export const NodeId = id;
export const AttachmentId = id.brand<'AttachmentId'>();
export type AttachmentId = z.infer<typeof AttachmentId>;
