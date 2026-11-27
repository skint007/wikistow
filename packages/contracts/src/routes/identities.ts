import { z } from 'zod';
import { AgentEnrollment } from '../records/agent.ts';
import { SealedContacts } from '../records/contacts.ts';
import { PositiveInt } from '../records/encoding.ts';
import { IdentityRotation, PublicIdentity } from '../records/identity.ts';
import { AgentId, HumanId } from '../records/ids.ts';
import { VaultWrapperV2 } from '../records/vault.ts';
import type { RouteDef } from '../route.ts';

// Replacing a person's identity keys (protocol section 4.6, #327).

/** More agents than any account keeps live at once. */
const MAX_AGENTS = 1000;

/**
 * Replace the caller's identity keys with the ones `rotation` names, one key
 * version up, in one transaction: the new public identity, the new vault
 * (format 2), the first contacts version signed with the new key, and every
 * live agent of the account named as kept, with its enrollment signed again,
 * or revoked. The account's other sessions, and the live sessions in its
 * spaces, end. Needs a recent sign-in, and the server's `IDENTITY_ROTATION`
 * setting (`rotation-off` otherwise). A second statement for the same key
 * version is `rotation-exists`; the same one sent again is answered as
 * accepted, with the vault and contacts versions current now.
 */
export const rotate = {
  method: 'POST',
  path: '/api/me/identity/rotate',
  body: z.object({
    rotation: IdentityRotation,
    identity: PublicIdentity,
    wrapper: VaultWrapperV2,
    expectedVaultVersion: PositiveInt,
    contacts: SealedContacts,
    enrollments: z.array(AgentEnrollment).max(MAX_AGENTS),
    keptAgents: z.array(AgentId).max(MAX_AGENTS),
    revokedAgents: z.array(AgentId).max(MAX_AGENTS),
  }),
  response: z.strictObject({ vaultVersion: PositiveInt, contactsVersion: PositiveInt }),
} as const satisfies RouteDef;

const IdentityParams = z.object({ identityId: HumanId });
// Key versions as Postgres stores them, in an `integer`.
const KeyVersion = z.coerce.number().int().positive().max(2_147_483_647);

/**
 * The rotation statements of a person whose `from.keyVersion` is `from` or
 * more, in order, with their current key from the same read: the app checks
 * the chain against it (`verifyRotationChain`). Statements are served as
 * stored, for `parseIdentityRotation` to read, so a later format asks to
 * update rather than failing as an unreadable answer.
 */
export const rotations = {
  method: 'GET',
  path: '/api/identities/:identityId/rotations',
  params: IdentityParams,
  query: z.object({ from: KeyVersion.default(1) }),
  response: z.strictObject({
    current: PublicIdentity.nullable(),
    rotations: z.array(z.record(z.string(), z.unknown())),
  }),
} as const satisfies RouteDef;

/** A person's public keys at one key version, current or earlier; `not-found` for none. */
export const version = {
  method: 'GET',
  path: '/api/identities/:identityId/versions/:keyVersion',
  params: IdentityParams.extend({ keyVersion: KeyVersion }),
  response: z.strictObject({ identity: PublicIdentity }),
} as const satisfies RouteDef;
