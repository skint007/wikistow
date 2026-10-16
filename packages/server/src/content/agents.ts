// Agents (protocol section 9): enrollment, what a person grants their
// agents, the bearer credential, and revocation.
import {
  AgentEnrollment,
  InstallationId,
  PublicIdentity,
  type agentRoutes,
  type FolderKeyEnvelope,
} from '@wikistow/contracts';
import {
  agentIdentityId,
  agentTokenMatches,
  CryptoError,
  fromBase64,
  lookupCodeHash,
  newAgentToken,
  normalizeLookupCode,
  parseAgentToken,
  pollSecretHash,
  requireUsableKeys,
  sealKeyTo,
  toBase64,
  utf8,
  verifyEnrollment,
} from '@wikistow/client';
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { z } from 'zod';
import { audit } from '../admin/audit.ts';
import type { Database } from '../db/client.ts';
import {
  agentCredentials,
  agentEdits,
  agentEnrollments,
  agentGrants,
  agentProfiles,
  appRateLimits,
  folderKeyEnvelopes,
  groupMembers,
  groups,
  identities,
  nodes,
  shareGroups,
  shares,
  users,
} from '../db/schema/index.ts';
import { consumeRateLimit } from '../rate-limit.ts';
import { readSettings } from '../settings.ts';
import {
  agentGrantsOf,
  ancestorsOf,
  lockSpace,
  personAccess,
  type Access,
  type AgentGrant,
  type ShareRow,
} from './access.ts';
import { ContentError } from './errors.ts';
import { checkFolderEnvelopes, storeFolderEnvelopes } from './sharing.ts';
import { requireIdentity } from './structure.ts';

type Grant = z.output<typeof agentRoutes.AgentGrant>;
type Enrollment = typeof agentEnrollments.$inferSelect;

/** How long an enrollment stays open (section 9.1). */
export const ENROLLMENT_MS = 10 * 60_000;

/**
 * How long an enrollment is kept once its ten minutes are up. An approved
 * one whose CLI never collected its token by then never will: the agent
 * made for it is revoked.
 */
export const ENROLLMENT_KEPT = sql`interval '1 day'`;

/**
 * Failed claims of a lookup code, per account and across the installation,
 * in a window (section 9.2, step 2). Always enforced: they are what keeps
 * 40-bit codes from being guessed.
 */
