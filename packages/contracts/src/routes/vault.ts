import { z } from 'zod';
import { PublicIdentity } from '../records/identity.ts';
import { IdentityId } from '../records/ids.ts';
import { VaultWrapper } from '../records/vault.ts';
import type { RouteDef } from '../route.ts';

/** Register this account's identity and vault together, once. */
export const createVault = {
  method: 'POST',
  path: '/api/vault',
  body: z.object({ identity: PublicIdentity, wrapper: VaultWrapper }),
  response: z.strictObject({ version: z.number().int() }),
  status: 201,
} as const satisfies RouteDef;

/** The caller's own vault wrapper. Nobody else's is ever served. */
export const getVault = {
  method: 'GET',
  path: '/api/vault',
  response: z.strictObject({ wrapper: VaultWrapper, version: z.number().int() }),
} as const satisfies RouteDef;

/**
 * Replace the passphrase wrapper after a passphrase change or recovery. Needs
 * a recent sign-in; the keyring and recovery wrapper can't change.
 */
export const replaceVault = {
  method: 'PUT',
  path: '/api/vault',
  body: z.object({ wrapper: VaultWrapper, expectedVersion: z.number().int().positive() }),
  response: z.strictObject({ version: z.number().int() }),
} as const satisfies RouteDef;

/**
 * The directory: public keys for identity IDs, comma-separated. Clients
 * check every key against their pins before using it.
 */
export const lookupIdentities = {
  method: 'GET',
  path: '/api/identities',
  query: z.object({
    ids: z
      .string()
      .transform((ids) => ids.split(',').filter(Boolean))
      .pipe(z.array(IdentityId).max(100)),
  }),
  response: z.strictObject({ identities: z.array(PublicIdentity) }),
} as const satisfies RouteDef;
