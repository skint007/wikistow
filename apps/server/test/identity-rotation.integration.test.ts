// Replacing a person's identity keys (protocol section 4.6, #327, PR 2):
// the rotate route's checks and its one transaction, the statements and
// earlier keys it serves, and the setting that keeps it off.
import {
  changeVaultPassphrase,
  createApiClient,
  generateIdentity,
  inlineVaultCrypto,
  keyHash,
  newId,
  openSession,
  parseIdentityRotation,
  replaceKeysOperations as replaceKeys,
  saveContacts,
  sealContacts,
  spaceOperations,
  unlockVault,
  verifyRotationChain,
} from '@wikistow/client';
import { FAST_KDF } from '@wikistow/client/testing';
import {
  AccountId,
  contactsRoutes,
  identityRoutes,
  InstallationId,
  SpaceId,
  systemRoutes,
  vaultRoutes,
} from '@wikistow/contracts';
import {
  currentIdentity,
  desktopApprovalStands,
  lookupIdentities,
  schema,
  type Database,
} from '@wikistow/server';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { PASSWORD } from './support/accounts.ts';
import { asAgent, enrolledAgent } from './support/agents.ts';
import { personWithVault, rejection } from './support/content.ts';
import { Browser, createTestApp, type TestApp } from './support/harness.ts';
import { startSession } from './support/live.ts';
import { find, library, shareFolder, type Person } from './support/sharing.ts';

const NEW_PASSPHRASE = 'a brand new vault passphrase';

let t: TestApp;
let off: TestApp;
beforeAll(async () => {
  [t, off] = await Promise.all([
    createTestApp({ identityRotation: true }),
    createTestApp({ identityRotation: false }),
  ]);
});
afterAll(async () => {
  await Promise.all([t.drop(), off.drop()]);
});

/** A rotation from `person`'s session, keeping the agents in `keep`. */
const prepare = (person: Person, keep: readonly string[] = []) =>
  replaceKeys.prepareRotation(person.ctx, {
    vault: person.vault,
    crypto: inlineVaultCrypto,
    passphrase: NEW_PASSPHRASE,
    kdf: FAST_KDF,
    keep,
  });

const rotate = (person: Person, body: replaceKeys.RotateRequest) =>
  person.api.call(identityRoutes.rotate, { body });

/** A person with a contacts record, as every person who has made a space has. */
async function personWithRecord(app: TestApp = t) {
  const person = await personWithVault(app);
  await library(person);
  await saveContacts(person.ctx);
  return person;
}

/** Another device of the same person: signed in on its own. */
async function secondDevice(app: TestApp, person: Person) {
  const browser = new Browser(app.app);
  const signedIn = await browser.request('/api/auth/sign-in/email', {
    method: 'POST',
    json: { email: person.email, password: PASSWORD },
  });
  expect(signedIn.status).toBe(200);
  return createApiClient({ fetch: browser.fetch });
}