const CLAIM_LIMITS = {
  windowMs: 10 * 60_000,
  perAccount: 5,
  installation: 30,
} as const;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Eight random Crockford symbols, 40 bits, shown as XXXX-XXXX.
function newLookupCode(): string {
  const bytes = randomBytes(5);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let code = '';
  for (let i = 7; i >= 0; i--) code += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

const sameHash = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Step 1: a CLI's fresh keys, which must pass section 4.1, and the hash of
 * its poll secret. Answers the lookup code, which is kept only hashed.
 */
export async function requestEnrollment(
  db: Database,
  input: { boxPublicKey: string; signPublicKey: string; pollSecretHash: string },
) {
  try {
    requireUsableKeys(input);
  } catch (error) {
    if (error instanceof CryptoError) throw new ContentError('binding-mismatch', error.message);
    throw error;
  }
  await sweepEnrollments(db);
  const expiresAt = new Date(Date.now() + ENROLLMENT_MS);
  for (;;) {
    const lookupCode = newLookupCode();
    const id = randomBytes(16).toString('base64url');
    const inserted = await db
      .insert(agentEnrollments)
      .values({
        id,
        lookupCodeHash: lookupCodeHash(lookupCode),
        pollSecretHash: input.pollSecretHash,
        boxPublicKey: input.boxPublicKey,
        signPublicKey: input.signPublicKey,
        expiresAt,
      })
      .onConflictDoNothing()
      .returning({ id: agentEnrollments.id });
    // Another open enrollment has this code: draw again.
    if (inserted.length > 0) {
      return { enrollmentId: id, lookupCode, expiresAt: expiresAt.toISOString() };
    }
  }
}

// Enrollments kept past `ENROLLMENT_KEPT`, forgotten as new ones are asked
// for, so anyone asking can't fill the table. The agent of one approved
// but never collected is revoked, as its person would revoke it.
async function sweepEnrollments(db: Database) {
  await db.execute(sql`
    with lapsed as (
      delete from agent_enrollments where expires_at < now() - ${ENROLLMENT_KEPT}
      returning state, agent_id
    ),
    uncollected as (select agent_id from lapsed where state = 'approved'),
    revoked_identities as (
      update identities set revoked_at = now()
      where id in (select agent_id from uncollected) and revoked_at is null
    ),
    revoked_credentials as (
      update agent_credentials set revoked_at = now()
      where agent_id in (select agent_id from uncollected) and revoked_at is null
    )
    delete from agent_grants where agent_id in (select agent_id from uncollected)`);
}

// The enrollment, locked for this transaction, with lapsed ones marked
// expired: every state but approved and delivered ends at `expiresAt`.
async function lockEnrollment(tx: Database, enrollmentId: string): Promise<Enrollment> {
  const [row] = await tx
    .select()
    .from(agentEnrollments)
    .where(eq(agentEnrollments.id, enrollmentId))
    .for('update');
  if (!row) throw new ContentError('not-found');
  const open =
    row.state === 'requested' || row.state === 'claimed' || row.state === 'cli-confirmed';
  if (open && row.expiresAt.getTime() <= Date.now()) {
    await tx
      .update(agentEnrollments)
      .set({ state: 'expired' })
      .where(eq(agentEnrollments.id, enrollmentId));
    return { ...row, state: 'expired' };
  }
  return row;
}

// The enrollment the CLI that asked for it polls, proven by its poll secret.
async function lockAsCli(tx: Database, enrollmentId: string, pollSecret: string) {
  const row = await lockEnrollment(tx, enrollmentId);
  if (!sameHash(pollSecretHash(fromBase64(pollSecret)), row.pollSecretHash)) {
    throw new ContentError('not-found');
  }
  return row;
}

/**
 * Where an enrollment is, for its CLI. Once claimed, the person who
 * claimed it; once approved, the sealed token, exactly once: the poll that
 * returns it moves the enrollment to `delivered` and deletes it.
 */
export async function pollEnrollment(
  db: Database,
  input: { enrollmentId: string; pollSecret: string },
): Promise<z.input<typeof agentRoutes.pollEnrollment.response>> {
  return db.transaction(async (tx) => {
    const row = await lockAsCli(tx, input.enrollmentId, input.pollSecret);
    switch (row.state) {
      case 'requested':
        return { state: 'requested' };
      case 'claimed':
      case 'cli-confirmed': {
        const [person] = await tx
          .select({ identity: identities, name: users.name, email: users.email })
          .from(identities)
          .innerJoin(users, eq(users.id, identities.accountId))
          .where(
            and(
              eq(identities.id, row.ownerIdentityId ?? ''),
              eq(identities.keyVersion, row.ownerKeyVersion ?? 0),
            ),
          );
        if (!person) throw new ContentError('not-found');
        return {
          state: row.state,
          person: PublicIdentity.parse({
            id: person.identity.id,
            kind: person.identity.kind,
            keyVersion: person.identity.keyVersion,
            boxPublicKey: person.identity.boxPublicKey,
            signPublicKey: person.identity.signPublicKey,
          }),
          name: person.name,
          email: person.email,
        };
      }
      case 'approved': {
        if (!row.credentialId || !row.sealedToken) throw new Error('approved without a token');
        await tx
          .update(agentEnrollments)
          .set({ state: 'delivered', sealedToken: null })
          .where(eq(agentEnrollments.id, row.id));
        return { state: 'approved', credentialId: row.credentialId, sealedToken: row.sealedToken };
      }
      default:
        return { state: row.state };
    }
  });
}

/**
 * Step 4: the CLI's user saw the fingerprint the person sees, for the
 * agent ID derived from the claimed person and the posted keys.
 */
export async function confirmEnrollment(
  db: Database,
  input: { enrollmentId: string; pollSecret: string; agentId: string },
) {
  await db.transaction(async (tx) => {
    const row = await lockAsCli(tx, input.enrollmentId, input.pollSecret);
    if (row.state !== 'claimed' || !row.ownerIdentityId) {
      throw new ContentError('enrollment-state', 'The enrollment is not waiting for you');
    }
    const { installationId } = await readSettings(tx);
    const agentId = agentIdentityId({
      installationId: InstallationId.parse(installationId),
      ownerId: PublicIdentity.shape.id.parse(row.ownerIdentityId),
      boxPublicKey: row.boxPublicKey,
      signPublicKey: row.signPublicKey,
    });
    if (agentId !== input.agentId) {
      throw new ContentError('binding-mismatch', 'That agent ID is not this enrollment’s');
    }
    await tx
      .update(agentEnrollments)
      .set({ state: 'cli-confirmed', agentId, confirmedAt: sql`now()` })
      .where(eq(agentEnrollments.id, row.id));
  });
}

/** Either side gives up: the CLI with its poll secret, or the person who claimed it. */
export async function cancelEnrollment(
  db: Database,
  input: { enrollmentId: string; pollSecret: string },
) {
  await db.transaction(async (tx) => {
    const row = await lockAsCli(tx, input.enrollmentId, input.pollSecret);
    await endOpen(tx, row, 'cancelled');
  });
}

async function endOpen(tx: Database, row: Enrollment, state: 'cancelled' | 'rejected') {
  if (row.state !== 'requested' && row.state !== 'claimed' && row.state !== 'cli-confirmed') {
    throw new ContentError('enrollment-state', 'The enrollment has ended');
  }
  await tx.update(agentEnrollments).set({ state }).where(eq(agentEnrollments.id, row.id));
}

// Count one failed claim against `key`; whether it was still within the limit.
const countFailure = async (db: Database, key: string, max: number) =>
  (await consumeRateLimit(db, key, { windowMs: CLAIM_LIMITS.windowMs, max })).allowed;

/**
 * Step 2: the person types the lookup code. A code works once, only while
 * its enrollment is open and unclaimed; the enrollment is bound to the
 * claimer's account and current human identity. Every claim counts against
 * the claimer's failed-claim limit first, then, only while the claimer is
 * within it, the installation's, and is handed back only if it succeeds, so
 * a burst of guesses can't pass them. An account past its own limit costs
 * the installation nothing, so one account can't lock everyone out.
 */
export async function claimEnrollment(
  db: Database,
  input: { accountId: string; lookupCode: string },
) {
  const identity = await requireIdentity(db, input.accountId);
  const keys = [
    { key: `agent-claim account:${input.accountId}`, max: CLAIM_LIMITS.perAccount },
    { key: 'agent-claim installation', max: CLAIM_LIMITS.installation },
  ];
  for (const { key, max } of keys) {
    if (!(await countFailure(db, key, max))) {
      throw new ContentError('busy', 'Too many wrong codes; wait a few minutes');
    }
  }
  const normalized = normalizeLookupCode(input.lookupCode);
  const claimed = /^[0-9A-HJKMNP-TV-Z]{8}$/.test(normalized)
    ? await db
        .update(agentEnrollments)
        .set({
          state: 'claimed',
          ownerAccountId: input.accountId,
          ownerIdentityId: identity.id,
          ownerKeyVersion: identity.keyVersion,
        })
        .where(
          and(
            eq(agentEnrollments.lookupCodeHash, lookupCodeHash(normalized)),
            eq(agentEnrollments.state, 'requested'),
            gt(agentEnrollments.expiresAt, sql`now()`),
          ),
        )
        .returning()
    : [];
  const [row] = claimed;
  if (!row) throw new ContentError('not-found', 'No open enrollment has that code');
  // A successful claim isn't a failure: hand its count back.
  await db
    .update(appRateLimits)
    .set({ count: sql`greatest(${appRateLimits.count} - 1, 0)` })
    .where(
      inArray(
        appRateLimits.key,
        keys.map(({ key }) => key),
      ),
    );
  return {
    enrollmentId: row.id,
    boxPublicKey: row.boxPublicKey,
    signPublicKey: row.signPublicKey,
    expiresAt: row.expiresAt.toISOString(),
  };
}

// An enrollment the caller claimed, locked.
async function lockAsClaimer(tx: Database, accountId: string, enrollmentId: string) {
  const row = await lockEnrollment(tx, enrollmentId);
  if (row.ownerAccountId !== accountId) throw new ContentError('not-found');
  return row;
}

/** Where an enrollment the caller claimed is. */
export async function enrollmentState(
  db: Database,
  input: { accountId: string; enrollmentId: string },
) {
  return db.transaction(async (tx) => {
    const row = await lockAsClaimer(tx, input.accountId, input.enrollmentId);
    if (row.state === 'requested') throw new ContentError('not-found');
    return { state: row.state, expiresAt: row.expiresAt.toISOString() };
  });
}

/** The person saw fingerprints that don't match: the enrollment ends. */
export async function rejectEnrollment(
  db: Database,
  input: { accountId: string; enrollmentId: string },
) {
  await db.transaction(async (tx) => {
    const row = await lockAsClaimer(tx, input.accountId, input.enrollmentId);
    await endOpen(tx, row, 'rejected');
  });
}

/**
 * Step 5: the person approves, signing the enrollment with their current
 * key, naming the agent, and granting it picks in shares with their keys
 * sealed to it. The CLI must have confirmed, and the enrollment must still
 * be open. Makes the agent's identity, profile, credential and grants, and
 * keeps the token only sealed to the agent until its CLI collects it.
 */
export async function approveEnrollment(
  db: Database,
  input: {
    accountId: string;
    enrollmentId: string;
    enrollment: AgentEnrollment;
    name: string;
    grants: readonly Grant[];
    envelopes: readonly FolderKeyEnvelope[];
  },
) {
  return db.transaction(async (tx) => {
    const person = await requireIdentity(tx, input.accountId);
    const row = await lockAsClaimer(tx, input.accountId, input.enrollmentId);
    if (row.state !== 'cli-confirmed' || !row.agentId) {
      throw new ContentError('enrollment-state', 'The enrollment is not waiting for approval');
    }
    if (row.ownerIdentityId !== person.id || row.ownerKeyVersion !== person.keyVersion) {
      throw new ContentError('binding-mismatch', 'Your key changed since you claimed the code');
    }
    const { installationId } = await readSettings(tx);
    const { enrollment } = input;
    try {
      verifyEnrollment({
        installationId: InstallationId.parse(installationId),
        owner: person,
        enrollment,
      });
    } catch (error) {
      if (!(error instanceof CryptoError)) throw error;
      throw new ContentError(
        error.code === 'bad-signature' ? 'bad-signature' : 'binding-mismatch',
        error.message,
      );
    }
    const { agent } = enrollment;
    if (
      agent.id !== row.agentId ||
      agent.boxPublicKey !== row.boxPublicKey ||
      agent.signPublicKey !== row.signPublicKey
    ) {
      throw new ContentError('binding-mismatch', 'The enrollment is for other keys');
    }
    await requireFreshName(tx, input.accountId, input.name);

    await tx.insert(identities).values({
      id: agent.id,
      keyVersion: 1,
      accountId: input.accountId,
      kind: 'agent',
      boxPublicKey: agent.boxPublicKey,
      signPublicKey: agent.signPublicKey,
    });
    await tx.insert(agentProfiles).values({
      agentId: agent.id,
      accountId: input.accountId,
      ownerIdentityId: person.id,
      ownerKeyVersion: person.keyVersion,
      name: input.name,
      enrollment,
    });
    await grantAll(
      tx,
      { person, accountId: input.accountId, agent, grants: input.grants },
      input.envelopes,
    );
    const { token, credentialId, storedHash } = newAgentToken();
    await tx.insert(agentCredentials).values({
      id: credentialId,
      agentId: agent.id,
      accountId: input.accountId,
      tokenHash: toBase64(storedHash),
    });
    await tx
      .update(agentEnrollments)
      .set({ state: 'approved', credentialId, sealedToken: sealKeyTo(utf8(token), agent) })
      .where(eq(agentEnrollments.id, row.id));
    await audit(tx, {
      actor: input.accountId,
      action: 'agent.enrolled',
      target: { kind: 'agent', id: agent.id },
      details: { shares: input.grants.map((grant) => grant.shareId) },
    });
    return { agentId: agent.id };
  });
}

// Agent names are distinct among a person's live agents.
async function requireFreshName(tx: Database, accountId: string, name: string) {
  const [taken] = await tx
    .select({ id: agentProfiles.agentId })
    .from(agentProfiles)
    .innerJoin(
      identities,
      and(eq(identities.id, agentProfiles.agentId), eq(identities.keyVersion, 1)),
    )
    .where(
      and(
        eq(agentProfiles.accountId, accountId),
        eq(agentProfiles.name, name),
        isNull(identities.revokedAt),
      ),
    );
  if (taken) throw new ContentError('duplicate', 'Another of your agents has that name');
}

/**
 * Grants in shares the person holds, each with every key version of its
 * share sealed to the agent by the person, and nothing else.
 */
async function grantAll(
  tx: Database,
  who: {
    person: PublicIdentity;
    accountId: string;
    agent: PublicIdentity;
    grants: readonly Grant[];
  },
  envelopes: readonly FolderKeyEnvelope[],
) {
  const shareIds = who.grants.map((grant) => grant.shareId);
  if (new Set(shareIds).size !== shareIds.length) {
    throw new ContentError('recipients-mismatch', 'A share is picked twice');
  }
  if (envelopes.some((envelope) => !shareIds.includes(envelope.shareId))) {
    throw new ContentError('recipients-mismatch', 'Keys must go only with the shares picked');
  }
  for (const grant of who.grants) {
    const share = await lockShareRow(tx, grant.shareId);
    await putGrant(tx, {
      ...who,
      share,
      grant,
      envelopes: envelopes.filter((envelope) => envelope.shareId === grant.shareId),
    });
  }
}

async function lockShareRow(tx: Database, shareId: string): Promise<ShareRow> {
  const [share] = await tx.select().from(shares).where(eq(shares.id, shareId)).for('share');
  if (!share) throw new ContentError('not-found');
  return share;
}

/**
 * Check one grant against the person's own access in its share (section
 * 9.4) and store it, with the agent's envelopes there replaced by
 * `envelopes`: versions 1 to current, sealed by the person, with the draft
 * key exactly for an editor pick. A pick is a folder at or under the
 * share's root, or the whole share.
 */
async function putGrant(
  tx: Database,
  input: {
    person: PublicIdentity;
    accountId: string;
    agent: PublicIdentity;
    share: ShareRow;
    grant: { folderId: string | null; role: 'reader' | 'editor'; canPublish: boolean };
    envelopes: readonly FolderKeyEnvelope[];
  },
) {
  const { share, grant } = input;
  const own = await personAccess(tx, input.person.id, share);
  if (!own) throw new ContentError('not-found');
  requireWithin(grant, own);
  if (grant.folderId !== null) await requirePickable(tx, share, grant.folderId);
  await checkFolderEnvelopes(tx, input.envelopes, {
    spaceId: share.spaceId,
    shareId: share.id,
    sealer: input.person,
    expected: Array.from({ length: share.currentKeyVersion }, (_, i) => ({
      recipientId: input.agent.id,
      recipientKeyVersion: 1,
      keyVersion: i + 1,
      drafts: grant.role === 'editor',
    })),
  });
  await tx
    .delete(folderKeyEnvelopes)
    .where(
      and(
        eq(folderKeyEnvelopes.shareId, share.id),
        eq(folderKeyEnvelopes.recipientIdentityId, input.agent.id),
      ),
    );
  await storeFolderEnvelopes(tx, input.envelopes);
  const row = { folderId: grant.folderId, role: grant.role, canPublish: grant.canPublish };
  await tx
    .insert(agentGrants)
    .values({
      agentId: input.agent.id,
      shareId: share.id,
      spaceId: share.spaceId,
      grantedBy: input.accountId,
      ...row,
    })
    .onConflictDoUpdate({ target: [agentGrants.agentId, agentGrants.shareId], set: row });
}

// A grant is never more than its person can do there.
function requireWithin(grant: Pick<Grant, 'role' | 'canPublish'>, own: Access) {
  if ((grant.role === 'editor' && own.role === 'reader') || (grant.canPublish && !own.canPublish)) {
    throw new ContentError('forbidden', 'An agent can’t do more than you can there');
  }
}

// A folder of the share's space at or under the share's root.
async function requirePickable(tx: Database, share: ShareRow, folderId: string) {
  const [folder] = await tx
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, folderId), eq(nodes.spaceId, share.spaceId), eq(nodes.kind, 'folder')));
  if (!folder) throw new ContentError('not-found');
  if (share.rootId === null) return;
  const rows = await tx.execute<{ id: string }>(sql`
    ${ancestorsOf(share.spaceId, folderId)}
    select id from ancestors where id = ${share.rootId} limit 1`);
  if ([...rows].length === 0) throw new ContentError('not-found', 'That folder isn’t in the share');
}

