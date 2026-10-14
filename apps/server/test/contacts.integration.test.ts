import {
  generateIdentity,
  IdentityId,
  keyHash,
  newContactsPayloads,
  newId,
  openSession,
  saveContacts,
  sealContacts,
  SpaceId,
  type ContactsChange,
} from '@wikistow/client';
import { directoryEntry } from '@wikistow/client/testing';
import { contactsRoutes } from '@wikistow/contracts';
import { schema } from '@wikistow/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { personWithVault, rejection } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

type Person = Awaited<ReturnType<typeof personWithVault>>;

/** Accepting an owner of a made-up space: a change two devices might each make. */
const acceptIn = (spaceId: SpaceId): ContactsChange => {
  const owner = generateIdentity({ kind: 'human', id: newId(IdentityId) }).public;
  return { kind: 'accept-owner', spaceId, owner: { id: owner.id, keyHash: keyHash(owner) } };
};

const rowsOf = (person: Person) =>
  t.db
    .select()
    .from(schema.contactsRecords)
    .where(eq(schema.contactsRecords.accountId, person.id))
    .orderBy(schema.contactsRecords.version);

describe('the contacts record', () => {
  it('is replaced by compare-and-swap, keeping what another device wrote meanwhile', async () => {
    const alice = await personWithVault(t);
    // A second device, opened before the first writes anything.
    const phone = await openSession(alice.api, alice.vault);
    const [one, two] = [newId(SpaceId), newId(SpaceId)];
    await saveContacts(alice.ctx, [acceptIn(one)]);
    expect(alice.ctx.contacts.book.record?.version).toBe(1);
    // The phone still holds no record, loses the race, and re-applies its change.
    await saveContacts(phone, [acceptIn(two)]);
    expect(phone.contacts.book.record?.version).toBe(2);
    const spaces = (ctx: typeof phone) =>
      ctx.contacts.book.payloads.shared.spaceOwners.map((entry) => entry.spaceId).sort();
    expect(spaces(phone)).toEqual([one, two].sort());
    // A new session reads what both wrote.
    expect(spaces(await openSession(alice.api, alice.vault))).toEqual([one, two].sort());
    // A device behind version 1 gets the chain from there.
    const { chain } = await alice.api.call(contactsRoutes.getContacts, { query: { after: 1 } });
    expect(chain.map((signed) => signed.record.version)).toEqual([2]);
  });

  it('keeps the keys a person pinned for their next session', async () => {
    const alice = await personWithVault(t);
    const bob = await personWithVault(t);
    const fresh = await openSession(alice.api, alice.vault);
    expect(fresh.trust.check(bob.vault.identity.public).kind).toBe('unknown');
    alice.ctx.trust.use(directoryEntry(bob.vault.identity.public, 'Bob'));
    await saveContacts(alice.ctx);
    const later = await openSession(alice.api, alice.vault);
    expect(later.trust.check(bob.vault.identity.public).kind).toBe('pinned');
    expect(later.contacts.book.payloads.private.labels.map((label) => label.name)).toEqual(['Bob']);
  });

  it('queues changes again when a write fails', async () => {
    const alice = await personWithVault(t);
    const accepted = newId(SpaceId);
    const change = acceptIn(accepted);
    const offline = {
      ...alice.ctx,
      api: { ...alice.ctx.api, call: () => Promise.reject(new Error('offline')) },
    } as typeof alice.ctx;
    await expect(saveContacts(offline, [change])).rejects.toThrow('offline');
    expect(alice.ctx.contacts.pending).toEqual([change]);
    await saveContacts(alice.ctx);
    expect(alice.ctx.contacts.pending).toEqual([]);
    const { shared } = (await openSession(alice.api, alice.vault)).contacts.book.payloads;
    expect(shared.spaceOwners.map((entry) => entry.spaceId)).toContain(accepted);
  });

  it('is refused when someone else signs it, or it doesn’t follow the current one', async () => {
    const alice = await personWithVault(t);
    await saveContacts(alice.ctx, [acceptIn(newId(SpaceId))]);
    const { record } = await alice.api.call(contactsRoutes.getContacts, { query: {} });
    if (!record) throw new Error('expected a record');
    const put = (body: { expectedVersion: number; record: unknown }) =>
      rejection(alice.api.call(contactsRoutes.putContacts, { body: body as never }));
    const flipped = record.signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    const next = { ...record, record: { ...record.record, version: 2 } };
    expect(await put({ expectedVersion: 1, record: { ...next, signature: flipped } })).toBe(
      'contacts-invalid',
    );
    // Signed by Alice, but following a version that was never stored.
    const unchained = sealContacts({
      owner: alice.vault.identity,
      installationId: alice.ctx.installationId,
      previous: { ...record.record, payloadHash: 'A'.repeat(43) },
      ...newContactsPayloads(),
    });
    expect(await put({ expectedVersion: 1, record: unchained })).toBe('contacts-invalid');
    expect((await rowsOf(alice)).map((row) => row.version)).toEqual([1]);
  });
});
