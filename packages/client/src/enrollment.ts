import {
  AGENT_TOKEN,
  CredentialId,
  EnrollmentRequested,
  HumanId,
  LookupCode,
  PositiveInt,
  PublicIdentity,
  Timestamp,
} from '@wikistow/contracts';
import { z } from 'zod';
import {
  canonical,
  decodeUtf8,
  fromBase64,
  hash,
  hashBytes,
  parseWith,
  toBase64,
} from './encoding.ts';
import { CryptoError } from './errors.ts';
import { requireUsableKeys } from './identity.ts';
import { sodium } from './sodium.ts';

export { CredentialId, EnrollmentRequested, LookupCode };

/** How long an enrollment stays open, by the server and by each client's own clock. */
export const ENROLLMENT_WINDOW_MS = 10 * 60_000;

/**
 * A client's deadline for an enrollment: the server's `expiresAt` or its own
 * clock's start plus ten minutes, whichever is earlier. The server could send
 * a far-future `expiresAt`, and the window bounds how long a substituted key
 * could be ground against the enrollment fingerprint.
 */
export function enrollmentDeadline(expiresAt: string, startedAt: Date): Date {
  const served = new Date(parseWith(Timestamp, expiresAt, 'expiresAt')).getTime();
  return new Date(Math.min(served, startedAt.getTime() + ENROLLMENT_WINDOW_MS));
}

/** The server's answer to an agent's enrollment request, refused unless every field has its shape. */
export const parseEnrollmentRequested = (raw: unknown): EnrollmentRequested =>
  parseWith(EnrollmentRequested, raw, 'Enrollment response');

/** What the CLI posts so only it can poll: the hash of its secret, never the secret. */
export const pollSecretHash = (pollSecret: Uint8Array): string =>
  hash(canonical('agent-poll-secret/v1', [pollSecret]));

/**
 * A typed lookup code in its one form: uppercase, no dashes or spaces, and
 * the Crockford look-alikes I and L read as 1, O as 0.
 */
export const normalizeLookupCode = (code: string): string =>
  code.toUpperCase().replace(/[- ]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');

/** What the server stores for a lookup code. */
export const lookupCodeHash = (code: string): string =>
  hash(canonical('agent-lookup-code/v1', [normalizeLookupCode(code)]));

/**
 * The human the CLI is asked to trust, checked as `TrustStore.use` would
 * before the CLI pins it: a human ID, an integer key version, and keys that
 * pass section 4.1. Throws a `CryptoError`.
 */
export function parseClaimingHuman(raw: unknown): PublicIdentity {
  const human = parseWith(
    PublicIdentity.extend({ id: HumanId, kind: z.literal('human'), keyVersion: PositiveInt }),
    raw,
    'Claiming human',
  );
  requireUsableKeys(human);
  return human;
}

/** An agent's bearer token, split into its parts. */
export type AgentToken = { credentialId: string; secret: Uint8Array };

/** Parse `wsa_<credentialId>.<secret>`, decoding the 32-byte secret strictly. Throws `malformed`. */
export function parseAgentToken(token: string): AgentToken {
  const [, credentialId, secret] = AGENT_TOKEN.exec(token) ?? [];
  if (credentialId === undefined || secret === undefined) {
    throw new CryptoError('malformed', 'Not an agent token');
  }
  return { credentialId, secret: fromBase64(secret) };
}

/** What the server stores for a credential: 32 raw bytes, compared in constant time. */
export const agentCredentialHash = ({ credentialId, secret }: AgentToken): Uint8Array =>
  hashBytes(canonical('agent-credential/v1', [credentialId, secret]));

/** A fresh credential, for the server to issue at approval. */
export function newAgentToken(): { token: string; credentialId: string; storedHash: Uint8Array } {
  const credentialId = toBase64(sodium.randombytes_buf(16));
  const secret = sodium.randombytes_buf(32);
  return {
    token: `wsa_${credentialId}.${toBase64(secret)}`,
    credentialId,
    storedHash: agentCredentialHash({ credentialId, secret }),
  };
}

/** Whether a presented token is the stored credential, comparing the hashes in constant time. */
export function agentTokenMatches(token: AgentToken, storedHash: Uint8Array): boolean {
  const presented = agentCredentialHash(token);
  return presented.length === storedHash.length && sodium.memcmp(presented, storedHash);
}

/**
 * The CLI's checks of a delivered token before using or storing it. Anyone
 * can seal to the agent's key, so the opened token is server text: the polled
 * `credentialId` must have its shape and match the token's own.
 */
export function checkDeliveredToken({
  credentialId,
  opened,
}: {
  credentialId: string;
  opened: Uint8Array;
}): string {
  parseWith(CredentialId, credentialId, 'Credential ID');
  const token = decodeUtf8(opened, 'Delivered token');
  if (parseAgentToken(token).credentialId !== credentialId) {
    throw new CryptoError('binding-mismatch', 'The delivered token is for another credential');
  }
  return token;
}
