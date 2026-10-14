import { VaultWrapper, type PublicIdentity } from '@wikistow/contracts';
import { DEFAULT_KDF, isAgentId, KdfParams } from '@wikistow/client';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { isUniqueViolation } from '../db/errors.ts';
import { identities, vaultWrappers } from '../db/schema/index.ts';
import { ContentError } from './errors.ts';
import { currentIdentity } from './identities.ts';

export type { KdfParams };

/**
 * The cheapest passphrase wrapper the server stores: the client's own
 * default. A buggy or outdated client could otherwise register a wrapper
 * whose passphrase can be guessed offline almost for free. Tests lower it.
 */
export const MIN_VAULT_KDF: KdfParams = DEFAULT_KDF;

function checkKdf(kdf: unknown, minKdf: KdfParams): void {
  const parsed = KdfParams.safeParse(kdf);
  if (!parsed.success) throw new ContentError('invalid-vault', 'Unsupported KDF settings');
  if (parsed.data.opsLimit < minKdf.opsLimit || parsed.data.memLimit < minKdf.memLimit)
    throw new ContentError('invalid-vault', 'The passphrase protection is too weak');
}

/**
 * Register an account's identity and its vault together. Doing both in one
 * transaction means there is never an identity whose private keys exist
 * nowhere, or a vault with no identity behind it.
 */
export async function createVault(
  db: Database,
  {
    accountId,
    identity,
    wrapper,
    minKdf,
  }: { accountId: string; identity: PublicIdentity; wrapper: VaultWrapper; minKdf: KdfParams },
): Promise<{ version: number }> {
  if (identity.kind !== 'human' || isAgentId(identity.id))
    throw new ContentError('invalid-vault', 'A person’s identity is required');
  // A new identity starts at key version 1 with an ID nobody has used. Taking
  // over an existing ID at a higher version would make its grants yours.
  if (identity.keyVersion !== 1)
    throw new ContentError('invalid-vault', 'New identities start at key version 1');
  if (wrapper.accountId !== accountId)
    throw new ContentError('binding-mismatch', 'Vault belongs to another account');
  checkKdf(wrapper.passphrase.kdf, minKdf);
  try {
    return await db.transaction(async (tx) => {
      // One registration at a time per account, so a retry that overlaps the
      // first attempt waits for it and then finds what it stored.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`wikistow:vault:${accountId}`}))`,
      );
      // A retry after a lost response sends exactly what was stored: answer it
      // as before, so the recovery key the person already saw stays the one.
      const [stored] = await tx
        .select()
        .from(vaultWrappers)
        .where(eq(vaultWrappers.accountId, accountId));
      if (stored) {
        const current = await currentIdentity(tx, accountId);
        const same =
          current !== null &&
          sameJson(current, identity) &&
          sameJson(VaultWrapper.parse(stored.wrapper), wrapper);
        if (same) return { version: stored.version };
        throw new ContentError('vault-exists');
      }
      const [taken] = await tx
        .select({ id: identities.id })
        .from(identities)
        .where(eq(identities.id, identity.id))
        .limit(1);
      if (taken) throw new ContentError('duplicate', 'That identity ID is taken');
      await tx.insert(identities).values({
        id: identity.id,
        keyVersion: identity.keyVersion,
        accountId,
        kind: 'human',
        boxPublicKey: identity.boxPublicKey,
        signPublicKey: identity.signPublicKey,
      });
      await tx.insert(vaultWrappers).values({ accountId, wrapper });
      return { version: 1 };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ContentError('vault-exists');
    throw error;
  }
}

// jsonb doesn't keep key order, so compare with keys sorted.
const sameJson = (a: unknown, b: unknown) => sortedJson(a) === sortedJson(b);
const sortedJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)))
      : v,
  );

export async function readVault(
  db: Database,
  accountId: string,
): Promise<{ wrapper: VaultWrapper; version: number }> {
  const [row] = await db.select().from(vaultWrappers).where(eq(vaultWrappers.accountId, accountId));
  if (!row) throw new ContentError('vault-missing');
  return { wrapper: VaultWrapper.parse(row.wrapper), version: row.version };
}

const sameSealed = (
  a: { nonce: string; ciphertext: string },
  b: { nonce: string; ciphertext: string },
) => a.nonce === b.nonce && a.ciphertext === b.ciphertext;

/**
 * Replace the passphrase wrapper and nothing else. The keyring and the
 * recovery wrapper must arrive byte-for-byte unchanged, so a stolen session
 * can change the passphrase but can never destroy the keys or the recovery
 * path. `expectedVersion` stops two devices overwriting each other.
 */
export async function replaceVaultPassphrase(
  db: Database,
  {
    accountId,
    wrapper,
    expectedVersion,
    minKdf,
  }: { accountId: string; wrapper: VaultWrapper; expectedVersion: number; minKdf: KdfParams },
): Promise<{ version: number }> {
  checkKdf(wrapper.passphrase.kdf, minKdf);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(vaultWrappers)
      .where(eq(vaultWrappers.accountId, accountId))
      .for('update');
    if (!row) throw new ContentError('vault-missing');
    if (row.version !== expectedVersion) throw new ContentError('stale-vault-version');
    const stored = VaultWrapper.parse(row.wrapper);
    const unchanged =
      wrapper.format === stored.format &&
      wrapper.accountId === stored.accountId &&
      sameSealed(wrapper.keyring, stored.keyring) &&
      sameSealed(wrapper.recovery, stored.recovery);
    if (!unchanged)
      throw new ContentError('vault-immutable-field', 'Only the passphrase wrapper can change');
    await tx
      .update(vaultWrappers)
      .set({ wrapper, version: sql`${vaultWrappers.version} + 1`, updatedAt: sql`now()` })
      .where(eq(vaultWrappers.accountId, accountId));
    return { version: row.version + 1 };
  });
}
