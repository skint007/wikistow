import {
  agentEnrollment,
  agentOperations,
  appAgentOperations,
  createApiClient,
  listAppAgents,
  moveOperations as moves,
  openAgentSession,
  ownerOperations as owners,
  pageOperations as pages,
  sharingOperations as sharing,
  spaceOperations,
  toBase64,
  type IdentityId,
} from '@wikistow/client';
import {
  accountRoutes,
  adminRoutes,
  agentRoutes,
  contactsRoutes,
  ownerRoutes,
  pageRoutes,
  peopleRoutes,
  publicationRoutes,
  sharingRoutes,
  structureRoutes,
  systemRoutes,
  vaultRoutes,
} from '@wikistow/contracts';
import { schema } from '@wikistow/server';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { resetPassword } from './support/accounts.ts';
import {
  approvedAgent,
  asAgent,
  cliFetch,
  cliRequest,
  enrolledAgent,
  type Agent,
} from './support/agents.ts';
import { personWithVault, rejection } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { find, invite, library, lyingServer, shareFolder, type Person } from './support/sharing.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

/** A library shared with `member` at `role`, and the folder share they hold. */
async function sharedLibrary(role: 'reader' | 'editor' = 'editor', canPublish = false) {
  const alice = await personWithVault(t);
  const bob = await personWithVault(t);
  const lib = await library(alice);
  const shareId = await shareFolder(alice.ctx, {
    spaceId: lib.spaceId,
    rootId: lib.shared,
    people: [await invite(alice, bob, role, canPublish)],
  });
  return { alice, bob, lib, shareId };
}

