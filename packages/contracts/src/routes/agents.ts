import { z } from 'zod';
import { AgentEnrollment, CredentialId, EnrollmentRequested } from '../records/agent.ts';
import { Base64, Hash32, PositiveInt, PublicKey, Timestamp } from '../records/encoding.ts';
import { PublicIdentity } from '../records/identity.ts';
import { AgentId, FolderId, ShareId, SpaceId } from '../records/ids.ts';
import { FolderKeyEnvelope } from '../records/share.ts';
import { PlainName } from '../records/text.ts';
import type { RouteDef } from '../route.ts';
import { ShareRole } from './sharing.ts';

// Protocol section 9: enrolling agents, what a person grants them, and
// revoking them. The CLI's enrollment routes take no session: it proves
// itself with the poll secret. Everything else is the person's.

const EnrollmentParams = z.object({ enrollmentId: EnrollmentRequested.shape.enrollmentId });
const AgentParams = z.object({ agentId: AgentId });
const Envelopes = z.array(FolderKeyEnvelope).max(10_000);

/** The secret only the CLI that asked holds: 32 bytes. */
export const PollSecret = Base64.refine((value) => value.length === 43, 'A 32-byte secret');

/** What a person grants their agent in one share: the whole share, or one folder in it. */
export const AgentGrant = z
  .strictObject({
    shareId: ShareId,
    folderId: FolderId.nullable(),
    role: ShareRole,
    /** Publish and unpublish, also only where the agent's person can. */
    canPublish: z.boolean(),
  })
  .refine((grant) => grant.role === 'editor' || !grant.canPublish, {
    message: 'Readers never publish',
  });
export type AgentGrant = z.infer<typeof AgentGrant>;

/** The name a person gives their agent. Other people's apps show it as the server's. */
export const AgentName = PlainName(100);

/** Step 1 (CLI): fresh keys and the hash of a poll secret. Rate-limited per address. */
export const requestEnrollment = {
  method: 'POST',
  path: '/api/agents/enrollments',
  body: z.object({
    boxPublicKey: PublicKey,
    signPublicKey: PublicKey,
    pollSecretHash: Hash32,
  }),
  response: EnrollmentRequested,
  status: 201,
} as const satisfies RouteDef;

/**
 * Where an enrollment is, for the CLI that asked. Once claimed, the person
 * who claimed it, whose keys the CLI checks and compares the fingerprint
 * with; their name and email are untrusted. Once approved, the token sealed
 * to the agent's key, exactly once.
 */
export const pollEnrollment = {
  method: 'POST',
  path: '/api/agents/enrollments/:enrollmentId/poll',
  params: EnrollmentParams,
  body: z.object({ pollSecret: PollSecret }),
  response: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('requested') }),
    z.strictObject({
      state: z.enum(['claimed', 'cli-confirmed']),
      person: PublicIdentity,
      name: z.string(),
      email: z.string(),
    }),
    z.strictObject({
      state: z.literal('approved'),
      credentialId: CredentialId,
      /** The token, sealed to the agent's box key. */
      sealedToken: Base64,
    }),
    z.strictObject({ state: z.enum(['delivered', 'expired', 'cancelled', 'rejected']) }),
  ]),
} as const satisfies RouteDef;

