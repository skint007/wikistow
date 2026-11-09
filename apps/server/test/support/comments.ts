// Comments sealed as the comments module will seal them (protocol section
// 5.9), for tests of the server before the app has that module: format 1.0
// payloads, metadata records v2 of kind `comment`, and key material in the
// page's region by the comment's audience.
import { randomBytes } from 'node:crypto';
import {
  aeadDecrypt,
  aeadEncrypt,
  canonical,
  grantMetadataKeyV2,
  hash,
  keyCommitment,
  metadataRecordV2Bytes,
  newId,
  openSealedKey,
  sealedBytes,
  sharingOperations as sharing,
  sign,
  spaceKeys,
  unwrapContentKey,
  utf8,
  wrapContentKey,
  type ClientContext,
  type PageId,
  type SpaceId,
  type WrapSubject,
} from '@wikistow/client';
import { writeTargetOf } from '@wikistow/client/testing';
import {
  CommentId,
  commentRoutes,
  FolderId,
  FolderKeyEnvelope,
  MetadataRevisionId,
  ownerRoutes,
  sharingRoutes,
  type Audience,
  ShareId,
  type CommentRecord,
  type KeyWrap,
  type MetadataEnvelopeV2,
  type PublicIdentity,
  type RouteDef,
} from '@wikistow/contracts';
import type { Sent } from './sharing.ts';

/** A comment a test wrote, with what it needs to give its key to others. */
export type TestComment = {
  commentId: CommentId;
  versionId: MetadataRevisionId;
  spaceId: SpaceId;
  audience: Audience;
  record: CommentRecord;
  contentKey: Uint8Array;
};

type Page = { spaceId: SpaceId; pageId: PageId };

/** A comment's wrap subject: its audience is the wrap's class (section 5.9, **For the build**). */
const subjectOf = (c: Pick<TestComment, 'spaceId' | 'audience' | 'commentId' | 'versionId'>) =>
  ({
    spaceId: c.spaceId,
    audienceClass: c.audience,
    subjectKind: 'comment',
    subjectId: c.commentId,
    versionId: c.versionId,
  }) satisfies WrapSubject;

const payloadAd = (
  ctx: ClientContext,
  record: Pick<
    CommentRecord,
    'spaceId' | 'subjectKind' | 'subjectId' | 'metadataRevisionId' | 'authorId' | 'authorKeyVersion'
  >,
) =>
  canonical('metadata-payload/v1', [
    ctx.installationId,
    record.spaceId,
    record.subjectKind,
    record.subjectId,
    record.metadataRevisionId,
    record.authorId,
    record.authorKeyVersion,
  ]);

/**
 * A comment version sealed by `ctx` on `page`, as a request's body, in the
 * page's region as the server's tree puts it now. `basedOn` makes an edit
 * of `commentId`.
 */
export async function sealComment(
  ctx: ClientContext,
  page: Page,
  {
    audience,
    text,
    thread = null,
    threadAuthor = null,
    commentId = newId(CommentId),
    versionId = newId(MetadataRevisionId),
    basedOn = null,
  }: {
    audience: Audience;
    text: string;
    thread?: CommentId | null;
    threadAuthor?: string | null;
    commentId?: CommentId;
    versionId?: MetadataRevisionId;
    basedOn?: MetadataRevisionId | null;
  },
) {
  const { permissionVersion, keyTarget } = await writeTargetOf(ctx, page.spaceId, page.pageId);
  const contentKey = new Uint8Array(randomBytes(32));
  const author = ctx.identity.public;
  const bound = {
    protocol: 2 as const,
    installationId: ctx.installationId,
    spaceId: page.spaceId,
    subjectKind: 'comment' as const,
    subjectId: commentId,
    metadataRevisionId: versionId,
    basedOn,
    authorId: author.id,
    authorKeyVersion: author.keyVersion,
  };
  const body = { format: { major: 1, minor: 0 }, pageId: page.pageId, thread, threadAuthor };
  const plaintext = utf8(JSON.stringify({ ...body, audience, text, extensions: {} }));
  const payload = aeadEncrypt({
    key: contentKey,
    plaintext,
    ad: payloadAd(ctx, bound),
  });
  const record: CommentRecord = {
    ...bound,
    payloadHash: hash(sealedBytes(payload)),
    keyCommitment: keyCommitment(contentKey),
  };
  const comment: TestComment = {
    commentId,
    versionId,
    spaceId: page.spaceId,
    audience,
    record,
    contentKey,
  };
  let wrap: KeyWrap | null = null;
  let envelopes: MetadataEnvelopeV2[] = [];
  if (keyTarget.share) {
    const folderKey =
      audience === 'draft' ? keyTarget.share.draftKey : keyTarget.share.publishedKey;
    if (!folderKey) throw new Error('A reader holds no draft key');
    wrap = wrapContentKey({
      installationId: ctx.installationId,
      subject: subjectOf(comment),
      shareId: keyTarget.share.shareId,
      keyVersion: keyTarget.share.keyVersion,
      folderKey,
      contentKey,
    });
  } else {
    envelopes = keyTarget.recipients.map((recipient) =>
      grantMetadataKeyV2({ granter: ctx.identity, record, contentKey, recipient }),
    );
  }
  const metadata = {
    record,
    signature: sign(ctx.identity, metadataRecordV2Bytes(record)),
    payload,
  };
  return { comment, commit: { metadata, wrap, envelopes, permissionVersion } };
}

