import { z } from 'zod';
import { Base64, PositiveInt, Timestamp } from './encoding.ts';
import { PublicIdentity } from './identity.ts';
import { IdentityId, InstallationId } from './ids.ts';

/**
 * An owner's signed statement that an agent's keys belong to them. Other
 * clients that already trust the owner can trust the agent from this alone.
 */
export const AgentEnrollment = z.strictObject({
  installationId: InstallationId,
  agent: PublicIdentity.strict(),
  ownerId: IdentityId,
  ownerKeyVersion: PositiveInt,
  signature: Base64,
});
export type AgentEnrollment = z.infer<typeof AgentEnrollment>;

/** The handle a person types to claim an enrollment, `XXXX-XXXX` in Crockford base32. */
export const LookupCode = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

/** What the server answers an agent's enrollment request. The CLI refuses any other shape. */
export const EnrollmentRequested = z.strictObject({
  enrollmentId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  lookupCode: LookupCode,
  expiresAt: Timestamp,
});
export type EnrollmentRequested = z.infer<typeof EnrollmentRequested>;

/** An agent credential's ID: 16 random bytes, 22 characters. */
export const CredentialId = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

/** `wsa_<credentialId>.<secret>`, with a 32-byte secret. Sent as `Authorization: Bearer`. */
export const AGENT_TOKEN = /^wsa_([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
export const AgentToken = z.string().regex(AGENT_TOKEN);
