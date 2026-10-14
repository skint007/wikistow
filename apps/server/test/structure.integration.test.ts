import {
  AccountId,
  type ApiClient,
  changeVaultPassphrase,
  type ClientContext,
  createApiClient,
  FolderId,
  generateIdentity,
  inlineVaultCrypto,
  MetadataRevisionId,
  newFolderMetadata,
  newId,
  openVault,
  prepareVault,
  registerVault,
  sealMetadataV2,
  sharingOperations as sharing,
  SpaceId,
  spaceOperations,
} from '@wikistow/client';
import { FAST_KDF, setUpVault } from '@wikistow/client/testing';
import { accountRoutes, SealedMetadataV2, structureRoutes, vaultRoutes } from '@wikistow/contracts';
import type { z } from 'zod';
import { schema } from '@wikistow/server';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { resetPassword, signedInPerson } from './support/accounts.ts';
import { PASSPHRASE, personWithVault, rejection } from './support/content.ts';
import { createTestApp, scratchApps, type TestApp } from './support/harness.ts';
import { shareFolder } from './support/sharing.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());
const scratchApp = scratchApps();

/** A space's folders, each of which must have opened. */
async function foldersOf(ctx: ClientContext, spaceId: SpaceId) {
  const { folders } = await spaceOperations.loadTree(ctx, spaceId);
  return folders.map(({ metadata, ...folder }) => {
    if (!metadata) throw new Error(`folder ${folder.id} did not open`);
    return { ...folder, metadata };
  });
}

describe('the vault', () => {
  it('is registered only once', async () => {
    const alice = await personWithVault(t);
    const again = setUpVault({
      api: alice.api,
      crypto: inlineVaultCrypto,
      accountId: AccountId.parse(alice.id),
      passphrase: PASSPHRASE,
      kdf: FAST_KDF,
    });
    expect(await rejection(again)).toBe('vault-exists');
  });

  it('changes only its passphrase wrapper', async () => {
    const alice = await personWithVault(t);
    const { wrapper, version } = await alice.api.call(vaultRoutes.getVault);

    const destroyKeys = {
      ...wrapper,
      keyring: { ...wrapper.keyring, ciphertext: wrapper.recovery.ciphertext },
    };
    expect(
      await rejection(
        alice.api.call(vaultRoutes.replaceVault, {
          body: { wrapper: destroyKeys, expectedVersion: version },
        }),
      ),
    ).toBe('vault-immutable-field');
    const destroyRecovery = {
      ...wrapper,
      recovery: { ...wrapper.recovery, ciphertext: wrapper.keyring.ciphertext },
    };
    expect(
      await rejection(
        alice.api.call(vaultRoutes.replaceVault, {
          body: { wrapper: destroyRecovery, expectedVersion: version },
        }),
      ),
    ).toBe('vault-immutable-field');
    expect(
      await rejection(
        alice.api.call(vaultRoutes.replaceVault, {
          body: { wrapper, expectedVersion: version + 1 },
        }),
      ),
    ).toBe('stale-vault-version');

    await changeVaultPassphrase({
      api: alice.api,
      crypto: inlineVaultCrypto,
      vault: alice.vault,
      passphrase: 'new passphrase here',
      kdf: FAST_KDF,
    });
    const unlock = (passphrase: string) =>
      openVault({
        api: alice.api,
        crypto: inlineVaultCrypto,
        secret: { kind: 'passphrase', passphrase },
      });
    expect((await unlock('new passphrase here')).identity.public).toEqual(
      alice.vault.identity.public,
    );
    expect(await rejection(unlock(PASSPHRASE))).toBe('decrypt-failed');
  });

  it('is untouched by a password reset', async () => {
    const alice = await personWithVault(t);
    const before = await t.db
      .select()
      .from(schema.vaultWrappers)
      .where(eq(schema.vaultWrappers.accountId, alice.id));
    await resetPassword(t, alice.email, 'a brand new account password');
    const after = await t.db
      .select()
      .from(schema.vaultWrappers)
      .where(eq(schema.vaultWrappers.accountId, alice.id));
    expect(after).toEqual(before);
  });

  it('survives a lost response: the same setup sent again succeeds', async () => {
    const person = await signedInPerson(t);
    let dropped = false;
    // The server stores the vault, but its answer never arrives.
    const api = createApiClient({
      fetch: async (url, init) => {
        const res = await person.browser.fetch(url, init);
        if (!dropped && url === '/api/vault' && init.method === 'POST') {
          dropped = true;
          throw new TypeError('network error');
        }
        return res;
      },
    });
    const prepared = await prepareVault({
      crypto: inlineVaultCrypto,
      accountId: AccountId.parse(person.id),
      passphrase: PASSPHRASE,
      kdf: FAST_KDF,
    });
    await expect(registerVault(api, prepared)).rejects.toMatchObject({ code: 'network' });
    await registerVault(api, prepared);
    const opened = await openVault({
      api,
      crypto: inlineVaultCrypto,
      secret: { kind: 'recovery-key', recoveryKey: prepared.recoveryKey },
    });
    expect(opened.identity.public).toEqual(prepared.identity.public);
  });

  it('cannot be registered under someone else’s identity ID', async () => {
    const alice = await personWithVault(t);
    const mallory = await signedInPerson(t);
    const api = createApiClient({ fetch: mallory.browser.fetch });
    const stolen = (keyVersion: number) => {
      const keys = generateIdentity({
        kind: 'human',
        id: alice.vault.identity.public.id,
        keyVersion,
      });
      return inlineVaultCrypto
        .create({ accountId: AccountId.parse(mallory.id), passphrase: 'mallory', kdf: FAST_KDF })
        .then(({ wrapper }) =>
          api.call(vaultRoutes.createVault, { body: { identity: keys.public, wrapper } }),
        );
    };
    expect(await rejection(stolen(2))).toBe('invalid-request');
    expect(await rejection(stolen(1))).toBe('duplicate');

    const directory = await alice.api.call(vaultRoutes.lookupIdentities, {
      query: { ids: alice.vault.identity.public.id },
    });
    expect(directory.identities).toEqual([alice.vault.identity.public]);
    const spaceId = await spaceOperations.createSpace(alice.ctx, { name: 'Still mine' });
    await spaceOperations.createFolder(alice.ctx, { spaceId, parentId: null, name: 'Still works' });
  });

  it('is refused below the server’s passphrase protection floor', async () => {
    const minKdf = { opsLimit: FAST_KDF.opsLimit + 1, memLimit: FAST_KDF.memLimit * 2 };
    const strict = await scratchApp({ minKdf });
    const person = await signedInPerson(strict);
    const api = createApiClient({ fetch: person.browser.fetch });
    const accountId = AccountId.parse(person.id);
    const setUp = (kdf: typeof minKdf) =>
      setUpVault({ api, crypto: inlineVaultCrypto, accountId, passphrase: PASSPHRASE, kdf });
    expect(await rejection(setUp(FAST_KDF))).toBe('invalid-request');
    const { vault } = await setUp(minKdf);

    const change = (kdf: typeof minKdf) =>
      changeVaultPassphrase({ api, crypto: inlineVaultCrypto, vault, passphrase: 'new one', kdf });
    expect(await rejection(change(FAST_KDF))).toBe('invalid-request');
    expect(await rejection(change(minKdf))).toBe('no error');
  });
});

