import { z } from 'zod';
import { Base64, Sealed } from './encoding.ts';
import { AccountId } from './ids.ts';

const wrapperFields = {
  accountId: AccountId,
  keyring: Sealed,
  // KDF settings are only shape-checked here. Clients range-check them on the
  // passphrase path alone, so bad settings can never block the recovery key.
  passphrase: Sealed.extend({
    salt: Base64,
    kdf: z.object({ opsLimit: z.number().int(), memLimit: z.number().int() }),
  }),
  recovery: Sealed,
};

/**
 * What the server stores for a vault. The keyring is sealed under a random
 * vault key, and that key has two independent wrappers: one from the vault
 * passphrase and one from the recovery key. The account password plays no
 * part, so a password reset cannot unlock anything.
 */
export const VaultWrapperV1 = z.object({ format: z.literal(1), ...wrapperFields });
export type VaultWrapperV1 = z.infer<typeof VaultWrapperV1>;

/**
 * Format 2 (protocol section 4.6): format 1's layout, with a keyring that
 * also holds the person's earlier keys after they replaced them, sealed
 * under its own associated data so it never opens as format 1.
 */
export const VaultWrapperV2 = z.object({ format: z.literal(2), ...wrapperFields });
export type VaultWrapperV2 = z.infer<typeof VaultWrapperV2>;

export const VaultWrapper = z.discriminatedUnion('format', [VaultWrapperV1, VaultWrapperV2]);
export type VaultWrapper = z.infer<typeof VaultWrapper>;

/**
 * A wrapper of a format newer than any this version knows, as a later server
 * may serve. Read only so the app can say to update rather than that the
 * answer was unreadable; nothing in it is used.
 */
export const NewerVaultWrapper = z.looseObject({ format: z.number().int().min(3) });
export type NewerVaultWrapper = z.infer<typeof NewerVaultWrapper>;

/** A wrapper as the server serves it: one this version knows, or a newer one. */
export const ServedVaultWrapper = z.union([VaultWrapper, NewerVaultWrapper]);
export type ServedVaultWrapper = z.infer<typeof ServedVaultWrapper>;
