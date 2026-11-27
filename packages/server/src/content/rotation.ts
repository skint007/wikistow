// Replacing a person's identity keys (protocol section 4.6, #327): the
// rotate route's one transaction, and the statements and earlier keys it
// serves.
import {
  InstallationId,
  PublicIdentity,
  SignedContactsRecord,
  type AgentEnrollment,
  type IdentityRotation,
  type SealedContacts,
  VaultWrapper,
  type VaultWrapperV2,
} from '@wikistow/contracts';
import {
  contactsHash,
  CryptoError,
  identityRotationBytes,
  parseIdentityRotation,
  verifyEnrollment,
  verifyIdentityRotation,
} from '@wikistow/client';
import { and, asc, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { audit } from '../admin/audit.ts';
import type { Database } from '../db/client.ts';
import {
  agentCredentials,
  agentEnrollments,
  agentGrants,
  agentProfiles,
  contactsRecords,
  identities,
  identityRotations,
  liveSessions,
  pageHeads,
  sessions,
  shareMembers,
  shares,
  spaceOwners,
  users,
  vaultWrappers,
} from '../db/schema/index.ts';
import { readSettings } from '../settings.ts';
import { appendContacts, contactsHead } from './contacts.ts';
import { ContentError } from './errors.ts';
import { currentIdentity, lockKeysForRotation } from './identities.ts';
import { queueWriter } from './quota.ts';
import { checkKdf, type KdfParams } from './vault.ts';

/**
 * The body a contacts write may carry (`JSON_BODY_LIMIT`, apps/server):
 * the first version at the new key must fit it, or every later write of
 * the record would fail, though the rotate route takes a larger body.
 */
const CONTACTS_BODY = 1024 * 1024;

export type RotateIdentity = {
  rotation: IdentityRotation;
  identity: PublicIdentity;
  wrapper: VaultWrapperV2;
  expectedVaultVersion: number;
  contacts: SealedContacts;
  enrollments: readonly AgentEnrollment[];
  keptAgents: readonly string[];
  revokedAgents: readonly string[];
};

/**
 * Replace the caller's identity keys, in one transaction under the lock
 * every signed write of theirs holds (`holdKeys`): check the statement
 * against their current key, and everything else the request carries
 * against it, then store the new key, the statement, the new vault, the
 * first contacts version at the new key and the kept agents' enrollments,
 * revoke the other agents and their old row, end the account's other
 * sessions, and end the live sessions in every space the person owns or is
 * a member of. The first statement stored for a key version wins: the same
 * one sent again, after a lost answer, is answered as accepted, and any
 * other is `rotation-exists`.
 */
export async function rotateIdentity(
  db: Database,
  input: RotateIdentity & {
    accountId: string;
    /** The session that sent it, which alone stays signed in. */
    sessionId: string;
    minKdf: KdfParams;
    storageBytes: number;
  },
): Promise<{ vaultVersion: number; contactsVersion: number }> {
  return db.transaction(async (tx) => {
    // Before anything else that waits, as `holdKeys` is taken.
    await lockKeysForRotation(tx, input.accountId);
    const writer = await queueWriter(tx, input.accountId);
    const { rotation } = input;
    // As Postgres stores key versions, in an `integer`.
    if (rotation.to.keyVersion > 2_147_483_647) {
      throw new ContentError('invalid-request', 'That key version is out of range');
    }
    const again = await sentBefore(tx, input);
    if (again) return again;

    const current = await currentIdentity(tx, input.accountId);
    if (!current) throw new ContentError('vault-missing', 'Set up your vault first');
    if (rotation.id !== current.id || rotation.from.keyVersion !== current.keyVersion) {
      throw new ContentError('binding-mismatch', 'The rotation names another key');
    }
    // Row locks in this order: the person's current row, which a write
    // sealing to them holds (`lookupIdentities`), then the account's, then
    // its agents' rows, as `wikistow_revoke_agents` takes the account's
    // before its agents'.
    await tx
      .select({ id: identities.id })
      .from(identities)
      .where(and(eq(identities.id, current.id), eq(identities.keyVersion, current.keyVersion)))
      .for('update');
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.accountId))
      .for('update');
    const { installationId } = await readSettings(tx);
    const next = asCrypto(() =>
      verifyIdentityRotation({
        installationId: InstallationId.parse(installationId),
        from: current,
        statement: parseIdentityRotation(rotation),
      }),
    );
    if (!sameIdentity(next, input.identity)) {
      throw new ContentError('binding-mismatch', 'The identity is not the rotation’s new key');
    }
    await requireUnusedKeys(tx, next);

    const head = await contactsHead(tx, input.accountId);
    const named = rotation.contacts;
    const namesHead =
      named === null
        ? head === null
        : head !== null &&
          head.version === named.version &&
          head.contactsHash === named.contactsHash;
    if (!namesHead) {
      throw new ContentError('stale-head', 'Your contacts changed on another device');
    }

    // What later contacts writes carry must still fit their body.
    const later = Buffer.byteLength(
      JSON.stringify({ expectedVersion: input.contacts.record.version, record: input.contacts }),
    );
    if (later > CONTACTS_BODY) {
      throw new ContentError('too-large', 'Your contacts record is too large to replace your keys');
    }

    if (input.wrapper.accountId !== input.accountId) {
      throw new ContentError('binding-mismatch', 'Vault belongs to another account');
    }
    checkKdf(input.wrapper.passphrase.kdf, input.minKdf);
    const [vault] = await tx
      .select({ version: vaultWrappers.version })
      .from(vaultWrappers)
      .where(eq(vaultWrappers.accountId, input.accountId))
      .for('update');
    if (!vault) throw new ContentError('vault-missing');
    if (vault.version !== input.expectedVaultVersion) {
      throw new ContentError('stale-vault-version');
    }

    const kept = await checkAgents(tx, input, next, installationId);

    await tx
      .update(identities)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(identities.id, current.id), eq(identities.keyVersion, current.keyVersion)));
    await tx.insert(identities).values({
      id: next.id,
      keyVersion: next.keyVersion,
      accountId: input.accountId,
      kind: 'human',
      boxPublicKey: next.boxPublicKey,
      signPublicKey: next.signPublicKey,
    });
    await tx.insert(identityRotations).values({
      identityId: current.id,
      fromKeyVersion: current.keyVersion,
      statement: rotation,
    });
    await tx
      .update(vaultWrappers)
      .set({ wrapper: input.wrapper, version: vault.version + 1, updatedAt: sql`now()` })
      .where(eq(vaultWrappers.accountId, input.accountId));
    const { version: contactsVersion } = await appendContacts(tx, writer, {
      accountId: input.accountId,
      owner: next,
      expectedVersion: head?.version ?? 0,
      record: input.contacts,
      storageBytes: input.storageBytes,
    });

    for (const enrollment of kept) {
      await tx
        .update(agentProfiles)
        .set({ enrollment, ownerKeyVersion: next.keyVersion })
        .where(eq(agentProfiles.agentId, enrollment.agent.id));
    }
    await revokeAgents(tx, input.accountId, input.revokedAgents);
    // Codes claimed at the old key would only fail at approval.
    await tx
      .update(agentEnrollments)
      .set({ state: 'cancelled' })
      .where(
        and(
          eq(agentEnrollments.ownerAccountId, input.accountId),
          inArray(agentEnrollments.state, ['claimed', 'cli-confirmed']),
        ),
      );

    // The account's other sessions end, and a desktop sign-in approved
    // before now is refused (`desktopApprovalStands`): one waiting on the
    // account's row finds it marked. The clock now, not at the start of this
    // transaction, which may have waited on locks while one was approved.
    await tx
      .update(users)
      .set({ sessionsEndedAt: sql`clock_timestamp()` })
      .where(eq(users.id, input.accountId));
    const signedOut = await tx
      .delete(sessions)
      .where(and(eq(sessions.userId, input.accountId), ne(sessions.id, input.sessionId)))
      .returning({ id: sessions.id });
    const liveEnded = await endLiveSessions(tx, current.id);

    await audit(tx, {
      actor: input.accountId,
      action: 'identity.rotated',
      target: { kind: 'account', id: input.accountId },
      details: {
        fromKeyVersion: current.keyVersion,
        keptAgents: kept.length,
        revokedAgents: input.revokedAgents.length,
        sessionsEnded: signedOut.length,
        liveSessionsEnded: liveEnded,
      },
    });
    return { vaultVersion: vault.version + 1, contactsVersion };
  });
}