describe('spaces and folders', () => {
  it('still list the other spaces, and its folders, when one space’s name fails its checks', async () => {
    const alice = await personWithVault(t);
    const good = await spaceOperations.createSpace(alice.ctx, { name: 'Good' });
    const bad = await spaceOperations.createSpace(alice.ctx, { name: 'Bad' });
    await spaceOperations.createFolder(alice.ctx, { spaceId: bad, parentId: null, name: 'Kept' });
    const sealedOf = async (subjectId: string) =>
      SealedMetadataV2.parse(
        (
          await t.db
            .select({ sealed: schema.metadataRevisions.sealed })
            .from(schema.metadataRevisions)
            .where(eq(schema.metadataRevisions.subjectId, subjectId))
        )[0]?.sealed,
      );
    const swapped = { ...(await sealedOf(bad)), payload: (await sealedOf(good)).payload };
    await t.db.execute(
      sql`alter table metadata_revisions disable trigger metadata_revisions_immutable`,
    );
    try {
      await t.db
        .update(schema.metadataRevisions)
        .set({ sealed: swapped })
        .where(eq(schema.metadataRevisions.subjectId, bad));
    } finally {
      await t.db.execute(
        sql`alter table metadata_revisions enable trigger metadata_revisions_immutable`,
      );
    }
    const byId = new Map(
      (await spaceOperations.loadSpaces(alice.ctx)).map((space) => [space.id, space.metadata]),
    );
    expect(byId.get(bad)).toBeNull();
    expect(byId.get(good)?.opened).toMatchObject({ metadata: { name: 'Good' } });
    const tree = await spaceOperations.loadTree(alice.ctx, bad);
    expect(tree.space?.metadata).toBeNull();
    expect(tree.folders.map((f) => f.metadata?.opened)).toMatchObject([
      { metadata: { name: 'Kept' } },
    ]);
  });

  describe('are checked on the server', () => {
    async function folderCommit(
      ctx: ClientContext,
      spaceId: SpaceId,
      { recipients }: { recipients?: 'none' } = {},
    ) {
      const folderId = newId(FolderId);
      const sealed = sealMetadataV2({
        author: ctx.identity,
        target: {
          installationId: ctx.installationId,
          spaceId,
          subjectKind: 'folder',
          subjectId: folderId,
          metadataRevisionId: newId(MetadataRevisionId),
          basedOn: null,
        },
        metadata: newFolderMetadata('x'),
        recipients: recipients === 'none' ? [] : [ctx.identity.public],
      });
      return { folderId, ...sealed };
    }

    const post = (
      api: ApiClient,
      spaceId: SpaceId,
      body: Omit<z.input<typeof structureRoutes.createFolder.body>, 'wrap'>,
    ) =>
      rejection(
        api.call(structureRoutes.createFolder, {
          params: { spaceId },
          body: { wrap: null, ...body },
        }),
      );

    it('rejecting missing recipients and stale permissions', async () => {
      const alice = await personWithVault(t);
      const spaceId = await spaceOperations.createSpace(alice.ctx, { name: 'Checks' });

      const noKeys = await folderCommit(alice.ctx, spaceId, { recipients: 'none' });
      expect(
        await post(alice.api, spaceId, {
          ...noKeys,
          folderId: noKeys.folderId,
          parentId: null,
          permissionVersion: 1,
        }),
      ).toBe('recipients-mismatch');

      const fine = await folderCommit(alice.ctx, spaceId);
      expect(
        await post(alice.api, spaceId, { ...fine, parentId: null, permissionVersion: 2 }),
      ).toBe('permission-version');
      expect(
        await post(alice.api, spaceId, { ...fine, parentId: null, permissionVersion: 1 }),
      ).toBe('no error');
    });
  });
});