describe('enrolling an agent', () => {
  it('shows one fingerprint on both sides, and hands the token over once', async () => {
    const person = await personWithVault(t);
    const agent = await enrolledAgent(t, person);
    // The token was collected, and the server keeps nothing of it to hand over again.
    const [row] = await t.db
      .select()
      .from(schema.agentEnrollments)
      .where(eq(schema.agentEnrollments.id, agent.cli.pending.requested.enrollmentId));
    expect(row?.sealedToken).toBeNull();
    // Only its hash is stored, and neither secret key ever left the CLI.
    const stored = JSON.stringify(await t.db.select().from(schema.agentCredentials));
    expect(stored).not.toContain(agent.token.split('.')[1]);
    const everything = JSON.stringify(
      await t.db.execute(sql`select * from agent_enrollments, agent_profiles`),
    );
    expect(everything).not.toContain(toBase64(agent.identity.boxSecretKey));
    expect(everything).not.toContain(toBase64(agent.identity.signSecretKey));
  });

  it('enrolls a chat assistant in the person’s own app, refusing keys the server swapped', async () => {
    const person = await personWithVault(t);
    // Both sides are this app, which checks the keys served for the claim are its own.
    const { ctx: swapping } = lyingServer(
      person.ctx,
      new Map([
        [
          agentRoutes.claimEnrollment,
          async (input, send) => ({
            ...(await send(input)),
            boxPublicKey: toBase64(new Uint8Array(32).fill(9)),
          }),
        ],
      ]),
    );
    expect(await rejection(appAgentOperations.beginLocalEnrollment(swapping))).toBe(
      'binding-mismatch',
    );
    const local = await appAgentOperations.beginLocalEnrollment(person.ctx);
    await agentOperations.approveEnrollment(person.ctx, {
      claim: local.claim,
      comparedFingerprint: local.claim.fingerprint,
      name: 'helper',
      picks: [],
    });
    await appAgentOperations.finishLocalEnrollment(person.ctx, local);
    const [agent] = listAppAgents(person.ctx.contacts.book.payloads);
    expect(agent?.agentId).toBe(local.claim.agent.id);
    // Its secrets are in the person's own record, sealed: the server holds none of them.
    const everything = JSON.stringify(await t.db.execute(sql`select * from contacts_records`));
    expect(everything).not.toContain(agent?.secret.boxSecretKey);
    expect(everything).not.toContain(agent?.secret.token.split('.')[1]);
    // It works as its own agent, sending the app's origin as a browser does.
    const ctx = await appAgentOperations.openAppAgent(person.ctx, local.claim.agent.id, {
      fetch: (url, init) => {
        const headers = new Headers(init.headers);
        headers.set('origin', t.config.publicOrigin);
        return cliFetch(t)(url, { ...init, headers });
      },
    });
    expect(ctx.agent?.entry.label.name).toBe('helper');
    expect(await sharing.sharedWithMe(ctx)).toEqual([]);
  });

  it('lets a lookup code be claimed once, by one person', async () => {
    const person = await personWithVault(t);
    const other = await personWithVault(t);
    const cli = await cliRequest(t);
    const code = cli.pending.requested.lookupCode;
    const claim = await agentOperations.claimEnrollment(person.ctx, code);
    expect(await rejection(agentOperations.claimEnrollment(other.ctx, code))).toBe('not-found');
    expect(await rejection(agentOperations.claimEnrollment(person.ctx, code))).toBe('not-found');
    // Only the claimer sees or approves it.
    expect(await rejection(agentOperations.enrollmentState(other.ctx, claim))).toBe('not-found');
    const polled = await agentEnrollment.pollEnrollment(cli.api, cli.pending);
    if (polled.state !== 'claimed') throw new Error('expected a claim');
    expect(polled.claimer.person.id).toBe(person.vault.identity.public.id);
    await agentEnrollment.confirmEnrollment(cli.api, cli.pending, polled.claimer);
    await agentOperations.approveEnrollment(person.ctx, {
      claim,
      comparedFingerprint: claim.fingerprint,
      name: 'once',
      picks: [],
    });
    // A poll without the secret learns nothing, not even that it exists.
    const stranger = createApiClient({ fetch: cliFetch(t) });
    const wrongSecret = await rejection(
      agentEnrollment.pollEnrollment(stranger, {
        ...cli.pending,
        pollSecret: new Uint8Array(32),
      }),
    );
    expect(wrongSecret).toBe('not-found');
    expect((await agentEnrollment.pollEnrollment(cli.api, cli.pending)).state).toBe('approved');
    expect((await agentEnrollment.pollEnrollment(cli.api, cli.pending)).state).toBe('delivered');
  });

  it('refuses picks beyond what the person can do there', async () => {
    const { bob, lib } = await sharedLibrary('reader');
    // Even past the app, the server refuses an editor grant from a reader.
    const cli = await cliRequest(t);
    const claim = await agentOperations.claimEnrollment(bob.ctx, cli.pending.requested.lookupCode);
    const polled = await agentEnrollment.pollEnrollment(cli.api, cli.pending);
    if (polled.state !== 'claimed') throw new Error('expected a claim');
    await agentEnrollment.confirmEnrollment(cli.api, cli.pending, polled.claimer);
    const { ctx: inflated } = lyingServer(
      bob.ctx,
      new Map([
        [
          agentRoutes.approveEnrollment,
          async (input, send) => {
            const body = input.body as { grants: { role: string }[] };
            return send({
              ...input,
              body: { ...body, grants: body.grants.map((g) => ({ ...g, role: 'editor' })) },
            });
          },
        ],
      ]),
    );
    expect(
      await rejection(
        agentOperations.approveEnrollment(inflated, {
          claim,
          comparedFingerprint: claim.fingerprint,
          name: 'inflated',
          picks: [{ spaceId: lib.spaceId, folderId: lib.shared, role: 'reader' }],
        }),
      ),
    ).toBe('forbidden');
  });
});

