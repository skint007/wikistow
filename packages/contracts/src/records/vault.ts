import { z } from 'zod';
import { Base64, Sealed } from './encoding.ts';
import { AccountId } from './ids.ts';

/**
 * What the server stores for a vault. The keyring is sealed under a random
 * vault key, and that key has two independent wrappers: one from the vault
 * passphrase and one from the recovery key. The account password plays no
 * part, so a password reset cannot unlock anything.
 */
export const VaultWrapper = z.object({
  format: z.literal(1),
  accountId: AccountId,
  keyring: Sealed,
  // KDF settings are only shape-checked here. Clients range-check them on the
  // passphrase path alone, so bad settings can never block the recovery key.
  passphrase: Sealed.extend({
    salt: Base64,
    kdf: z.object({ opsLimit: z.number().int(), memLimit: z.number().int() }),
  }),
  recovery: Sealed,
});
export type VaultWrapper = z.infer<typeof VaultWrapper>;