// One of the caller's own agents, live, as an identity, locked against a
// revocation meanwhile unless only read.
async function requireOwnAgent(
  tx: Database,
  accountId: string,
  agentId: string,
  { lock = true }: { lock?: boolean } = {},
) {
  const query = tx
    .select({ identity: identities })
    .from(identities)
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, identities.id))
    .where(
      and(
        eq(identities.id, agentId),
        eq(identities.keyVersion, 1),
        eq(agentProfiles.accountId, accountId),
        isNull(identities.revokedAt),
      ),
    );
  const [row] = lock ? await query.for('update', { of: identities }) : await query;
  if (!row) throw new ContentError('not-found');
  return PublicIdentity.parse({
    id: row.identity.id,
    kind: row.identity.kind,
    keyVersion: row.identity.keyVersion,
    boxPublicKey: row.identity.boxPublicKey,
    signPublicKey: row.identity.signPublicKey,
  });
}

/**
 * Agents made for a share when a person's pick in the owner region becomes
 * a share (section 9.4): each one theirs and live, at most editor, with
 * version 1 sealed to it by them, which the caller checks with the rest.
 */
export async function requireOwnAgents(
  tx: Database,
  accountId: string,
  grants: readonly { agentId: string }[],
): Promise<PublicIdentity[]> {
  const ids = grants.map((grant) => grant.agentId);
  if (new Set(ids).size !== ids.length) {
    throw new ContentError('recipients-mismatch', 'An agent is listed twice');
  }
  const agents: PublicIdentity[] = [];
  for (const id of ids) agents.push(await requireOwnAgent(tx, accountId, id));
  return agents;
}