describe('an agent’s token', () => {
  let agent: Agent;
  let person: Person;
  beforeAll(async () => {
    person = await personWithVault(t);
    agent = await enrolledAgent(t, person);
  });

  it('is refused when it is wrong', async () => {
    const path = '/api/spaces';
    const [prefix, secret = ''] = agent.token.split('.');
    const flipped = `${prefix}.${secret.startsWith('A') ? 'B' : 'A'}${secret.slice(1)}`;
    for (const token of [flipped, `${prefix}.`]) {
      expect((await asAgent(t, token, path)).status, token).toBe(401);
    }
  });

  it('is taken from the app’s own origin, never with a cookie or from another site', async () => {
    // The page chat's agents run in the person's app, which sends its origin.
    const send = (headers: Record<string, string>) =>
      t.app.request('/api/spaces', {
        headers: { authorization: `Bearer ${agent.token}`, ...headers },
      });
    expect((await send({ origin: t.config.publicOrigin })).status).toBe(200);
    expect((await send({ origin: 'https://evil.example' })).status).toBe(403);
    expect((await send({ cookie: 'session=x' })).status).toBe(403);
  });

  it('opens only the content routes, and every one of those', async () => {
    // Every route in the contracts, by method and path.
    const all = [
      accountRoutes,
      adminRoutes,
      agentRoutes,
      contactsRoutes,
      ownerRoutes,
      pageRoutes,
      peopleRoutes,
      publicationRoutes,
      sharingRoutes,
      structureRoutes,
      systemRoutes,
      vaultRoutes,
    ].flatMap((group) =>
      Object.values(group).flatMap((value) =>
        typeof value === 'object' && value !== null && 'method' in value && 'path' in value
          ? [`${String(value.method)} ${String(value.path)}`]
          : [],
      ),
    );
    // Section 9.6: the content routes, the person's record, the agent's own
    // envelopes, and the directory.
    const forAgents = new Set(
      [
        contactsRoutes.getContacts,
        structureRoutes.listSpaces,
        structureRoutes.tree,
        structureRoutes.target,
        structureRoutes.createFolder,
        pageRoutes.createPage,
        pageRoutes.getPage,
        pageRoutes.saveDraft,
        pageRoutes.publish,
        pageRoutes.unpublish,
        pageRoutes.history,
        pageRoutes.fetchRevisions,
        publicationRoutes.lookup,
        publicationRoutes.list,
        publicationRoutes.open,
        publicationRoutes.send,
        publicationRoutes.end,
        publicationRoutes.detach,
        sharingRoutes.move,
        sharingRoutes.myEnvelopes,
        sharingRoutes.versionEnvelopes,
        sharingRoutes.sharedWithMe,
        peopleRoutes.directory,
      ].map((route) => `${route.method} ${route.path}`),
    );
    // Open to anyone: the installation, joining, and the CLI's enrollment steps.
    const open = new Set(
      [
        systemRoutes.health,
        systemRoutes.installation,
        accountRoutes.createAccount,
        accountRoutes.finishAccountSetup,
        accountRoutes.inspectInvitation,
        agentRoutes.requestEnrollment,
        agentRoutes.pollEnrollment,
        agentRoutes.confirmEnrollment,
        agentRoutes.cancelEnrollment,
      ].map((route) => `${route.method} ${route.path}`),
    );
    expect(all.length).toBeGreaterThan(forAgents.size + open.size + 30);
    for (const route of all) {
      if (open.has(route)) continue;
      const [method = 'GET', template = ''] = route.split(' ');
      const path = template.replace(/:[A-Za-z]+/g, 'x');
      const res = await asAgent(t, agent.token, path, {
        method,
        ...(method === 'GET' ? {} : { json: {} }),
      });
      if (forAgents.has(route)) expect(res.status, route).not.toBe(401);
      else expect(res.status, route).toBe(401);
    }
  });
});

