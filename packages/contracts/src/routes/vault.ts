import { z } from 'zod';
import { PublicIdentity } from '../records/identity.ts';
import { IdentityId } from '../records/ids.ts';
import { ServedVaultWrapper, VaultWrapper, VaultWrapperV1 } from '../records/vault.ts';
import type { RouteDef } from '../route.ts';

/**
 * Register this account's identity and vault together, once. A new vault is
 * format 1: format 2 comes only from replacing a person's keys.
 */
export const createVault = {
  method: 'POST',
  path: '/api/vault',
  body: z.object({ identity: PublicIdentity, wrapper: VaultWrapperV1 }),
  response: z.strictObject({ version: z.number().int() }),
  status: 201,
} as const satisfies RouteDef;

/**
 * The caller's own vault wrapper. Nobody else's is ever served. A format
 * newer than this version knows is still read, so the app can say to update.
 */
export const getVault = {
  method: 'GET',
  path: '/api/vault',
  response: z.strictObject({ wrapper: ServedVaultWrapper, version: z.number().int() }),
} as const satisfies RouteDef;

/**
 * Replace the passphrase wrapper after a passphrase change or recovery. Needs
 * a recent sign-in; the format, keyring and recovery wrapper can't change.
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