/**
 * The answer to a request sent again after a lost answer: a statement for
 * this key version is stored, with the same signed bytes, and the vault and
 * contacts it stored are still the current ones. Any other stored statement
 * for that key version is `rotation-exists`. Checked before anything else.
 */
async function sentBefore(tx: Database, input: RotateIdentity & { accountId: string }) {
  const { rotation } = input;
  const [stored] = await tx
    .select({ statement: identityRotations.statement, accountId: identities.accountId })
    .from(identityRotations)
    .innerJoin(
      identities,
      and(
        eq(identities.id, identityRotations.identityId),
        eq(identities.keyVersion, identityRotations.fromKeyVersion),
      ),
    )
    .where(
      and(
        eq(identityRotations.identityId, rotation.id),
        eq(identityRotations.fromKeyVersion, rotation.from.keyVersion),
      ),
    );
  if (!stored) return null;
  // The version the rotation appended: the one its statement named, plus one.
  const appended = (rotation.contacts?.version ?? 0) + 1;
  if (input.contacts.record.version !== appended) {
    throw new ContentError('rotation-exists', 'These keys were already replaced');
  }
  const same =
    stored.accountId === input.accountId &&
    sameBytes(stored.statement, rotation) &&
    sameIdentity(input.identity, {
      id: rotation.id,
      kind: 'human',
      keyVersion: rotation.to.keyVersion,
      boxPublicKey: rotation.to.boxPublicKey,
      signPublicKey: rotation.to.signPublicKey,
    });
  if (!same) {
    throw new ContentError('rotation-exists', 'These keys were already replaced');
  }
  // The vault it stored, if nothing but a passphrase change replaced it since.
  const [vault] = await tx
    .select({ version: vaultWrappers.version, wrapper: vaultWrappers.wrapper })
    .from(vaultWrappers)
    .where(eq(vaultWrappers.accountId, input.accountId));
  const kept = vault ? VaultWrapper.safeParse(vault.wrapper) : null;
  const head = await contactsHead(tx, input.accountId);
  // The contacts version it stored, which names the agents it kept.
  const [written] = await tx
    .select({ sealed: contactsRecords.sealed })
    .from(contactsRecords)
    .where(
      and(
        eq(contactsRecords.accountId, input.accountId),
        eq(contactsRecords.version, input.contacts.record.version),
      ),
    );
  const storedSigned = written ? SignedContactsRecord.loose().safeParse(written.sealed) : null;
  const sameRecord =
    storedSigned?.success === true &&
    storedSigned.data.signature === input.contacts.signature &&
    contactsHash(storedSigned.data.record) === contactsHash(input.contacts.record);
  if (
    !vault ||
    !kept?.success ||
    !sameSealed(kept.data.keyring, input.wrapper.keyring) ||
    !sameSealed(kept.data.recovery, input.wrapper.recovery) ||
    !head ||
    !sameRecord
  ) {
    throw new ContentError('rotation-exists', 'These keys were already replaced');
  }
  return { vaultVersion: vault.version, contactsVersion: head.version };
}