/** Store the grants of a share just made, checked by `makeShare`. */
export async function storeNewShareGrants(
  tx: Database,
  share: ShareRow,
  accountId: string,
  grants: readonly {
    agentId: string;
    folderId: string | null;
    role: 'reader' | 'editor';
    canPublish: boolean;
  }[],
) {
  for (const grant of grants) {
    if (grant.folderId !== null) await requirePickable(tx, share, grant.folderId);
  }
  if (grants.length === 0) return;
  await tx.insert(agentGrants).values(
    grants.map((grant) => ({
      agentId: grant.agentId,
      shareId: share.id,
      spaceId: share.spaceId,
      folderId: grant.folderId,
      role: grant.role,
      canPublish: grant.canPublish,
      grantedBy: accountId,
    })),
  );
}

/** Grant the caller's agent a pick in a share, or change its role there. */
export async function putAgentGrant(
  db: Database,
  input: {
    accountId: string;
    agentId: string;
    shareId: string;
    folderId: string | null;
    role: 'reader' | 'editor';
    canPublish: boolean;
    envelopes: readonly FolderKeyEnvelope[];
  },
) {
  await db.transaction(async (tx) => {
    const person = await requireIdentity(tx, input.accountId);
    const agent = await requireOwnAgent(tx, input.accountId, input.agentId);
    const share = await lockShareRow(tx, input.shareId);
    await putGrant(tx, {
      person,
      accountId: input.accountId,
      agent,
      share,
      grant: input,
      envelopes: input.envelopes,
    });
    await audit(tx, {
      actor: input.accountId,
      action: 'agent.granted',
      target: { kind: 'agent', id: agent.id },
      details: { shareId: share.id, role: input.role, canPublish: input.canPublish },
    });
  });
}