describe('what an agent can reach', () => {
  it('stays under the folder picked inside a larger share', async () => {
    const alice = await personWithVault(t);
    const bob = await personWithVault(t);
    const lib = await library(alice);
    // Bob holds everything under the top folder; his agent only `Shared`.
    await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.above,
      people: [await invite(alice, bob, 'editor')],
    });
    const agent = await enrolledAgent(t, bob, {
      picks: [{ spaceId: lib.spaceId, folderId: lib.shared, role: 'editor' }],
    });
    const tree = await spaceOperations.loadTree(agent.ctx, lib.spaceId);
    expect(tree.folders.map((f) => [f.id, f.parentId])).toEqual([[lib.shared, null]]);
    expect(tree.pages.map((p) => p.id)).toEqual([lib.page.pageId]);
    expect(await rejection(pages.loadPage(agent.ctx, lib.beside.pageId))).toBe('not-found');
    expect(
      await rejection(
        spaceOperations.createFolder(agent.ctx, {
          spaceId: lib.spaceId,
          parentId: lib.above,
          name: 'beside',
        }),
      ),
    ).toBe('not-found');
    // It moves only inside its pick, never out of it, and never across a share.
    const inside = await spaceOperations.createFolder(agent.ctx, {
      spaceId: lib.spaceId,
      parentId: lib.shared,
      name: 'inside',
    });
    const into = (parentId: typeof inside | null) =>
      moves.previewMove(agent.ctx, { spaceId: lib.spaceId, nodeId: lib.page.pageId, parentId });
    await moves.moveNode(agent.ctx, { preview: await into(inside) });
    expect((await pages.loadPage(bob.ctx, lib.page.pageId)).parentId).toBe(inside);
    expect(await rejection(into(lib.above))).toBe('not-found');
    const out = { ...(await into(lib.shared)), parentId: lib.above };
    expect(await rejection(moves.moveNode(agent.ctx, { preview: out }))).toBe('not-found');
  });

  it('follows its person’s grants: a new role, a pick taken away', async () => {
    const { bob, lib, shareId } = await sharedLibrary('editor');
    const { spaceId } = lib;
    const agent = await enrolledAgent(t, bob, {
      picks: [{ spaceId, folderId: lib.shared, role: 'reader' }],
    });
    expect(await rejection(pages.editDraft(agent.ctx, lib.page, { markdown: 'no' }))).toBe(
      'not-found',
    );
    await agentOperations.grantAgent(bob.ctx, agent.agentId as IdentityId, {
      spaceId,
      folderId: lib.shared,
      role: 'editor',
    });
    const editor = await openAgentSession(agent.api, {
      ...agent.kept,
      identity: agent.identity,
      person: bob.vault.identity.public,
    });
    await pages.editDraft(editor, lib.page, { markdown: 'as an editor' });
    await agentOperations.removeAgentPick(bob.ctx, agent.agentId as IdentityId, {
      spaceId,
      shareId,
    });
    expect(await rejection(pages.loadPage(editor, lib.page.pageId))).toBe('not-found');
  });

  it('shrinks with its person: a reader’s agent reads, a removed person’s gets nothing', async () => {
    const { alice, bob, lib, shareId } = await sharedLibrary('editor');
    const agent = await enrolledAgent(t, bob, {
      picks: [{ spaceId: lib.spaceId, folderId: lib.shared, role: 'editor' }],
    });
    await sharing.demoteMember(alice.ctx, {
      spaceId: lib.spaceId,
      shareId,
      identityId: bob.vault.identity.public.id,
    });
    // Its grant says editor, its person is a reader now: it reads published only.
    const info = await pages.loadPage(agent.ctx, lib.page.pageId);
    expect([info.role, info.heads.draftHead]).toEqual(['reader', null]);
    expect(await rejection(pages.editDraft(agent.ctx, lib.page, { markdown: 'no' }))).toBe(
      'not-found',
    );

    await sharing.removeMember(alice.ctx, {
      spaceId: lib.spaceId,
      shareId,
      identityId: bob.vault.identity.public.id,
    });
    expect(await rejection(pages.loadPage(agent.ctx, lib.page.pageId))).toBe('not-found');
    expect(await rejection(spaceOperations.loadTree(agent.ctx, lib.spaceId))).toBe('not-found');
    const grants = await t.db
      .select()
      .from(schema.agentGrants)
      .where(eq(schema.agentGrants.agentId, agent.agentId));
    expect(grants).toEqual([]);
    // What Alice saves now is under a key version the agent never gets.
    await pages.editDraft(alice.ctx, lib.page, { markdown: 'after the removal' });
    const { heads } = await pages.loadPage(alice.ctx, lib.page.pageId);
    if (!heads.draftHead) throw new Error('expected a draft');
    const served = await agent.api.call(pageRoutes.fetchRevisions, {
      body: { ids: [heads.draftHead] },
    });
    expect(served.revisions).toEqual([]);
    const leaked = await alice.api.call(pageRoutes.fetchRevisions, {
      body: { ids: [heads.draftHead] },
    });
    expect(leaked.revisions[0]?.wrap?.keyVersion).toBe(3);
    expect(agent.ctx.keyring.versions(lib.spaceId, shareId).map((v) => v.keyVersion)).not.toContain(
      3,
    );
  });

  it('publishes only when its grant and its person both may', async () => {
    const { alice, bob, lib, shareId } = await sharedLibrary('editor', true);
    const writer = await enrolledAgent(t, bob, {
      picks: [{ spaceId: lib.spaceId, folderId: lib.shared, role: 'editor' }],
    });
    expect(await rejection(pages.publishPage(writer.ctx, lib.page))).toBe('forbidden');
    const publisher = await enrolledAgent(t, bob, {
      picks: [{ spaceId: lib.spaceId, folderId: lib.shared, role: 'editor', canPublish: true }],
    });
    await pages.publishPage(publisher.ctx, lib.page);
    // Bob loses publish rights: so does his agent, whatever its grant says.
    await sharing.setPublishRights(alice.ctx, {
      spaceId: lib.spaceId,
      shareId,
      identityId: bob.vault.identity.public.id,
      canPublish: false,
    });
    expect(await rejection(pages.publishPage(publisher.ctx, lib.page))).toBe('forbidden');
    // Nor may it unpublish.
    const { heads, permissionVersion } = await pages.loadPage(alice.ctx, lib.page.pageId);
    if (!heads.publishedHead) throw new Error('expected the page published');
    const seen = { publishedHead: heads.publishedHead, permissionVersion };
    expect(await rejection(pages.unpublishPage(publisher.ctx, lib.page, seen))).toBe('forbidden');
  });

  it('never reaches the owner region unless its person picks a folder there', async () => {
    const alice = await personWithVault(t);
    const lib = await library(alice);
    const agent = await enrolledAgent(t, alice);
    expect(await rejection(spaceOperations.loadTree(agent.ctx, lib.spaceId))).toBe('not-found');
    expect(await rejection(pages.loadPage(agent.ctx, lib.page.pageId))).toBe('not-found');
    const shareId = await agentOperations.pickInOwnerRegion(alice.ctx, {
      agentId: agent.agentId as IdentityId,
      preview: await sharing.previewShare(alice.ctx, { spaceId: lib.spaceId, rootId: lib.shared }),
      role: 'reader',
    });
    const reader = await openAgentSession(agent.api, {
      ...agent.kept,
      identity: agent.identity,
      person: alice.vault.identity.public,
    });
    const tree = await spaceOperations.loadTree(reader, lib.spaceId);
    expect(tree.shares.map((s) => s.shareId)).toEqual([shareId]);
    expect(tree.pages.map((p) => p.id)).toEqual([lib.page.pageId]);
    const { heads } = await pages.loadPage(reader, lib.page.pageId);
    expect(heads.draftHead).toBeNull();
    if (!heads.publishedHead) throw new Error('expected a published version');
    const opened = await pages.openRevisionOf(reader, lib.page, 'published', heads.publishedHead);
    expect(opened.opened.kind === 'current' && opened.opened.payload.markdown).toBe(
      'published words',
    );
  });

  it('isn’t sealed to by owners: a rotation leaves it waiting for its person', async () => {
    const { alice, bob, lib, shareId } = await sharedLibrary('editor');
    const agent = await enrolledAgent(t, bob, {
      picks: [{ spaceId: lib.spaceId, folderId: lib.shared, role: 'editor' }],
    });
    // Owners don't seal to it, so after a rotation it waits for its person.
    await sharing.rotateKeys(alice.ctx, { spaceId: lib.spaceId, shareId });
    expect(await rejection(pages.editDraft(agent.ctx, lib.page, { markdown: 'stale' }))).toBe(
      'key-version',
    );
    // Bob's app, at its next unlock, seals it the new version.
    expect(await agentOperations.resealAgents(bob.ctx)).toBe(1);
    const fresh = await openAgentSession(agent.api, {
      ...agent.kept,
      identity: agent.identity,
      person: bob.vault.identity.public,
    });
    await pages.editDraft(fresh, lib.page, { markdown: 'after the rotation' });
  });

  it('ends with its person’s ownership of the space', async () => {
    const alice = await personWithVault(t);
    const carol = await personWithVault(t);
    const lib = await library(alice);
    const shareId = await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [],
    });
    await owners.addCoOwner(alice.ctx, { spaceId: lib.spaceId, person: await find(alice, carol) });
    const adder = await owners.ownerToConfirm(carol.ctx, lib.spaceId);
    if (!adder) throw new Error('expected an adder to confirm');
    await owners.confirmOwner(carol.ctx, { spaceId: lib.spaceId, adder });
    const agent = await enrolledAgent(t, carol, {
      picks: [{ spaceId: lib.spaceId, folderId: lib.shared, role: 'editor' }],
    });
    expect((await pages.loadPage(agent.ctx, lib.page.pageId)).role).toBe('editor');
    await owners.applyOwnerRemoval(
      alice.ctx,
      await owners.planOwnerRemoval(alice.ctx, {
        spaceId: lib.spaceId,
        ownerId: carol.vault.identity.public.id,
      }),
    );
    expect(await rejection(pages.loadPage(agent.ctx, lib.page.pageId))).toBe('not-found');
    expect(
      await t.db.select().from(schema.agentGrants).where(eq(schema.agentGrants.shareId, shareId)),
    ).toEqual([]);
  });
});