const sameSealed = (
  a: { nonce: string; ciphertext: string },
  b: { nonce: string; ciphertext: string },
) => a.nonce === b.nonce && a.ciphertext === b.ciphertext;

// The same statement, signatures included: Ed25519 signs deterministically,
// so a request sent again carries exactly the stored ones.
function sameBytes(stored: unknown, sent: IdentityRotation): boolean {
  try {
    const kept = parseIdentityRotation(stored);
    const bytes = identityRotationBytes(kept);
    const sentBytes = identityRotationBytes(sent);
    return (
      kept.fromSignature === sent.fromSignature &&
      kept.toSignature === sent.toSignature &&
      bytes.length === sentBytes.length &&
      bytes.every((byte, i) => byte === sentBytes[i])
    );
  } catch {
    return false;
  }
}

const sameIdentity = (a: PublicIdentity, b: PublicIdentity) =>
  a.id === b.id &&
  a.kind === b.kind &&
  a.keyVersion === b.keyVersion &&
  a.boxPublicKey === b.boxPublicKey &&
  a.signPublicKey === b.signPublicKey;

function asCrypto<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (!(error instanceof CryptoError)) throw error;
    const code =
      error.code === 'bad-signature'
        ? 'bad-signature'
        : error.code === 'binding-mismatch'
          ? 'binding-mismatch'
          : 'invalid-request';
    throw new ContentError(code, error.message);
  }
}

