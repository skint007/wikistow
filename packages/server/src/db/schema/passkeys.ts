import { bigint, boolean, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { primaryId, timestamptz } from './helpers.ts';
import { users } from './users.ts';

/**
 * Better Auth's passkeys (its passkey plugin), one row per WebAuthn
 * credential. A passkey signs in on its own, as both factors. The vault
 * passphrase is still asked for after.
 */
export const passkeys = pgTable(
  'passkeys',
  {
    id: primaryId(),
    /** What the person called it, or the authenticator's name when they gave none. */
    name: text(),
    /** The credential's public key, base64. */
    publicKey: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The WebAuthn credential ID, base64url, as the browser sends it at sign-in. */
    credentialID: text().notNull(),
    /** The authenticator's signature counter, an unsigned 32-bit number (often 0). */
    counter: bigint({ mode: 'number' }).notNull(),
    /** `singleDevice` or `multiDevice` (synced). */
    deviceType: text().notNull(),
    backedUp: boolean().notNull(),
    transports: text(),
    createdAt: timestamptz().defaultNow(),
    aaguid: text(),
  },
  (table) => [
    index('passkeys_user_id_idx').on(table.userId),
    uniqueIndex('passkeys_credential_id_idx').on(table.credentialID),
  ],
);
