import {
  changeVaultPassphrase,
  confirmSession,
  createApiClient,
  generateIdentity,
  IdentityId,
  inlineVaultCrypto,
  KeptMarks,
  keptUnlock,
  keyHash,
  memoryKeptStore,
  newId,
  openKeptSession,
  openSession,
  saveContacts,
  SpaceId,
  type ClientContext,
  type ContactsChange,
  type KeptFile,
} from '@wikistow/client';
import { directoryEntry, FAST_KDF } from '@wikistow/client/testing';
import { contactsRoutes } from '@wikistow/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { personWithVault, rejection } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

const acceptIn = (spaceId: SpaceId): ContactsChange => {
  const owner = generateIdentity({ kind: 'human', id: newId(IdentityId) }).public;
  return { kind: 'accept-owner', spaceId, owner: { id: owner.id, keyHash: keyHash(owner) } };
};

// A person the device pinned, whose new key another device confirms while it is offline.
const fern = generateIdentity({ kind: 'human', id: newId(IdentityId) });
const fernAgain = generateIdentity({ kind: 'human', id: fern.public.id, keyVersion: 2 });

function memoryFile(): KeptFile {
  let kept: Uint8Array | null = null;
  return {
    read: async () => kept,
    write: async (sealed) => {
      kept = sealed;
    },
  };
}

// No answer from the server, as when it is down.
const noServer = createApiClient({ fetch: () => Promise.reject(new TypeError('Offline')) });

/**
 * A person whose device kept what an offline unlock reads (ADR 0009,
 * decision 5): an online session with the device's stores, which keeps the
 * installation ID and the contacts record at version 2 with its mark.
 */
async function keptDevice() {
  const alice = await personWithVault(t);
  await saveContacts(alice.ctx, [acceptIn(newId(SpaceId))]);
  const first = await alice.api.call(contactsRoutes.getContacts, { query: {} });
  const file = memoryFile();
  const content = memoryKeptStore();
  const online = await openSession(alice.api, alice.vault, { kept: file, content });
  online.trust.use(directoryEntry(fern.public, 'Fern'));
  await saveContacts(online);
  const who = { identity: alice.vault.identity, installationId: online.installationId };
  await expect.poll(async () => (await KeptMarks.open(file, who)).contactsMark?.version).toBe(2);
  const opened = await openKeptSession(noServer, alice.vault, {
    kept: file,
    content,
    vaultVersion: 1,
  });
  if (!opened) throw new Error('Nothing kept to open offline');
  // Back online, it asks the server; or a server that serves the first
  // record again, from before the one this device kept.
  const backOnline: ClientContext = { ...opened, api: alice.api };
  const rolledBack: ClientContext = {
    ...opened,
    api: createApiClient({
      fetch: (url, init) =>
        new URL(url, 'http://app').pathname === contactsRoutes.getContacts.path
          ? Promise.resolve(Response.json(first))
          : alice.browser.fetch(url, init),
    }),
  };
  return { alice, online, opened, backOnline, rolledBack, content };
}

describe('a session opened offline', () => {
  it('opens from the record kept with its mark, and takes the newer one once the server answers', async () => {
    const { alice, online, opened, backOnline } = await keptDevice();
    expect(opened.contacts.book.mark).toEqual(online.contacts.book.mark);
    expect(opened.contacts.book.payloads).toEqual(online.contacts.book.payloads);
    expect(opened.unconfirmed).toEqual({ vaultVersion: 1 });
    // Meanwhile another device confirms Fern's new key.
    const phone = await openSession(alice.api, alice.vault);
    phone.trust.confirmKey(directoryEntry(fernAgain.public, 'Fern'));
    await saveContacts(phone);
    expect(await confirmSession(backOnline)).toBe('confirmed');
    expect(backOnline.unconfirmed).toBeUndefined();
    expect(backOnline.trust.check(fernAgain.public).kind).toBe('pinned');
  });

  it('is checked against the mark back online, and ends after a passphrase change elsewhere', async () => {
    const { rolledBack } = await keptDevice();
    expect(await rejection(confirmSession(rolledBack))).toBe('contacts-rollback');

    const changed = await keptDevice();
    await changeVaultPassphrase({
      api: changed.alice.api,
      crypto: inlineVaultCrypto,
      vault: changed.alice.vault,
      passphrase: 'a passphrase from elsewhere',
      kdf: FAST_KDF,
    });
    expect(await confirmSession(changed.backOnline)).toBe('passphrase-changed');
    // The wrapper kept for the next offline unlock is the new one.
    expect((await keptUnlock(changed.content).vault())?.version).toBe(2);
  });
});
