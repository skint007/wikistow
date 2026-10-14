// Revision downloads work out access for a whole batch at once. These check
// it against `accessTo` page by page, as downloads worked it out before, over
// random trees, shares, members, owners, agents' picks and reader histories.
import {
  FolderId,
  newId,
  PageId,
  RevisionId,
  ShareId,
  spaceOperations,
  type SpaceId,
} from '@wikistow/client';
import {
  accessTo,
  accessToPages,
  canEdit,
  MAX_DEPTH,
  readableRevisions,
  schema,
  type Access,
  type Holder,
  type RevisionPlace,
} from '@wikistow/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { personWithVault } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import type { Person } from './support/sharing.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

/** A repeatable random number in [0, 1), so a failing seed can be run again. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 2 ** 32;
  };
}

const human = (person: Person): Holder => ({
  identity: { id: person.ctx.identity.public.id },
  personId: null,
});

/** An agent of `person`, as enrolling one stores it; these tests never sign as it. */
async function agentOf(person: Person): Promise<Holder> {
  const agentId = `agent-${newId(ShareId)}`;
  await t.db.insert(schema.identities).values({
    id: agentId,
    keyVersion: 1,
    accountId: person.id,
    kind: 'agent',
    boxPublicKey: 'unused',
    signPublicKey: 'unused',
  });
  const { id, keyVersion } = person.ctx.identity.public;
  await t.db.insert(schema.agentProfiles).values({
    agentId,
    accountId: person.id,
    ownerIdentityId: id,
    ownerKeyVersion: keyVersion,
    name: 'agent',
    enrollment: {},
  });
  return { identity: { id: agentId }, personId: id };
}

/**
 * A space with random folders and pages, a chain deeper than `MAX_DEPTH` and
 * a cycle, random shares (nested too), members, owners, agents' grants and
 * picks, and pages published, unpublished and republished. Returns the
 * revisions of every page, its draft and each published version, and the
 * pages in the chain's middle and at its bottom.
 */