/** Remove the caller's agent's pick in a share. It keeps the keys it had (A6). */
export async function deleteAgentGrant(
  db: Database,
  input: { accountId: string; agentId: string; shareId: string },
) {
  await db.transaction(async (tx) => {
    await requireOwnAgent(tx, input.accountId, input.agentId);
    const removed = await tx
      .delete(agentGrants)
      .where(and(eq(agentGrants.agentId, input.agentId), eq(agentGrants.shareId, input.shareId)))
      .returning({ shareId: agentGrants.shareId });
    if (removed.length === 0) throw new ContentError('not-found');
    await audit(tx, {
      actor: input.accountId,
      action: 'agent.grant-removed',
      target: { kind: 'agent', id: input.agentId },
      details: { shareId: input.shareId },
    });
  });
}

/**
 * Whether an agent gets draft keys in a share: some grant there is for an
 * editor, and its person isn't only a reader there (section 9.5).
 */
const editsThere = (grants: readonly AgentGrant[], own: Access) =>
  grants.some((grant) => grant.role === 'editor') && own.role !== 'reader';

/**
 * The key versions of a share the agent holds as it needs them: any
 * envelope, or for an editor, one with the draft key. A version held
 * without it, where the agent now edits (a group's access raised), is
 * sealed again.
 */