describe('what people see of agents', () => {
  it('tells editors of an agent’s latest edit, and readers nothing', async () => {
    const { alice, bob, lib, shareId } = await sharedLibrary('editor', true);
    const carol = await personWithVault(t);
    await sharing.addMember(alice.ctx, {
      spaceId: lib.spaceId,
      shareId,
      ...(await invite(alice, carol, 'reader')),
    });
    const agent = await enrolledAgent(t, bob, {
      name: 'kitchen agent',
      picks: [{ spaceId: lib.spaceId, folderId: lib.shared, role: 'editor', canPublish: true }],
    });
    await pages.editDraft(agent.ctx, lib.page, { markdown: 'the agent’s words' });
    const edit = {
      agentId: agent.agentId,
      agentName: 'kitchen agent',
      personId: bob.vault.identity.public.id,
      personName: bob.email.split('@')[0],
    };
    expect((await pages.loadPage(alice.ctx, lib.page.pageId)).agentEdit).toMatchObject(edit);
    expect((await spaceOperations.loadTree(alice.ctx, lib.spaceId)).agentActivity).toMatchObject({
      ...edit,
      pageId: lib.page.pageId,
      draftOnly: true,
    });
    // A reader never learns a draft exists, nor which agent wrote it.
    expect((await pages.loadPage(carol.ctx, lib.page.pageId)).agentEdit).toBeNull();
    expect((await spaceOperations.loadTree(carol.ctx, lib.spaceId)).agentActivity).toBeNull();
  });
});