type Sealed = Awaited<ReturnType<typeof sealComment>>;

/**
 * Send a sealed comment through the route, as a first comment or a reply,
 * for the audience and thread the request names, which may differ from
 * those it was sealed with.
 */
export const sendComment = (
  ctx: ClientContext,
  pageId: PageId,
  { comment, commit }: Sealed,
  {
    audience = comment.audience,
    thread = null,
    commentId = comment.commentId,
  }: { audience?: Audience; thread?: CommentId | null; commentId?: CommentId } = {},
) =>
  ctx.api.call(commentRoutes.addComment, {
    params: { pageId },
    body: { commentId, thread, audience, ...commit },
  });

/** Write a comment through the route, as the app will. */
export async function postComment(
  ctx: ClientContext,
  page: Page,
  options: Parameters<typeof sealComment>[2],
): Promise<TestComment> {
  const sealed = await sealComment(ctx, page, options);
  await sendComment(ctx, page.pageId, sealed, { thread: options.thread ?? null });
  return sealed.comment;
}

/** Its author edits a comment, based on its current version. */
export async function editComment(
  ctx: ClientContext,
  page: Page,
  current: TestComment,
  text: string,
): Promise<TestComment> {
  const { comment, commit } = await sealComment(ctx, page, {
    audience: current.audience,
    text,
    commentId: current.commentId,
    basedOn: current.versionId,
  });
  await ctx.api.call(commentRoutes.editComment, {
    params: { commentId: current.commentId },
    body: commit,
  });
  return comment;
}

/** The page's threads as the server serves them to `ctx`. */
export const threadsOf = (ctx: ClientContext, pageId: PageId) =>
  ctx.api.call(commentRoutes.listComments, { params: { pageId } });

/**
 * The text of a served comment, opened through the key material `ctx` is
 * served it with: its wrap and the folder keys `ctx` holds, or its envelope
 * to `ctx`. Enough to show the key material is right, not the opening
 * checks of section 5.9, which are the app's.
 */
export async function textOf(
  ctx: ClientContext,
  served: commentRoutes.SealedCommentVersion,
  audience: Audience,
): Promise<string> {
  const { record, payload } = served.comment;
  let contentKey: Uint8Array;
  if (served.wrap) {
    // The folder keys this person holds now.
    await spaceKeys(ctx, record.spaceId, { refresh: true });
    contentKey = unwrapContentKey({
      installationId: ctx.installationId,
      subject: subjectOf({
        spaceId: record.spaceId,
        audience,
        commentId: record.subjectId,
        versionId: record.metadataRevisionId,
      }),
      wrap: served.wrap,
      keyring: ctx.keyring,
      commitment: record.keyCommitment,
    });
  } else {
    const [envelope] = served.envelopes;
    if (!envelope) throw new Error('No key material for this comment');
    contentKey = openSealedKey(ctx.identity, envelope.sealedKey);
  }
  const plaintext = aeadDecrypt({ key: contentKey, sealed: payload, ad: payloadAd(ctx, record) });
  const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (typeof parsed !== 'object' || parsed === null || !('text' in parsed)) {
    throw new Error('Not a comment payload');
  }
  return String(parsed.text);
}