async function versionsHeld(tx: Database, shareId: string, agentId: string, editor: boolean) {
  const rows = await tx
    .select({ keyVersion: folderKeyEnvelopes.keyVersion, drafts: folderKeyEnvelopes.drafts })
    .from(folderKeyEnvelopes)
    .where(
      and(
        eq(folderKeyEnvelopes.shareId, shareId),
        eq(folderKeyEnvelopes.recipientIdentityId, agentId),
      ),
    );
  return {
    held: new Set(rows.flatMap((row) => (row.drafts || !editor ? [row.keyVersion] : []))),
    any: new Set(rows.map((row) => row.keyVersion)),
  };
}

// The shares an agent has grants in, by its picks and confirmed groups.
async function grantedShares(tx: Database, agentId: string, shareIds?: readonly string[]) {
  const grants = await agentGrantsOf(tx, {
    agentIds: [agentId],
    ...(shareIds ? { shareIds } : {}),
  });
  const rows =
    grants.length === 0
      ? []
      : await tx
          .select()
          .from(shares)
          .where(
            inArray(
              shares.id,
              grants.map((grant) => grant.shareId),
            ),
          )
          .orderBy(shares.id);
  return rows.map((share) => ({
    share,
    grants: grants.filter((grant) => grant.shareId === share.id),
  }));
}

/**
 * Key versions the agent lacks in the shares it has a grant in (section
 * 9.4), through a pick or a group its person confirmed, for its person's
 * app to seal at unlock. Only shares its person can still reach: they hold
 * nothing newer of any other.
 */
export async function missingVersions(db: Database, input: { accountId: string; agentId: string }) {
  const person = await requireIdentity(db, input.accountId);
  // Only read: the person's app seals what is missing in a write of its own.
  const agent = await requireOwnAgent(db, input.accountId, input.agentId, { lock: false });
  const missing = [];
  for (const { share, grants } of await grantedShares(db, agent.id)) {
    const own = await personAccess(db, person.id, share);
    if (!own) continue;
    const { held } = await versionsHeld(db, share.id, agent.id, editsThere(grants, own));
    const keyVersions = Array.from({ length: share.currentKeyVersion }, (_, i) => i + 1).filter(
      (version) => !held.has(version),
    );
    if (keyVersions.length > 0) {
      missing.push({ spaceId: share.spaceId, shareId: share.id, keyVersions });
    }
  }
  return missing;
}

/**
 * Key versions the agent lacked, sealed to it by its person (section 6.4):
 * each in a share it has a grant in that its person can still reach, at a
 * version up to the current one it holds no envelope for, or holds without
 * the draft key it now needs, with the draft key exactly when the agent
 * may edit there now. Those replace the envelopes it held.
 */
export async function addAgentEnvelopes(
  db: Database,
  input: { accountId: string; agentId: string; envelopes: readonly FolderKeyEnvelope[] },
) {
  await db.transaction(async (tx) => {
    const person = await requireIdentity(tx, input.accountId);
    const agent = await requireOwnAgent(tx, input.accountId, input.agentId);
    const byShare = Map.groupBy(input.envelopes, (envelope) => envelope.shareId);
    for (const [shareId, envelopes] of byShare) {
      const share = await lockShareRow(tx, shareId);
      const grants = await agentGrantsOf(tx, { agentIds: [agent.id], shareIds: [shareId] });
      const own = grants.length > 0 ? await personAccess(tx, person.id, share) : null;
      if (!own) throw new ContentError('not-found');
      const editor = editsThere(grants, own);
      const { held, any } = await versionsHeld(tx, shareId, agent.id, editor);
      const versions = envelopes.map((envelope) => envelope.keyVersion);
      if (versions.some((v) => v > share.currentKeyVersion || held.has(v))) {
        throw new ContentError('stale-head', 'The agent holds that version, or it doesn’t exist');
      }
      await checkFolderEnvelopes(tx, envelopes, {
        spaceId: share.spaceId,
        shareId,
        sealer: person,
        expected: versions.map((keyVersion) => ({
          recipientId: agent.id,
          recipientKeyVersion: 1,
          keyVersion,
          drafts: editor,
        })),
      });
      const replaced = versions.filter((v) => any.has(v));
      if (replaced.length > 0) {
        await tx
          .delete(folderKeyEnvelopes)
          .where(
            and(
              eq(folderKeyEnvelopes.shareId, shareId),
              eq(folderKeyEnvelopes.recipientIdentityId, agent.id),
              inArray(folderKeyEnvelopes.keyVersion, replaced),
            ),
          );
      }
      await storeFolderEnvelopes(tx, envelopes);
    }
  });
}

