// People sharing a library of pages, for tests of shares and owners.
import {
  grantMetadataKeyV2,
  grantRevisionKeyV2,
  pageOperations as pages,
  sharingOperations as sharing,
  spaceOperations,
  type ClientContext,
  type FolderId,
  type PageId,
  type SpaceId,
} from '@wikistow/client';
import type { KeyEnvelopeV2, MetadataEnvelopeV2, RouteDef, ShareId } from '@wikistow/contracts';
import type { personWithVault } from './content.ts';

export type Person = Awaited<ReturnType<typeof personWithVault>>;

/** `other` as `owner`'s app finds them: by the email `owner` typed. */
export async function find(owner: Person, other: Person) {
  const person = await sharing.findPerson(owner.ctx, other.email);
  if (!person) throw new Error(`expected to find ${other.email}`);
  return person;
}

export const invite = async (
  owner: Person,
  other: Person,
  role: 'reader' | 'editor',
  canPublish = false,
) => ({ person: await find(owner, other), role, canPublish });

/**
 * Make a share as the owner's app does once its person confirms the
 * preview: the preview is of the server's tree, unchanged.
 */
export async function shareFolder(
  ctx: ClientContext,
  {
    spaceId,
    rootId,
    people,
  }: {
    spaceId: SpaceId;
    rootId: FolderId | null;
    people: Parameters<typeof sharing.shareFolder>[1]['people'];
  },
) {
  return sharing.shareFolder(ctx, {
    preview: await sharing.previewShare(ctx, { spaceId, rootId }),
    people,
  });
}

export const ABOVE = 'PLAINTEXT-ANCESTOR-NAME-3f1a';
export const SPACE = 'PLAINTEXT-SPACE-NAME-7c2d';

/**
 * A space named `SPACE`, with a folder named `ABOVE` at the top, a folder
 * `Shared` inside it holding one published page with a newer draft, and a
 * page beside `Shared` that stays private. Built in `existing`, if given.
 */
export async function library(owner: Person, existing?: SpaceId) {
  const spaceId = existing ?? (await spaceOperations.createSpace(owner.ctx, { name: SPACE }));
  const above = await spaceOperations.createFolder(owner.ctx, {
    spaceId,
    parentId: null,
    name: ABOVE,
  });
  const shared = await spaceOperations.createFolder(owner.ctx, {
    spaceId,
    parentId: above,
    name: 'Shared',
  });
  const pageId = await pages.createPage(owner.ctx, {
    spaceId,
    parentId: shared,
    title: 'Plan',
    markdown: 'published words',
  });
  const page = { spaceId, pageId };
  await pages.publishPage(owner.ctx, page);
  await pages.editDraft(owner.ctx, page, { markdown: 'draft words' });
  const beside = await pages.createPage(owner.ctx, {
    spaceId,
    parentId: above,
    title: 'Private',
  });
  return { spaceId, above, shared, page, beside: { spaceId, pageId: beside } };
}

/**
 * A context whose calls to `route` go out with `change` applied to their
 * body: the owner's app, but a test can break exactly one thing in a request
 * the real operation builds.
 */
export function tampering(
  ctx: ClientContext,
  route: RouteDef,
  change: (body: Record<string, unknown>) => Record<string, unknown>,
): ClientContext {
  type Input = { body?: Record<string, unknown> } | undefined;
  const send = ctx.api.call as unknown as (r: RouteDef, input: Input) => Promise<unknown>;
  const call = ((r: RouteDef, input: Input) =>
    send(
      r,
      r === route && input?.body ? { ...input, body: change(input.body) } : input,
    )) as ClientContext['api']['call'];
  return { ...ctx, api: { ...ctx.api, call } };
}

/** A request as an operation sends it. */
export type Sent = {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
};

/** A lying server's answer to one route, which may ask the real server (`send`). */
export type Answer = (
  input: Sent,
  send: <T = Record<string, unknown>>(input: Sent) => Promise<T>,
) => Promise<unknown>;

/**
 * The person's app talking to a server that lies: each call to a route in
 * `answers` gets that function's answer, which may ask the real server
 * (`send`). `sent` lists every route called, in order.
 */
export function lyingServer(
  ctx: ClientContext,
  answers: Map<RouteDef, Answer>,
): { ctx: ClientContext; sent: RouteDef[] } {
  const sent: RouteDef[] = [];
  const real = ctx.api.call as unknown as <T>(
    route: RouteDef,
    input: Sent,
    options?: unknown,
  ) => Promise<T>;
  const call = ((route: RouteDef, input: Sent, options?: unknown) => {
    sent.push(route);
    const answer = answers.get(route);
    return answer
      ? answer(input, (changed) => real(route, changed, options))
      : real(route, input, options);
  }) as ClientContext['api']['call'];
  return { ctx: { ...ctx, api: { ...ctx.api, call } }, sent };
}

export const draftHead = async (person: Person, page: { pageId: PageId }) => {
  const { heads } = await pages.loadPage(person.ctx, page.pageId);
  if (!heads.draftHead) throw new Error('expected a draft');
  return heads.draftHead;
};

/**
 * The envelopes an owner's app sends to end a share (section 6.9, step 2):
 * every record the server scans as wrapped under it, opened through its
 * wrap and sealed to each sealing owner.
 */
export async function sealEnding(
  ctx: ClientContext,
  { spaceId, shareId }: { spaceId: SpaceId; shareId: ShareId },
) {
  const keys = await sharing.ownerKeys(ctx, spaceId);
  const owners = keys.owners.sealingOwners();
  const keyEnvelopes: KeyEnvelopeV2[] = [];
  const metadataEnvelopes: MetadataEnvelopeV2[] = [];
  await sharing.forEachRecordKey(
    ctx,
    keys,
    spaceId,
    { scope: 'share', shareId },
    (item, contentKey) => {
      for (const recipient of owners) {
        const grant = { granter: ctx.identity, contentKey, recipient };
        if (item.kind === 'revision') {
          keyEnvelopes.push(grantRevisionKeyV2({ ...grant, record: item.record }));
        } else {
          metadataEnvelopes.push(grantMetadataKeyV2({ ...grant, record: item.record }));
        }
      }
    },
    { from: { kind: 'share', spaceId, shareId } },
  );
  return { keyEnvelopes, metadataEnvelopes };
}