async function randomSpace(
  owner: Person,
  people: { coOwner: Person; exOwner: Person; members: Person[] },
  agents: Holder[],
  seed: number,
): Promise<{ places: RevisionPlace[]; middlePage: string; bottomPage: string }> {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const spaceId: SpaceId = await spaceOperations.createSpace(owner.ctx, { name: `Seed ${seed}` });
  await t.db.insert(schema.spaceOwners).values([
    { spaceId, identityId: people.coOwner.ctx.identity.public.id },
    { spaceId, identityId: people.exOwner.ctx.identity.public.id, removedAt: new Date() },
  ]);

  const nodes: (typeof schema.nodes.$inferInsert)[] = [];
  const folder = (parentId: string | null) => {
    const id = newId(FolderId);
    nodes.push({ id, spaceId, parentId, kind: 'folder' });
    return id;
  };
  const folders: string[] = [];
  for (let i = 0; i < 10; i++) folders.push(folder(next() < 0.3 || i === 0 ? null : pick(folders)));
  // A chain whose top is out of reach from its bottom, but not from the middle.
  const chainTop = folder(null);
  let chain = chainTop;
  let middle = chainTop;
  for (let depth = 1; depth <= MAX_DEPTH + 2; depth++) {
    chain = folder(chain);
    if (depth === MAX_DEPTH - 2) middle = chain;
  }
  const cycle = [folder(null), folder(null)];
  folders.push(middle, chain, ...cycle);
  const pages: string[] = [];
  const page = (parentId: string | null) => {
    const id = newId(PageId);
    nodes.push({ id, spaceId, parentId, kind: 'page' });
    pages.push(id);
    return id;
  };
  for (let i = 0; i < 25; i++) page(next() < 0.15 ? null : pick(folders));
  const bottomPage = page(chain);
  const middlePage = page(middle);
  page(cycle[0] ?? null);
  // Parents first, so each one's foreign key holds; then the cycle closes.
  await t.db.insert(schema.nodes).values(nodes.filter((node) => node.kind === 'folder'));
  await t.db.insert(schema.nodes).values(nodes.filter((node) => node.kind === 'page'));
  const [first, second] = cycle;
  if (!first || !second) throw new Error('expected a cycle');
  await t.db.update(schema.nodes).set({ parentId: second }).where(eq(schema.nodes.id, first));
  await t.db.update(schema.nodes).set({ parentId: first }).where(eq(schema.nodes.id, second));

  // Shares nest here, though the server never makes them so; the chain's only root is its top.
  const roots = [
    chainTop,
    ...folders.filter((id) => id !== middle && id !== chain && next() < 0.25),
  ];
  // Seed 1 always has a space share: it holds the chain's bottom.
  const shares = [...roots, ...(next() < 0.5 || seed === 1 ? [null] : [])].map((rootId) => ({
    id: newId(ShareId),
    spaceId,
    rootId,
  }));
  await t.db.insert(schema.shares).values(shares);
  const members = [people.coOwner, people.exOwner, ...people.members];
  const roles = [null, 'reader', 'editor', 'publisher'] as const;
  const memberRows = shares.flatMap((share) =>
    members.flatMap((person) => {
      const role = pick(roles);
      if (role === null) return [];
      const { id, keyVersion } = person.ctx.identity.public;
      return [
        {
          shareId: share.id,
          identityId: id,
          keyVersion,
          role: role === 'publisher' ? ('editor' as const) : role,
          canPublish: role === 'publisher',
        },
      ];
    }),
  );
  if (memberRows.length > 0) await t.db.insert(schema.shareMembers).values(memberRows);
  // The first agent picks the chain's top in its share and in the space
  // share: the chain's middle is in reach, its bottom past `MAX_DEPTH`.
  const picksTop = (agent: Holder, share: { rootId: string | null }) =>
    agent === agents[0] && (share.rootId === chainTop || share.rootId === null);
  const grants = agents.flatMap((agent) =>
    shares.flatMap((share) => {
      if (next() < 0.4 && !picksTop(agent, share)) return [];
      const role = pick(['reader', 'editor', 'publisher'] as const);
      // A pick anywhere, inside the share or not.
      const folderId = next() < 0.4 ? null : pick(folders);
      return [
        {
          agentId: agent.identity.id,
          shareId: share.id,
          spaceId,
          folderId: picksTop(agent, share) ? chainTop : folderId,
          role: role === 'publisher' ? ('editor' as const) : role,
          canPublish: role === 'publisher',
        },
      ];
    }),
  );
  if (grants.length > 0) await t.db.insert(schema.agentGrants).values(grants);

  const places: RevisionPlace[] = [];
  const heads = pages.map((pageId) => {
    const publishedCount = Math.floor(next() * 4);
    const draftHead = newId(RevisionId);
    places.push({ id: draftHead, pageId, spaceId, audience: 'draft', publishedSeq: null });
    const published = Array.from({ length: publishedCount }, (_, seq) => {
      const id = newId(RevisionId);
      places.push({ id, pageId, spaceId, audience: 'published', publishedSeq: seq + 1 });
      return id;
    });
    return {
      pageId,
      draftHead,
      // Unpublished pages keep their versions, out of readers' reach.
      publishedHead: next() < 0.25 ? null : (published.at(-1) ?? null),
      draftCount: 1,
      publishedCount,
      readerHistoryFrom: 1 + Math.floor(next() * (publishedCount + 1)),
    };
  });
  await t.db.insert(schema.pageHeads).values(heads);
  return { places, middlePage, bottomPage };
}

