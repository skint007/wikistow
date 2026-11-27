import { PublicIdentity, type IdentityId } from '@wikistow/contracts';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { agentProfiles, identities } from '../db/schema/index.ts';
import { ContentError } from './errors.ts';

type IdentityRow = typeof identities.$inferSelect;

const toPublic = (row: IdentityRow): PublicIdentity =>
  PublicIdentity.parse({
    id: row.id,
    kind: row.kind,
    keyVersion: row.keyVersion,
    boxPublicKey: row.boxPublicKey,
    signPublicKey: row.signPublicKey,
  });

/** The class of the two-key advisory lock on an account's identity keys. */
const KEYS_LOCK_CLASS = 5012;

/**
 * Hold the account's identity keys as they are for the rest of the
 * transaction: a rotation of them (`lockKeysForRotation`) waits until it
 * commits, and it waits for one in progress. So a signed write that read the
 * caller's key can't land after a rotation that replaced it (protocol section
 * 4.6). Taken before anything else that waits, as `queueWriter` is.
 */
export const holdKeys = (tx: Database, accountId: string) =>
  tx.execute(
    sql`select pg_advisory_xact_lock_shared(${KEYS_LOCK_CLASS}::int, hashtext(${accountId}))`,
  );

/** What a rotation takes first: every `holdKeys` of the account waits for it, and it for them. */
export const lockKeysForRotation = (tx: Database, accountId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(${KEYS_LOCK_CLASS}::int, hashtext(${accountId}))`);

/**
 * An account's live human identity, or null before its vault exists. It
 * holds the keys first (`holdKeys`), in a statement of its own, so the row
 * is read after any rotation it waited for has committed.
 */
export async function currentIdentity(
  db: Database,
  accountId: string,
): Promise<PublicIdentity | null> {
  await holdKeys(db, accountId);
  const [row] = await db
    .select()
    .from(identities)
    .where(
      and(
        eq(identities.accountId, accountId),
        eq(identities.kind, 'human'),
        isNull(identities.revokedAt),
      ),
    )
    .orderBy(desc(identities.keyVersion))
    .limit(1);
  return row ? toPublic(row) : null;
}

/**
 * Live public keys for the given identity IDs: the directory clients verify
 * against their pins. Every write that seals to them reads them here, so the
 * rows are held (`FOR SHARE`) to the end of its transaction, and a rotation
 * of one of them, which updates its row, waits for it: a key it seals to
 * stays current until it commits (protocol section 4.6). One that waited on
 * a rotation is refused as `stale-head`. The directory route
 * alone reads them without holding them (`hold: false`).
 */
export async function lookupIdentities(
  db: Database,
  ids: readonly string[],
  { hold = true }: { hold?: boolean } = {},
): Promise<PublicIdentity[]> {
  if (ids.length === 0) return [];
  const query = db
    .select()
    .from(identities)
    .where(and(inArray(identities.id, [...ids]), isNull(identities.revokedAt)))
    .orderBy(identities.id, desc(identities.keyVersion));
  const rows = hold ? await query.for('share') : await query;
  // A row that waited on a rotation of it reads as gone, its new row being
  // newer than this statement: read again, and refuse rather than leave the
  // person out of what is sealed.
  if (hold) {
    const found = new Set(rows.map((row) => row.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      const [now] = await db
        .select({ id: identities.id })
        .from(identities)
        .where(and(inArray(identities.id, missing), isNull(identities.revokedAt)))
        .limit(1);
      if (now) throw new ContentError('stale-head', 'A person’s keys changed; try again');
    }
  }
  const latest = new Map<IdentityId | string, IdentityRow>();
  for (const row of rows) if (!latest.has(row.id)) latest.set(row.id, row);
  return [...latest.values()].map(toPublic);
}

/**
 * Who a content request comes from: a person, or one of their agents
 * (`agentId`), whose `accountId` is its person's (protocol section 9.5).
 */
export type Actor = { accountId: string; agentId: string | null };

/** A person acting for themself. */
export const humanActor = (accountId: string): Actor => ({ accountId, agentId: null });

/**
 * An actor with the identity it signs and holds keys as. For an agent,
 * `personId` is the person it acts for, whose current access caps its own.
 */
export type Caller = { accountId: string; identity: PublicIdentity; personId: string | null };

/**
 * The caller behind an actor: a person's live identity (`vault-missing`
 * before their vault exists), or a live agent of theirs. A revoked agent,
 * or one of another account, is `forbidden`.
 */
export async function requireCaller(db: Database, actor: Actor): Promise<Caller> {
  if (actor.agentId === null) {
    const identity = await currentIdentity(db, actor.accountId);
    if (!identity) throw new ContentError('vault-missing', 'Set up your vault first');
    return { accountId: actor.accountId, identity, personId: null };
  }
  // An agent's writes hold its person's keys too: a rotation revokes or keeps it.
  await holdKeys(db, actor.accountId);
  const [row] = await db
    .select({ identity: identities, personId: agentProfiles.ownerIdentityId })
    .from(identities)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, identities.id))
    .where(
      and(
        eq(identities.id, actor.agentId),
        eq(identities.kind, 'agent'),
        eq(identities.accountId, actor.accountId),
        isNull(identities.revokedAt),
      ),
    );
  if (!row) throw new ContentError('forbidden', 'This agent is revoked');
  return { accountId: actor.accountId, identity: toPublic(row.identity), personId: row.personId };
}