/**
 * The groups the caller's live agents are in (section 9.4), each with the
 * shares it has and its access there, and whether the person confirmed it:
 * their Agents page shows each one to confirm, or to take the agent out.
 * The group's name is the owners' alone.
 */
export async function listAgentGroups(db: Database, accountId: string) {
  const rows = await db
    .select({
      agentId: groupMembers.identityId,
      groupId: groupMembers.groupId,
      spaceId: groups.spaceId,
      drafts: groupMembers.agentDrafts,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(agentProfiles, eq(agentProfiles.agentId, groupMembers.identityId))
    .innerJoin(
      identities,
      and(eq(identities.id, agentProfiles.agentId), eq(identities.keyVersion, 1)),
    )
    .where(and(eq(agentProfiles.accountId, accountId), isNull(identities.revokedAt)))
    .orderBy(groupMembers.identityId, groupMembers.groupId);
  const held =
    rows.length === 0
      ? []
      : await db
          .select()
          .from(shareGroups)
          .where(
            inArray(
              shareGroups.groupId,
              rows.map((row) => row.groupId),
            ),
          )
          .orderBy(shareGroups.shareId);
  return rows.map(({ drafts, ...row }) => ({
    ...row,
    confirmed: drafts !== null,
    drafts: drafts === true,
    shares: held
      .filter((g) => g.groupId === row.groupId)
      .map(({ shareId, role, canPublish }) => ({ shareId, role, canPublish })),
  }));
}

// The caller's agent's place in a group, with the group's space held
// against owners' changes to it until the transaction ends.
async function lockAgentGroup(tx: Database, input: { groupId: string }) {
  const [group] = await tx.select().from(groups).where(eq(groups.id, input.groupId));
  if (!group) throw new ContentError('not-found');
  await lockSpace(tx, group.spaceId);
  return group;
}

/**
 * The person confirms a group an owner put their agent in (section 9.4),
 * after recording it in their contacts record: from now on the agent has
 * the group's shares, whole, at the group's access (as a reader without
 * `drafts`), capped by the person's own. Their app seals it the keys.
 */
export async function confirmAgentGroup(
  db: Database,
  input: { accountId: string; agentId: string; groupId: string; drafts: boolean },
) {
  await db.transaction(async (tx) => {
    const agent = await requireOwnAgent(tx, input.accountId, input.agentId);
    const group = await lockAgentGroup(tx, input);
    const confirmed = await tx
      .update(groupMembers)
      .set({ agentDrafts: input.drafts })
      .where(and(eq(groupMembers.groupId, group.id), eq(groupMembers.identityId, agent.id)))
      .returning({ id: groupMembers.identityId });
    if (confirmed.length === 0) throw new ContentError('not-found', 'Not in that group');
    await audit(tx, {
      actor: input.accountId,
      action: 'agent.group-confirmed',
      target: { kind: 'agent', id: agent.id },
      details: { groupId: group.id, drafts: input.drafts },
    });
  });
}

/**
 * The person takes their agent out of a group, confirmed or not. It keeps
 * the keys it had (A6); the group's owners see it among the agents holding
 * keys with no grant, and can rotate them.
 */
export async function leaveAgentGroup(
  db: Database,
  input: { accountId: string; agentId: string; groupId: string },
) {
  await db.transaction(async (tx) => {
    const agent = await requireOwnAgent(tx, input.accountId, input.agentId);
    const group = await lockAgentGroup(tx, input);
    const left = await tx
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, group.id), eq(groupMembers.identityId, agent.id)))
      .returning({ id: groupMembers.identityId });
    if (left.length === 0) throw new ContentError('not-found', 'Not in that group');
    await audit(tx, {
      actor: input.accountId,
      action: 'agent.group-left',
      target: { kind: 'agent', id: agent.id },
      details: { groupId: group.id },
    });
  });
}