describe('revoking an agent', () => {
  it('ends its token when its person revokes it', async () => {
    const person = await personWithVault(t);
    const agent = await enrolledAgent(t, person);
    await agentOperations.revokeAgent(person.ctx, agent.agentId as IdentityId);
    expect((await asAgent(t, agent.token, '/api/spaces')).status).toBe(401);
    // Its session won't open again either.
    expect(
      await rejection(
        openAgentSession(agent.api, {
          ...agent.kept,
          identity: agent.identity,
          person: person.vault.identity.public,
        }),
      ),
    ).toBe('unauthenticated');
  });

  // What ending every credential of an account leaves (section 9.7): the
  // token dead, and the agent revoked, with no grants left.
  async function expectEnded(agent: { agentId: string; token?: string }) {
    if (agent.token) expect((await asAgent(t, agent.token, '/api/spaces')).status).toBe(401);
    const [identity] = await t.db
      .select({ revokedAt: schema.identities.revokedAt })
      .from(schema.identities)
      .where(eq(schema.identities.id, agent.agentId));
    expect(identity?.revokedAt).not.toBeNull();
    expect(
      await t.db
        .select()
        .from(schema.agentGrants)
        .where(eq(schema.agentGrants.agentId, agent.agentId)),
    ).toEqual([]);
  }

  it('ends every token on a password reset, and the agents with them', async () => {
    const { bob, lib } = await sharedLibrary();
    const picks = [{ spaceId: lib.spaceId, folderId: lib.shared, role: 'reader' as const }];
    const agent = await enrolledAgent(t, bob, { picks });
    // Approved, but its CLI hasn't collected the token yet.
    const uncollected = await approvedAgent(t, bob, { picks });
    await resetPassword(t, bob.email, 'another long passphrase');
    await expectEnded(agent);
    await expectEnded(uncollected);
    expect(
      await agentEnrollment.pollEnrollment(uncollected.cli.api, uncollected.cli.pending),
    ).toEqual({ state: 'cancelled' });
    // A password written by anything at all does the same.
    const written = await personWithVault(t);
    const writtenAgent = await enrolledAgent(t, written);
    await t.db
      .update(schema.accounts)
      .set({ password: 'another hash' })
      .where(eq(schema.accounts.userId, written.id));
    await expectEnded(writtenAgent);
  });
});
