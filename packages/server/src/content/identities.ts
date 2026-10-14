import { PublicIdentity, type IdentityId } from '@wikistow/contracts';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
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

/** An account's live human identity, or null before its vault exists. */
export async function currentIdentity(
  db: Database,
  accountId: string,
): Promise<PublicIdentity | null> {
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

/** Live public keys for the given identity IDs: the directory clients verify against their pins. */
export async function lookupIdentities(
  db: Database,
  ids: readonly string[],
): Promise<PublicIdentity[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(identities)
    .where(and(inArray(identities.id, [...ids]), isNull(identities.revokedAt)))
    .orderBy(identities.id, desc(identities.keyVersion));
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