/** The caller's agents, revoked ones too, with their grants. */
export async function listAgents(db: Database, accountId: string) {
  const rows = await db
    .select({
      profile: agentProfiles,
      revokedAt: identities.revokedAt,
      // Recorded as it writes, so draft retention removing a version keeps it.
      lastEditAt: sql<Date | null>`(
        select max(${agentEdits.createdAt}) from ${agentEdits}
        where ${agentEdits.agentId} = ${agentProfiles.agentId})`.mapWith(agentEdits.createdAt),
    })
    .from(agentProfiles)
    .innerJoin(
      identities,
      and(eq(identities.id, agentProfiles.agentId), eq(identities.keyVersion, 1)),
    )
    .where(eq(agentProfiles.accountId, accountId))
    .orderBy(agentProfiles.createdAt);
  const grants =
    rows.length === 0
      ? []
      : await db
          .select()
          .from(agentGrants)
          .where(
            inArray(
              agentGrants.agentId,
              rows.map((row) => row.profile.agentId),
            ),
          )
          .orderBy(agentGrants.shareId);
  return rows.map(({ profile, revokedAt, lastEditAt }) => ({
    agentId: profile.agentId,
    name: profile.name,
    enrolledAt: profile.createdAt.toISOString(),
    revokedAt: revokedAt?.toISOString() ?? null,
    // A raw timestamp from the subquery, in Postgres's own text form.
    lastEditAt: lastEditAt?.toISOString() ?? null,
    grants: grants
      .filter((grant) => grant.agentId === profile.agentId)
      .map((grant) => ({
        shareId: grant.shareId,
        spaceId: grant.spaceId,
        folderId: grant.folderId,
        role: grant.role,
        canPublish: grant.canPublish,
      })),
  }));
}

/**
 * The person revokes their agent (section 9.7): its credentials and its
 * identity are revoked, so its token fails on its next request, and its
 * grants end. What it already holds stays with it (A6).
 */
export async function revokeAgent(db: Database, input: { accountId: string; agentId: string }) {
  await db.transaction(async (tx) => {
    await requireOwnAgent(tx, input.accountId, input.agentId);
    await tx
      .update(identities)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(identities.id, input.agentId), isNull(identities.revokedAt)));
    await tx
      .update(agentCredentials)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(agentCredentials.agentId, input.agentId), isNull(agentCredentials.revokedAt)));
    await tx.delete(agentGrants).where(eq(agentGrants.agentId, input.agentId));
    await audit(tx, {
      actor: input.accountId,
      action: 'agent.revoked',
      target: { kind: 'agent', id: input.agentId },
      details: {},
    });
  });
}

/**
 * End the grants of the agents of `personIds` in `shareIds`: their people
 * were removed from those shares, or as owners of their space (sections
 * 7.5 and 7.6).
 */
export async function endAgentGrants(
  tx: Database,
  { personIds, shareIds }: { personIds: readonly string[]; shareIds: readonly string[] },
) {
  if (personIds.length === 0 || shareIds.length === 0) return;
  await tx.delete(agentGrants).where(
    and(
      inArray(agentGrants.shareId, [...shareIds]),
      inArray(
        agentGrants.agentId,
        tx
          .select({ id: agentProfiles.agentId })
          .from(agentProfiles)
          .where(inArray(agentProfiles.ownerIdentityId, [...personIds])),
      ),
    ),
  );
}

/**
 * Every credential of the account made before now is dead, its agents are
 * revoked and lose their grants, and its open enrollments end (section
 * 9.7): an administrator revoking sessions and agents, a suspension, a role
 * change. Never undone. A password set or changed does the same through a
 * trigger on `accounts`, in the transaction that writes it; both run
 * `wikistow_revoke_agents` (migration 0007).
 */
export async function revokeAgentCredentials(tx: Database, accountId: string): Promise<void> {
  await tx.execute(sql`select wikistow_revoke_agents(${accountId}::uuid)`);
}

/** The agent behind a bearer token. */
export type AgentCredential = { accountId: string; agentId: string; credentialId: string };

/**
 * The checks of section 9.6 on a bearer token: its shape, its secret
 * compared by hash in constant time, a credential neither revoked nor made
 * before its account's `credentialsRevokedAt`, an account that isn't
 * suspended, and a live agent identity. Null for anything else; the caller
 * says only that the token doesn't work.
 */
export async function authenticateAgent(
  db: Database,
  token: string,
): Promise<AgentCredential | null> {
  let parsed: ReturnType<typeof parseAgentToken>;
  try {
    parsed = parseAgentToken(token);
  } catch (error) {
    if (error instanceof CryptoError) return null;
    throw error;
  }
  const [row] = await db
    .select({ credential: agentCredentials })
    .from(agentCredentials)
    .innerJoin(users, eq(users.id, agentCredentials.accountId))
    .innerJoin(
      identities,
      and(eq(identities.id, agentCredentials.agentId), eq(identities.keyVersion, 1)),
    )
    .where(
      and(
        eq(agentCredentials.id, parsed.credentialId),
        isNull(agentCredentials.revokedAt),
        isNull(users.suspendedAt),
        eq(users.emailVerified, true),
        isNull(identities.revokedAt),
        eq(identities.accountId, agentCredentials.accountId),
        or(
          isNull(users.credentialsRevokedAt),
          gt(agentCredentials.createdAt, users.credentialsRevokedAt),
        ),
      ),
    );
  if (!row || !agentTokenMatches(parsed, fromBase64(row.credential.tokenHash))) return null;
  return {
    accountId: row.credential.accountId,
    agentId: row.credential.agentId,
    credentialId: row.credential.id,
  };
}