/** Until a request of this test's database waits on a lock, as Postgres shows it. */
async function waitingOnLock() {
  await expect
    .poll(
      async () => {
        const [row] = await t.db.execute<{ waiting: number }>(sql`
          select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`);
        return row?.waiting ?? 0;
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
}

const rowsOf = (identityId: string) =>
  t.db
    .select()
    .from(schema.identities)
    .where(eq(schema.identities.id, identityId))
    .orderBy(schema.identities.keyVersion);

describe('the setting', () => {
  it('is off unless set: the route is refused and the installation says so', async () => {
    const alice = await personWithRecord(off);
    const prepared = await prepare(alice);
    expect(await rejection(rotate(alice, prepared.request))).toBe('rotation-off');
    expect((await alice.api.call(systemRoutes.installation)).identityRotation).toBe(false);
    const rows = await off.db
      .select()
      .from(schema.identities)
      .where(eq(schema.identities.id, alice.vault.identity.public.id));
    expect(rows.map((row) => row.keyVersion)).toEqual([1]);
  });

  it('is refused before the body is read', async () => {
    const alice = await personWithRecord(off);
    const res = await alice.browser.request('/api/me/identity/rotate', {
      method: 'POST',
      json: { padding: 'x'.repeat(5 * 1024 * 1024) },
    });
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('rotation-off');
  });

  it('says when it is on', async () => {
    const alice = await personWithVault(t);
    expect((await alice.api.call(systemRoutes.installation)).identityRotation).toBe(true);
  });
});

describe('replacing keys', () => {
  it('replaces the key, vault and contacts in one go, keeps ticked agents and revokes the rest', async () => {
    const alice = await personWithRecord();
    const kept = await enrolledAgent(t, alice);
    const dropped = await enrolledAgent(t, alice);
    await saveContacts(alice.ctx);
    const phone = await secondDevice(t, alice);
    expect((await phone.call(vaultRoutes.getVault)).version).toBe(1);
    const old = alice.vault.identity.public;

    const keepable = await replaceKeys.keepableAgents(alice.ctx);
    expect(keepable.map((a) => a.agentId).sort()).toEqual([kept.agentId, dropped.agentId].sort());
    const prepared = await prepare(alice, [kept.agentId]);
    expect(await rotate(alice, prepared.request)).toEqual({
      vaultVersion: 2,
      contactsVersion: prepared.request.contacts.record.version,
    });

    // The new key is current, the old one kept as no longer current.
    const rows = await rowsOf(old.id);
    expect(rows.map((r) => [r.keyVersion, r.revokedAt === null])).toEqual([
      [1, false],
      [2, true],
    ]);
    const next = prepared.request.identity;
    const { identities } = await alice.api.call(vaultRoutes.lookupIdentities, {
      query: { ids: old.id },
    });
    expect(identities).toEqual([next]);

    // The vault is format 2, opened by the new passphrase to the new key with the old one retired.
    const { wrapper, version } = await alice.api.call(vaultRoutes.getVault);
    expect(version).toBe(2);
    const opened = unlockVault({
      wrapper,
      secret: { kind: 'passphrase', passphrase: NEW_PASSPHRASE },
      formats: [1, 2],
    });
    expect(opened.identity.public).toEqual(next);
    expect(opened.retired.map((key) => key.public)).toEqual([old]);
    // The old recovery key opens it no more.
    const withOldRecovery = Promise.resolve().then(() =>
      unlockVault({
        wrapper,
        secret: { kind: 'recovery-key', recoveryKey: alice.recoveryKey },
        formats: [1, 2],
      }),
    );
    expect(await rejection(withOldRecovery)).toBe('decrypt-failed');

    // A session at the new key reads the contacts version it wrote.
    const after = await openSession(alice.api, prepared.vault);
    expect(after.contacts.book.record).toMatchObject({ ownerKeyVersion: 2 });
    const shared = after.contacts.book.payloads.shared;
    expect(shared.agents.map((a) => [a.enrollment.agent.id, a.enrollment.ownerKeyVersion])).toEqual(
      [[kept.agentId, 2]],
    );
    expect(shared.revokedAgents.map((r) => r.agentId)).toContain(dropped.agentId);
    // Beside her own owner entry at the old key, one at the new key.
    const own = shared.spaceOwners.flatMap((entry) =>
      entry.owners.filter((owner) => owner.id === old.id).map((owner) => owner.keyHash),
    );
    expect(own).toContain(keyHash(old));
    expect(own).toContain(keyHash(next));
    expect(own.filter((hash) => hash === keyHash(next)).length).toBe(
      own.filter((hash) => hash === keyHash(old)).length,
    );

    // The kept agent works on; the other is revoked, and its token fails.
    const profile = await t.db
      .select()
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.agentId, kept.agentId));
    expect(profile[0]?.ownerKeyVersion).toBe(2);
    expect((await asAgent(t, kept.token, '/api/me/contacts')).status).toBe(200);
    expect((await asAgent(t, dropped.token, '/api/me/contacts')).status).toBe(401);

    // The other device is signed out; this one isn't.
    expect(await rejection(phone.call(vaultRoutes.getVault))).toBe('unauthenticated');
    expect((await alice.api.call(vaultRoutes.getVault)).version).toBe(2);

    // The statement is served, with the current key, and it chains.
    const served = await alice.api.call(identityRoutes.rotations, {
      params: { identityId: old.id },
      query: { from: 1 },
    });
    expect(served.current).toEqual(next);
    const chain = verifyRotationChain({
      installationId: alice.ctx.installationId,
      start: old,
      end: next,
      statements: served.rotations.map(parseIdentityRotation),
    });
    expect(chain.keys.map((key) => keyHash(key))).toEqual([keyHash(old), keyHash(next)]);
    expect(
      (
        await alice.api.call(identityRoutes.rotations, {
          params: { identityId: old.id },
          query: { from: 2 },
        })
      ).rotations,
    ).toEqual([]);
    // Not to agents, which may look up fewer people.
    for (const path of [
      `/api/identities/${old.id}/rotations`,
      `/api/identities/${old.id}/versions/1`,
    ]) {
      expect((await asAgent(t, kept.token, path)).status).toBe(401);
    }
    // As are the earlier keys, to anyone signed in.
    const bob = await personWithVault(t);
    expect(
      await bob.api.call(identityRoutes.version, {
        params: { identityId: old.id, keyVersion: 1 },
      }),
    ).toEqual({ identity: old });
    expect(
      await rejection(
        bob.api.call(identityRoutes.version, { params: { identityId: old.id, keyVersion: 3 } }),
      ),
    ).toBe('not-found');

    const [event] = await t.db
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.actorAccountId, alice.id),
          eq(schema.auditEvents.action, 'identity.rotated'),
        ),
      );
    expect(event?.details).toMatchObject({ fromKeyVersion: 1, keptAgents: 1, revokedAgents: 1 });
  });

  it('refuses anything signed with the old key afterwards', async () => {
    const alice = await personWithRecord();
    const prepared = await prepare(alice);
    await rotate(alice, prepared.request);
    // A contacts version signed with the old key, on top of the new head.
    const head = prepared.request.contacts.record;
    const oldSigned = sealContacts({
      owner: alice.vault.identity,
      installationId: alice.ctx.installationId,
      previous: head,
      ...alice.ctx.contacts.book.payloads,
    });
    expect(
      await rejection(
        alice.api.call(contactsRoutes.putContacts, {
          body: { expectedVersion: head.version, record: oldSigned },
        }),
      ),
    ).toBe('contacts-invalid');
    // A space named under the old key, which the session still holds: its
    // name record names the old key version, not the caller's current one.
    expect(
      await rejection(spaceOperations.createSpace(alice.ctx, { name: 'Under the old key' })),
    ).toBe('forbidden');
    // At the new key, a new space goes through.
    const after = await openSession(alice.api, prepared.vault);
    await spaceOperations.createSpace(after, { name: 'Under the new key' });
  });

  it('ends the live sessions in spaces the person owns or is a member of', async () => {
    const alice = await personWithRecord();
    const bob = await personWithRecord();
    const own = await library(alice);
    const theirs = await library(bob);
    await shareFolder(bob.ctx, {
      spaceId: theirs.spaceId,
      rootId: theirs.shared,
      people: [{ person: await find(bob, alice), role: 'editor', canPublish: false }],
    });
    const mine = await startSession(alice, own.page);
    const bobs = await startSession(bob, theirs.page);
    const elsewhere = await startSession(bob, theirs.beside);
    // Someone else's space, where Alice is nobody.
    const carol = await personWithRecord();
    const hers = await library(carol);
    const unrelated = await startSession(carol, hers.page);

    await rotate(alice, (await prepare(alice)).request);
    const row = async (id: string) =>
      (await t.db.select().from(schema.liveSessions).where(eq(schema.liveSessions.id, id)))[0];
    expect(await row(mine.sessionId)).toMatchObject({ endedReason: 'access', keysLost: false });
    expect(await row(bobs.sessionId)).toMatchObject({ endedReason: 'access' });
    // Bob's private page is in the same space, which Alice is a member of: it ends too.
    expect(await row(elsewhere.sessionId)).toMatchObject({ endedReason: 'access' });
    expect(await row(unrelated.sessionId)).toMatchObject({ endedAt: null });
  });
});