/**
 * `ctx` as an owner's app that handles comments in the operations that
 * cover a subtree (section 5.9), before the app does: its scans ask for
 * comments and leave them out of what the operation sees, and its requests
 * carry the key material of `comments` too, for the region the operation
 * puts them in. With `comments` left out of a request, the server sees an
 * app that asked for comments and forgot them.
 */
export function handlingComments(
  ctx: ClientContext,
  comments: readonly TestComment[],
  { newOwner, send = true }: { newOwner?: PublicIdentity; send?: boolean } = {},
): ClientContext {
  type Call = (route: RouteDef, input: Sent, options?: unknown) => Promise<unknown>;
  const real = ctx.api.call as unknown as Call;
  const owners = async (spaceId: SpaceId) =>
    (await sharing.ownerKeys(ctx, spaceId)).owners.sealingOwners();
  const sealed = (recipients: readonly PublicIdentity[]) =>
    comments.flatMap((comment) =>
      recipients.map((recipient) =>
        grantMetadataKeyV2({
          granter: ctx.identity,
          record: comment.record,
          contentKey: comment.contentKey,
          recipient,
        }),
      ),
    );
  const wrapped = (
    keys: { draftKey: Uint8Array | null; publishedKey: Uint8Array },
    { shareId, keyVersion }: { shareId: ShareId; keyVersion: number },
  ) =>
    comments.map((comment) => {
      const folderKey = comment.audience === 'draft' ? keys.draftKey : keys.publishedKey;
      if (!folderKey) throw new Error('The owner holds every key');
      return {
        subjectKind: 'comment' as const,
        versionId: comment.versionId,
        wrap: wrapContentKey({
          installationId: ctx.installationId,
          subject: subjectOf(comment),
          shareId,
          keyVersion,
          folderKey,
          contentKey: comment.contentKey,
        }),
      };
    });
  type Body = Record<string, unknown> & {
    wraps?: unknown[];
    keyEnvelopes?: unknown[];
    metadataEnvelopes?: unknown[];
  };
  const add = async (route: RouteDef, input: Sent): Promise<Sent> => {
    const spaceId = comments[0]?.spaceId;
    if (!send || !spaceId) return input;
    const body = input.body as Body;
    if (route === sharingRoutes.makeShare) {
      // The new share's keys, from the envelope the owner seals to themself.
      const mine = FolderKeyEnvelope.array()
        .parse(body['envelopes'])
        .find((e) => e.recipientId === ctx.identity.public.id);
      if (!mine?.draftKey) throw new Error('No envelope to the owner');
      const keys = {
        draftKey: openSealedKey(ctx.identity, mine.draftKey),
        publishedKey: openSealedKey(ctx.identity, mine.publishedKey),
      };
      const wraps = wrapped(keys, { shareId: ShareId.parse(body['shareId']), keyVersion: 1 });
      return { ...input, body: { ...body, wraps: [...(body.wraps ?? []), ...wraps] } };
    }
    if (route === sharingRoutes.move) {
      const crossing =
        (body.wraps?.length ?? 0) + (body.keyEnvelopes?.length ?? 0) > 0 ||
        (body.metadataEnvelopes?.length ?? 0) > 0;
      if (!crossing) return input;
      const to = await writeTargetOf(ctx, spaceId, FolderId.nullable().parse(body['parentId']));
      if (to.keyTarget.share) {
        const wraps = wrapped(to.keyTarget.share, to.keyTarget.share);
        return { ...input, body: { ...body, wraps: [...(body.wraps ?? []), ...wraps] } };
      }
      return { ...input, body: { ...body, commentEnvelopes: sealed(await owners(spaceId)) } };
    }
    if (route === sharingRoutes.endShare) {
      return { ...input, body: { ...body, commentEnvelopes: sealed(await owners(spaceId)) } };
    }
    if (route === ownerRoutes.addOwner) {
      if (!newOwner) throw new Error('Name the new owner');
      return { ...input, body: { ...body, commentEnvelopes: sealed([newOwner]) } };
    }
    return input;
  };
  const call = (async (route: RouteDef, input: Sent, options?: unknown) => {
    if (route !== sharingRoutes.records) return real(route, await add(route, input), options);
    const page = (await real(
      route,
      { ...input, query: { ...input.query, comments: '1' } },
      options,
    )) as { records: { kind: string }[] };
    return { ...page, records: page.records.filter((item) => item.kind !== 'comment') };
  }) as ClientContext['api']['call'];
  return { ...ctx, api: { ...ctx.api, call } };
}