/** Neither new public key is any row's, of any kind or person, checked key by key. */
async function requireUnusedKeys(tx: Database, next: PublicIdentity) {
  const [taken] = await tx
    .select({ id: identities.id })
    .from(identities)
    .where(
      or(
        inArray(identities.boxPublicKey, [next.boxPublicKey, next.signPublicKey]),
        inArray(identities.signPublicKey, [next.boxPublicKey, next.signPublicKey]),
      ),
    )
    .limit(1);
  if (taken) throw new ContentError('invalid-request', 'A new key is already in use');
}

/**
 * `keptAgents` and `revokedAgents` name, between them, exactly the
 * account's live agents, once each; `enrollments` holds one for each kept
 * agent and no other, signed with the new key, for exactly the agent's
 * stored keys. Answers the kept agents' enrollments.
 */
async function checkAgents(
  tx: Database,
  input: RotateIdentity & { accountId: string },
  next: PublicIdentity,
  installationId: string,
): Promise<AgentEnrollment[]> {
  const live = await tx
    .select({ identity: identities })
    .from(agentProfiles)
    .innerJoin(
      identities,
      and(eq(identities.id, agentProfiles.agentId), eq(identities.keyVersion, 1)),
    )
    .where(and(eq(agentProfiles.accountId, input.accountId), isNull(identities.revokedAt)))
    .for('update', { of: identities });
  const named = [...input.keptAgents, ...input.revokedAgents];
  const liveIds = new Set(live.map((row) => row.identity.id));
  if (
    new Set(named).size !== named.length ||
    named.length !== liveIds.size ||
    !named.every((id) => liveIds.has(id))
  ) {
    throw new ContentError('invalid-request', 'Name every live agent once, as kept or revoked');
  }
  const kept = new Set(input.keptAgents);
  const enrolled = new Set<string>(input.enrollments.map((e) => e.agent.id));
  if (
    enrolled.size !== input.enrollments.length ||
    enrolled.size !== kept.size ||
    ![...kept].every((id) => enrolled.has(id))
  ) {
    throw new ContentError('invalid-request', 'Send one enrollment for each kept agent');
  }
  const stored = new Map(live.map((row) => [row.identity.id, row.identity]));
  for (const enrollment of input.enrollments) {
    const agent = stored.get(enrollment.agent.id);
    const { agent: named } = enrollment;
    if (
      !agent ||
      named.kind !== 'agent' ||
      named.keyVersion !== agent.keyVersion ||
      named.boxPublicKey !== agent.boxPublicKey ||
      named.signPublicKey !== agent.signPublicKey
    ) {
      throw new ContentError('binding-mismatch', 'An enrollment is for other keys');
    }
    asCrypto(() =>
      verifyEnrollment({
        installationId: InstallationId.parse(installationId),
        owner: next,
        enrollment,
      }),
    );
  }
  return [...input.enrollments];
}