/** What revision downloads worked out before: `accessTo` and the reader history, page by page. */
async function oneByOne(who: Holder, places: readonly RevisionPlace[]) {
  const access = new Map<string, Access | null>();
  const history = new Map<string, number | null>();
  const readable = new Map<string, number>();
  for (const place of places) {
    if (!access.has(place.pageId)) {
      const at = await accessTo(t.db, who, { spaceId: place.spaceId, nodeId: place.pageId });
      access.set(place.pageId, at && { role: at.role, canPublish: at.canPublish });
    }
    const at = access.get(place.pageId) ?? null;
    if (canEdit(at)) {
      readable.set(place.id, 1);
      continue;
    }
    if (at !== null && !history.has(place.pageId)) {
      const [heads] = await t.db
        .select()
        .from(schema.pageHeads)
        .where(eq(schema.pageHeads.pageId, place.pageId));
      history.set(place.pageId, heads?.publishedHead ? heads.readerHistoryFrom : null);
    }
    const from = history.get(place.pageId) ?? null;
    if (
      at !== null &&
      place.audience === 'published' &&
      from !== null &&
      place.publishedSeq !== null &&
      place.publishedSeq >= from
    ) {
      readable.set(place.id, from);
    }
  }
  return { access, readable };
}

describe('access for a batch of revisions', () => {
  it(
    'is what accessTo and the reader history give page by page, for every role',
    { timeout: 180_000 },
    async () => {
      const owner = await personWithVault(t);
      const coOwner = await personWithVault(t);
      const exOwner = await personWithVault(t);
      const members = [await personWithVault(t), await personWithVault(t)];
      const outsider = await personWithVault(t);
      const ownersAgent = await agentOf(owner);
      const agents = [
        ownersAgent,
        await agentOf(coOwner),
        await agentOf(exOwner),
        ...(await Promise.all(members.map(agentOf))),
      ];
      const holders = [owner, coOwner, exOwner, ...members, outsider].map(human).concat(agents);
      const seen = new Set<string>();
      const spaceIds: string[] = [];
      let elsewhere: RevisionPlace | undefined;
      for (let seed = 1; seed <= 2; seed++) {
        const { places, middlePage, bottomPage } = await randomSpace(
          owner,
          { coOwner, exOwner, members },
          agents,
          seed,
        );
        const [spaceId] = new Set(places.map((place) => place.spaceId));
        if (!spaceId) throw new Error('expected a space');
        spaceIds.push(spaceId);
        elsewhere ??= places[0];
        const pageIds = [...new Set(places.map((place) => place.pageId))];
        for (const [n, who] of holders.entries()) {
          const expected = await oneByOne(who, places);
          const label = `seed ${seed}, holder ${n}`;
          expect(await accessToPages(t.db, who, spaceId, pageIds), label).toEqual(expected.access);
          expect(await readableRevisions(t.db, who, places), label).toEqual(expected.readable);
          for (const at of expected.access.values()) {
            seen.add(at ? `${who.personId ? 'agent ' : ''}${at.role}/${at.canPublish}` : 'none');
          }
        }
        // The first agent's pick of the chain's top reaches the middle, not the bottom.
        const picked = await accessToPages(t.db, ownersAgent, spaceId, [middlePage, bottomPage]);
        expect(picked.get(middlePage), `seed ${seed}`).not.toBeNull();
        expect(picked.get(bottomPage), `seed ${seed}`).toBeNull();
      }
      // The one difference from `accessTo`, which looks a page up wherever it
      // is: a batch is worked out within one space, and a page from another
      // space gets nothing there, though its owner owns both.
      const [, otherSpace] = spaceIds;
      if (!elsewhere || !otherSpace) throw new Error('expected two spaces');
      const where = { spaceId: elsewhere.spaceId, nodeId: elsewhere.pageId };
      expect(await accessTo(t.db, human(owner), where)).toMatchObject({ role: 'owner' });
      expect(await accessToPages(t.db, human(owner), otherSpace, [elsewhere.pageId])).toEqual(
        new Map([[elsewhere.pageId, null]]),
      );
      const misplaced = { ...elsewhere, spaceId: otherSpace };
      expect(await readableRevisions(t.db, human(owner), [misplaced])).toEqual(new Map());
      // Every role came up, so the comparisons above weren't vacuous.
      expect([...seen].sort()).toEqual(
        [
          'none',
          'owner/true',
          'editor/true',
          'editor/false',
          'reader/false',
          'agent editor/true',
          'agent editor/false',
          'agent reader/false',
        ].sort(),
      );
    },
  );
});
