import { z } from 'zod';
import { Hash32, PositiveInt, PublicKey } from './encoding.ts';
import { IdentityId } from './ids.ts';

/**
 * The public half of a human's or agent's keys: X25519 for receiving content
 * keys and Ed25519 for signing. This is what the server's directory serves,
 * so clients never trust it until it is pinned (see `TrustStore`).
 */
export const PublicIdentity = z.object({
  id: IdentityId,
  kind: z.enum(['human', 'agent']),
  keyVersion: PositiveInt,
  boxPublicKey: PublicKey,
  signPublicKey: PublicKey,
});
export type PublicIdentity = z.infer<typeof PublicIdentity>;

/**
 * One exact key of one person, as signed data names it: `keyHash` covers the
 * ID, kind, version and both public keys (see the client's `keyHash`).
 */
export const IdentityRef = z.strictObject({
  id: IdentityId,
  keyVersion: PositiveInt,
  keyHash: Hash32,
});
export type IdentityRef = z.infer<typeof IdentityRef>;