describe('the identity directory', () => {
  it('serves the live key version and nothing revoked', async () => {
    const alice = await personWithVault(t);
    const { id } = alice.vault.identity.public;
    const lookup = async () =>
      (await alice.api.call(vaultRoutes.lookupIdentities, { query: { ids: id } })).identities;
    const revoke = (keyVersion: number) =>
      t.db
        .update(schema.identities)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(schema.identities.id, id), eq(schema.identities.keyVersion, keyVersion)));
    // Rotation: the old key is revoked and the next version takes over.
    await revoke(1);
    const next = generateIdentity({ kind: 'human', id, keyVersion: 2 }).public;
    await t.db.insert(schema.identities).values({ ...next, accountId: alice.id });
    expect((await lookup()).map((i) => i.keyVersion)).toEqual([2]);
    expect((await alice.api.call(accountRoutes.me)).identity?.keyVersion).toBe(2);
    await revoke(2);
    expect(await lookup()).toEqual([]);
    expect((await alice.api.call(accountRoutes.me)).identity).toBeNull();
  });
});

describe('renames', () => {
  it('lets editors rename folders but only owners rename the space', async () => {
    const alice = await personWithVault(t);
    const spaceId = await spaceOperations.createSpace(alice.ctx, { name: 'Shared later' });
    const folderId = await spaceOperations.createFolder(alice.ctx, {
      spaceId,
      parentId: null,
      name: 'Plans',
    });
    const bob = await personWithVault(t);
    const carol = await personWithVault(t);
    const find = async (person: typeof bob) => {
      const found = await sharing.findPerson(alice.ctx, person.email);
      if (!found) throw new Error('expected to find them');
      return found;
    };
    await shareFolder(alice.ctx, {
      spaceId,
      rootId: null,
      people: [
        { person: await find(bob), role: 'editor' },
        { person: await find(carol), role: 'reader' },
      ],
    });
    const rename = async (person: typeof bob) => {
      const [folder] = await foldersOf(person.ctx, spaceId);
      if (!folder) throw new Error('expected the folder');
      return rejection(
        spaceOperations.updateMetadata(person.ctx, {
          spaceId,
          subject: { kind: 'folder', folderId },
          current: folder.metadata,
          changes: { name: `Renamed by ${person.email}` },
        }),
      );
    };
    expect(await rename(carol)).toBe('forbidden');
    expect(
      await rejection(
        spaceOperations.createFolder(carol.ctx, { spaceId, parentId: null, name: 'Nope' }),
      ),
    ).toBe('forbidden');
    expect(await rename(bob)).toBe('no error');

    const { metadata, envelopes } = sealMetadataV2({
      author: bob.ctx.identity,
      target: {
        installationId: bob.ctx.installationId,
        spaceId,
        subjectKind: 'space',
        subjectId: spaceId,
        metadataRevisionId: newId(MetadataRevisionId),
        basedOn: null,
      },
      metadata: newFolderMetadata('Renamed by an editor'),
      recipients: [bob.ctx.identity.public],
    });
    expect(
      await rejection(
        bob.api.call(structureRoutes.updateMetadata, {
          params: { spaceId },
          body: { permissionVersion: 1, metadata, envelopes, wrap: null },
        }),
      ),
    ).toBe('forbidden');
  });
});