/** As `revokeAgent` does, for each one: its identity and credentials revoked, its grants ended. */
async function revokeAgents(tx: Database, accountId: string, agentIds: readonly string[]) {
  if (agentIds.length === 0) return;
  const ids = [...agentIds];
  await tx
    .update(identities)
    .set({ revokedAt: sql`now()` })
    .where(and(inArray(identities.id, ids), isNull(identities.revokedAt)));
  await tx
    .update(agentCredentials)
    .set({ revokedAt: sql`now()` })
    .where(and(inArray(agentCredentials.agentId, ids), isNull(agentCredentials.revokedAt)));
  await tx.delete(agentGrants).where(inArray(agentGrants.agentId, ids));
  for (const agentId of ids) {
    await audit(tx, {
      actor: accountId,
      action: 'agent.revoked',
      target: { kind: 'agent', id: agentId },
      details: {},
    });
  }
}

/**
 * End the open live sessions in every space where the person is an owner
 * or a member, as a change of access does (section 5.10, **Ending**;
 * `wikistow_live_end`, migration 0050): their streams are told, those who
 * can still edit start again under new keys, and the ended session stays
 * for catching up. A message being stored holds its session's row, so it
 * lands before this or finds the session ended. Answers how many it ended.
 */
async function endLiveSessions(tx: Database, identityId: string): Promise<number> {
  // Held in ID order first, so two of these don't each wait on a row the
  // other holds. A change of access ends sessions page by page instead
  // (`wikistow_live_end`); against one of those, Postgres may still abort one.
  const open = await tx.execute<{ id: string }>(sql`
    select s.id from ${liveSessions} s
      where s.ended_at is null and s.space_id in (
        select o.space_id from ${spaceOwners} o
          where o.identity_id = ${identityId} and o.removed_at is null
        union
        select sh.space_id from ${shareMembers} m join ${shares} sh on sh.id = m.share_id
          where m.identity_id = ${identityId})
      order by s.id for update`);
  if (open.length === 0) return 0;
  const ids = open.map((row) => row.id);
  const ended = await tx.execute<{ id: string }>(sql`
    update ${liveSessions} s set ended_at = clock_timestamp(), ended_reason = 'access',
        ended_position = s.last_position,
        ended_draft_head = (select h.draft_head from ${pageHeads} h where h.page_id = s.page_id)
      where s.ended_at is null and s.id = any(${sql.param(ids)}::text[])
      returning s.id`);
  return ended.length;
}

/**
 * A person's statements from key version `from` up, in order, with their
 * current key from the same read (protocol section 4.6), for anyone who may
 * look them up. `current` is null for an ID with no live key.
 */
export async function readRotations(
  db: Database,
  { identityId, from }: { identityId: string; from: number },
) {
  return db.transaction(
    async (tx) => {
      const [row] = await tx
        .select()
        .from(identities)
        .where(
          and(
            eq(identities.id, identityId),
            eq(identities.kind, 'human'),
            isNull(identities.revokedAt),
          ),
        );
      const rows = await tx
        .select({ statement: identityRotations.statement })
        .from(identityRotations)
        .where(
          and(
            eq(identityRotations.identityId, identityId),
            gte(identityRotations.fromKeyVersion, from),
          ),
        )
        .orderBy(asc(identityRotations.fromKeyVersion));
      return {
        current: row ? publicOf(row) : null,
        rotations: rows.map((r) => r.statement as Record<string, unknown>),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** A person's public keys at one key version, current or earlier, or `not-found`. */
export async function readIdentityVersion(
  db: Database,
  { identityId, keyVersion }: { identityId: string; keyVersion: number },
): Promise<PublicIdentity> {
  const [row] = await db
    .select()
    .from(identities)
    .where(
      and(
        eq(identities.id, identityId),
        eq(identities.keyVersion, keyVersion),
        eq(identities.kind, 'human'),
      ),
    );
  if (!row) throw new ContentError('not-found');
  return publicOf(row);
}

const publicOf = (row: typeof identities.$inferSelect): PublicIdentity =>
  PublicIdentity.parse({
    id: row.id,
    kind: row.kind,
    keyVersion: row.keyVersion,
    boxPublicKey: row.boxPublicKey,
    signPublicKey: row.signPublicKey,
  });