describe('the checks', () => {
  it('takes the first statement for a key version, answers the same one sent again, and refuses another', async () => {
    const alice = await personWithRecord();
    const first = await prepare(alice);
    const second = await prepare(alice);
    const answer = await rotate(alice, first.request);
    expect(await rotate(alice, first.request)).toEqual(answer);
    expect(await rejection(rotate(alice, second.request))).toBe('rotation-exists');
    // The same signed bytes under other signatures aren't the same statement.
    const { rotation } = first.request;
    const swapped = {
      ...rotation,
      fromSignature: second.request.rotation.fromSignature,
    };
    expect(await rejection(rotate(alice, { ...first.request, rotation: swapped }))).toBe(
      'rotation-exists',
    );
    expect((await rowsOf(alice.vault.identity.public.id)).length).toBe(2);
  });

  it('names the contacts version another device wrote meanwhile', async () => {
    const alice = await personWithRecord();
    const phone = await openSession(alice.api, alice.vault);
    await saveContacts(phone, [
      {
        kind: 'accept-owner',
        spaceId: newId(SpaceId),
        owner: {
          id: alice.vault.identity.public.id,
          keyHash: keyHash(alice.vault.identity.public),
        },
      },
    ]);
    // This session still holds the version before, with nothing waiting.
    const prepared = await prepare(alice);
    expect(prepared.request.rotation.contacts?.version).toBe(
      phone.contacts.book.record?.version ?? 0,
    );
    expect((await rotate(alice, prepared.request)).vaultVersion).toBe(2);
  });

  it('refuses a passphrase change over the vault it replaced', async () => {
    const alice = await personWithRecord();
    const prepared = await prepare(alice);
    await rotate(alice, prepared.request);
    // Another tab of the same sign-in, still holding the old vault.
    expect(
      await rejection(
        changeVaultPassphrase({
          api: alice.api,
          crypto: inlineVaultCrypto,
          vault: alice.vault,
          passphrase: 'a passphrase for the old vault',
          kdf: FAST_KDF,
        }),
      ),
    ).toBe('stale-vault-version');
    expect((await alice.api.call(vaultRoutes.getVault)).version).toBe(2);
    // Over the new vault it goes through, and keeps format 2.
    const changed = await changeVaultPassphrase({
      api: alice.api,
      crypto: inlineVaultCrypto,
      vault: prepared.vault,
      passphrase: 'another new vault passphrase',
      kdf: FAST_KDF,
    });
    expect(changed.wrapper.format).toBe(2);
  });

  it('refuses a desktop sign-in approved before it, by the clock as it lands', async () => {
    const alice = await personWithRecord();
    const [own] = await t.db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, alice.id));
    if (!own) throw new Error('expected a session');
    const prepared = await prepare(alice);
    // Approved by the session that stays, while the rotation waits on a lock.
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let holding = () => {};
    const held = new Promise<void>((resolve) => (holding = resolve));
    const write = t.db.transaction(async (tx) => {
      await currentIdentity(tx, alice.id);
      holding();
      await released;
    });
    await held;
    const rotation = rotate(alice, prepared.request);
    await waitingOnLock();
    const [{ approvedAt } = { approvedAt: new Date() }] = await t.db.execute<{
      approvedAt: Date;
    }>(sql`select now() as "approvedAt"`);
    release();
    await write;
    await rotation;
    const approval = { userId: alice.id, sessionId: own.id, approvedAt: new Date(approvedAt) };
    expect(await desktopApprovalStands(t.db, approval)).toBe(false);
    // One approved after it stands.
    const later = { ...approval, approvedAt: new Date(Date.now() + 1000) };
    expect(await desktopApprovalStands(t.db, later)).toBe(true);
  });

  it('refuses a resend with another contacts version, and a new one that doesn’t verify', async () => {
    const alice = await personWithRecord();
    const first = await prepare(alice);
    const second = await prepare(alice);
    // Signed by someone else: refused once everything else was written in the transaction.
    const forged = { ...first.request.contacts, signature: second.request.contacts.signature };
    expect(await rejection(rotate(alice, { ...first.request, contacts: forged }))).toBe(
      'contacts-invalid',
    );
    expect((await rowsOf(alice.vault.identity.public.id)).map((r) => r.keyVersion)).toEqual([1]);
    expect((await alice.api.call(vaultRoutes.getVault)).version).toBe(1);
    const stored = await t.db
      .select()
      .from(schema.identityRotations)
      .where(eq(schema.identityRotations.identityId, alice.vault.identity.public.id));
    expect(stored).toEqual([]);

    await rotate(alice, first.request);
    const other = { ...first.request, contacts: second.request.contacts };
    expect(await rejection(rotate(alice, other))).toBe('rotation-exists');
    // A later version, written at the new key since, isn't the one it appended.
    const after = await openSession(alice.api, first.vault);
    await saveContacts(after, [
      {
        kind: 'accept-owner',
        spaceId: newId(SpaceId),
        owner: {
          id: alice.vault.identity.public.id,
          keyHash: keyHash(first.vault.identity.public),
        },
      },
    ]);
    const later = after.contacts.book.sealed;
    if (!later) throw new Error('expected a record');
    expect(await rejection(rotate(alice, { ...first.request, contacts: later }))).toBe(
      'rotation-exists',
    );
    expect(await rotate(alice, first.request)).toMatchObject({ vaultVersion: 2 });
  });

  it('refuses a contacts version whose payloads aren’t the ones it signs', async () => {
    const alice = await personWithRecord();
    const { request } = await prepare(alice);
    const other = await prepare(alice);
    const swapped = { ...request.contacts, payload: other.request.contacts.payload };
    expect(await rejection(rotate(alice, { ...request, contacts: swapped }))).toBe(
      'contacts-invalid',
    );
    expect((await rowsOf(alice.vault.identity.public.id)).length).toBe(1);
  });

  it('refuses a contacts version that later writes couldn’t carry', async () => {
    const alice = await personWithRecord();
    const { request } = await prepare(alice);
    const huge = {
      ...request.contacts,
      payload: { ...request.contacts.payload, ciphertext: 'A'.repeat(1024 * 1024) },
    };
    expect(await rejection(rotate(alice, { ...request, contacts: huge }))).toBe(
      'payload-too-large',
    );
    expect((await rowsOf(alice.vault.identity.public.id)).length).toBe(1);
  });

  it('refuses a write sealing to someone whose rotation it waited on', async () => {
    const alice = await personWithRecord();
    const next = generateIdentity({
      kind: 'human',
      id: alice.vault.identity.public.id,
      keyVersion: 2,
    }).public;
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let holding = () => {};
    const held = new Promise<void>((resolve) => (holding = resolve));
    // A rotation's row changes, held open.
    const rotation = t.db.transaction(async (tx) => {
      await tx
        .update(schema.identities)
        .set({ revokedAt: sql`now()` })
        .where(eq(schema.identities.id, next.id));
      await tx.insert(schema.identities).values({
        id: next.id,
        keyVersion: 2,
        accountId: alice.id,
        kind: 'human',
        boxPublicKey: next.boxPublicKey,
        signPublicKey: next.signPublicKey,
      });
      holding();
      await released;
    });
    await held;
    const sealing = t.db.transaction((tx) => lookupIdentities(tx, [next.id]));
    const refused = rejection(sealing);
    await waitingOnLock();
    release();
    await rotation;
    expect(await refused).toBe('stale-head');
  });

  it('stores nothing when a check fails', async () => {
    const alice = await personWithRecord();
    const agent = await enrolledAgent(t, alice);
    await saveContacts(alice.ctx);
    const prepared = await prepare(alice, [agent.agentId]);
    const { request } = prepared;
    const refused = (body: replaceKeys.RotateRequest) => rejection(rotate(alice, body));

    // Every live agent named once, as kept or revoked, with one enrollment per kept one.
    expect(await refused({ ...request, keptAgents: [] })).toBe('invalid-request');
    expect(await refused({ ...request, revokedAgents: [agent.agentId] })).toBe('invalid-request');
    expect(await refused({ ...request, enrollments: [] })).toBe('invalid-request');
    // An enrollment signed with the old key.
    const oldEnrollment = alice.ctx.contacts.book.payloads.shared.agents[0]?.enrollment;
    expect(await refused({ ...request, enrollments: oldEnrollment ? [oldEnrollment] : [] })).toBe(
      'binding-mismatch',
    );
    // The identity must be the statement's new key.
    expect(
      await refused({
        ...request,
        identity: { ...request.identity, boxPublicKey: alice.vault.identity.public.boxPublicKey },
      }),
    ).toBe('binding-mismatch');
    // A vault version that moved.
    expect(await refused({ ...request, expectedVaultVersion: 7 })).toBe('stale-vault-version');
    // Another account's wrapper.
    const bob = await personWithVault(t);
    expect(
      await refused({
        ...request,
        wrapper: { ...request.wrapper, accountId: AccountId.parse(bob.id) },
      }),
    ).toBe('binding-mismatch');
    // A statement signed by someone else.
    expect(
      await refused({
        ...request,
        rotation: { ...request.rotation, fromSignature: request.rotation.toSignature },
      }),
    ).toBe('bad-signature');
    // A contacts version written since the statement named the head.
    await saveContacts(alice.ctx, [
      {
        kind: 'accept-owner',
        spaceId: newId(SpaceId),
        owner: { id: bob.vault.identity.public.id, keyHash: keyHash(bob.vault.identity.public) },
      },
    ]);
    expect(await refused(request)).toBe('stale-head');

    expect((await rowsOf(alice.vault.identity.public.id)).map((r) => r.keyVersion)).toEqual([1]);
    expect((await alice.api.call(vaultRoutes.getVault)).version).toBe(1);
    expect((await asAgent(t, agent.token, '/api/me/contacts')).status).toBe(200);
    const stored = await t.db
      .select()
      .from(schema.identityRotations)
      .where(eq(schema.identityRotations.identityId, alice.vault.identity.public.id));
    expect(stored).toEqual([]);
  });

  it('needs a recent sign-in', async () => {
    const alice = await personWithRecord();
    const prepared = await prepare(alice);
    await t.db
      .update(schema.sessions)
      .set({ authenticatedAt: sql`now() - interval '11 minutes'` })
      .where(eq(schema.sessions.userId, alice.id));
    expect(await rejection(rotate(alice, prepared.request))).toBe('reauth-required');
  });

  for (const [who, hold] of [
    // A signed write of Alice's, which read her key.
    ['her own write', (tx: Database, alice: Person) => currentIdentity(tx, alice.id)],
    // Someone else's write sealing to her, which read her key as a recipient.
    [
      'a write sealing to her',
      (tx: Database, alice: Person) => lookupIdentities(tx, [alice.vault.identity.public.id]),
    ],
  ] as const) {
    it(`waits for ${who} that read the old key, so it can't land after`, async () => {
      const alice = await personWithRecord();
      const prepared = await prepare(alice);
      let release = () => {};
      const released = new Promise<void>((resolve) => (release = resolve));
      let holding = () => {};
      const held = new Promise<void>((resolve) => (holding = resolve));
      const write = t.db.transaction(async (tx) => {
        await hold(tx, alice);
        holding();
        await released;
      });
      await held;
      let done = false;
      const rotation = rotate(alice, prepared.request).then((answer) => {
        done = true;
        return answer;
      });
      await waitingOnLock();
      expect(done).toBe(false);
      release();
      await write;
      expect((await rotation).vaultVersion).toBe(2);
    });
  }

  it('serves statements only as signed, for the installation they name', async () => {
    const alice = await personWithRecord();
    await rotate(alice, (await prepare(alice)).request);
    const { installationId } = await alice.api.call(systemRoutes.installation);
    const { rotations } = await alice.api.call(identityRoutes.rotations, {
      params: { identityId: alice.vault.identity.public.id },
      query: {},
    });
    expect(rotations.map((r) => parseIdentityRotation(r).installationId)).toEqual([
      InstallationId.parse(installationId),
    ]);
  });
});