/** Step 4 (CLI): its user saw the same fingerprint, for the agent ID its keys and the person make. */
export const confirmEnrollment = {
  method: 'POST',
  path: '/api/agents/enrollments/:enrollmentId/confirm',
  params: EnrollmentParams,
  body: z.object({ pollSecret: PollSecret, agentId: AgentId }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/** The CLI gives up on an enrollment it asked for. */
export const cancelEnrollment = {
  method: 'POST',
  path: '/api/agents/enrollments/:enrollmentId/cancel',
  params: EnrollmentParams,
  body: z.object({ pollSecret: PollSecret }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * Step 2 (person, after a recent sign-in): the enrollment a lookup code
 * names, bound to the caller, with the agent's keys. A code works once, and
 * failed claims are limited per account and across the installation.
 */
export const claimEnrollment = {
  method: 'POST',
  path: '/api/agents/enrollments/claim',
  body: z.object({ lookupCode: z.string().max(32) }),
  response: z.strictObject({
    enrollmentId: EnrollmentRequested.shape.enrollmentId,
    boxPublicKey: PublicKey,
    signPublicKey: PublicKey,
    expiresAt: Timestamp,
  }),
} as const satisfies RouteDef;

/** Where an enrollment the caller claimed is: they approve once the CLI has confirmed. */
export const enrollmentState = {
  method: 'GET',
  path: '/api/agents/enrollments/:enrollmentId',
  params: EnrollmentParams,
  response: z.strictObject({
    state: z.enum([
      'claimed',
      'cli-confirmed',
      'approved',
      'delivered',
      'expired',
      'cancelled',
      'rejected',
    ]),
    expiresAt: Timestamp,
  }),
} as const satisfies RouteDef;

/**
 * Step 5 (person, after a recent sign-in): the signed enrollment, the name
 * they gave the agent, its picks in shares, and those shares' keys sealed
 * to it by the caller, versions 1 to current, with draft keys exactly for
 * editor picks. All or nothing. Picks in the owner region are made shares
 * afterwards, with Make a share's `agentGrants`.
 */
export const approveEnrollment = {
  method: 'POST',
  path: '/api/agents/enrollments/:enrollmentId/approve',
  params: EnrollmentParams,
  body: z.object({
    enrollment: AgentEnrollment,
    name: AgentName,
    grants: z.array(AgentGrant).max(1000),
    envelopes: Envelopes,
  }),
  response: z.strictObject({ agentId: AgentId }),
} as const satisfies RouteDef;

/** The person saw fingerprints that don't match, or changed their mind. */
export const rejectEnrollment = {
  method: 'POST',
  path: '/api/agents/enrollments/:enrollmentId/reject',
  params: EnrollmentParams,
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/** An agent as its person sees it. */
export const OwnAgentSummary = z.strictObject({
  agentId: AgentId,
  name: z.string(),
  enrolledAt: Timestamp,
  revokedAt: Timestamp.nullable(),
  /** When it last saved a draft or published, if ever. */
  lastEditAt: Timestamp.nullable(),
  grants: z.array(AgentGrant.and(z.object({ spaceId: SpaceId }))),
});

/** The caller's agents, revoked ones included, with their grants. */
export const myAgents = {
  method: 'GET',
  path: '/api/me/agents',
  response: z.strictObject({ agents: z.array(OwnAgentSummary) }),
} as const satisfies RouteDef;

/** Revoke an agent: its token stops working at once, and its grants end (section 9.7). */
export const revokeAgent = {
  method: 'POST',
  path: '/api/me/agents/:agentId/revoke',
  params: AgentParams,
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * The key versions of the shares the agent has a grant in that it holds no
 * envelope for, which its person's app seals at unlock (section 9.4).
 */
export const missingVersions = {
  method: 'GET',
  path: '/api/me/agents/:agentId/missing',
  params: AgentParams,
  response: z.strictObject({
    missing: z.array(
      z.strictObject({
        spaceId: SpaceId,
        shareId: ShareId,
        keyVersions: z.array(PositiveInt),
      }),
    ),
  }),
} as const satisfies RouteDef;

/** Key versions the agent lacked, sealed to it by its person. */
export const addAgentEnvelopes = {
  method: 'POST',
  path: '/api/me/agents/:agentId/envelopes',
  params: AgentParams,
  body: z.object({ envelopes: Envelopes }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * Grant the agent a pick in a share, or change its role there: every key
 * version of the share sealed to it again, versions 1 to current, which
 * replace the agent's envelopes there.
 */
export const putAgentGrant = {
  method: 'PUT',
  path: '/api/me/agents/:agentId/grants/:shareId',
  params: AgentParams.extend({ shareId: ShareId }),
  body: z.object({
    folderId: FolderId.nullable(),
    role: ShareRole,
    canPublish: z.boolean(),
    envelopes: Envelopes,
  }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/** Remove the agent's pick in a share. It keeps the keys it had (A6). */
export const deleteAgentGrant = {
  method: 'DELETE',
  path: '/api/me/agents/:agentId/grants/:shareId',
  params: AgentParams.extend({ shareId: ShareId }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;
