// Live sessions sealed by hand as section 5.10 describes them, so a test can
// send what the app's `live` module (ADR 0015 step 5) will, and what it
// never would: session records v2 of kind `live` with their key material in
// the page's draft region, and messages padded and sealed under the
// session key. The server checks none of what is sealed, so these are
// close enough to the app's for its tests, not test vectors.
import { randomBytes } from 'node:crypto';
import {
  aeadEncrypt,
  canonical,
  grantMetadataKeyV2,
  hash,
  keyCommitment,
  metadataRecordV2Bytes,
  newId,
  sealedBytes,
  sign,
  toBase64,
  utf8,
  wrapContentKey,
  type ClientContext,
  type PageId,
  type SpaceId,
  type WrapSubject,
} from '@wikistow/client';
import { writeTargetOf } from '@wikistow/client/testing';
import {
  JoinId,
  LiveSessionId,
  liveRoutes,
  MetadataRevisionId,
  type KeyWrap,
  type LiveRecord,
  type MetadataEnvelopeV2,
  type RevisionId,
} from '@wikistow/contracts';
import { expect } from 'vite-plus/test';
import type { Person } from './sharing.ts';

type Page = { spaceId: SpaceId; pageId: PageId };

/** A session a test started, with its key, for sealing messages in it. */
export type TestSession = {
  sessionId: LiveSessionId;
  versionId: MetadataRevisionId;
  spaceId: SpaceId;
  pageId: PageId;
  revisionId: RevisionId;
  joinId: JoinId;
  record: LiveRecord;
  recordHash: string;
  sessionKey: Uint8Array;
  installationId: string;
};

type Kind = liveRoutes.LiveMessage['kind'];

/**
 * A message from `ctx`'s join in `session`, sealed under its key: `clock`
 * and `content`, padded to a multiple of 128 bytes (512 for a presence),
 * or to `size` bytes of plaintext.
 */
export function sealMessage(
  ctx: ClientContext,
  session: TestSession,
  {
    kind,
    joinId,
    seq,
    content = utf8('PLAINTEXT-LIVE-TYPING-0c3e'),
    clock = 0,
    size,
  }: {
    kind: Kind;
    joinId: JoinId;
    seq: number;
    content?: Uint8Array;
    clock?: number;
    size?: number;
  },
): liveRoutes.LiveMessage {
  const length = size ?? (kind === 'presence' ? 512 : 128 * Math.ceil((9 + content.length) / 128));
  const padded = new Uint8Array(length);
  new DataView(padded.buffer).setBigUint64(0, BigInt(clock));
  padded.set(content.subarray(0, length - 9), 8);
  padded[8 + Math.min(content.length, length - 9)] = 0x80;
  const sender = ctx.identity.public;
  const bound = [
    session.installationId,
    session.spaceId,
    session.pageId,
    session.sessionId,
    session.recordHash,
    kind,
    sender.id,
    sender.keyVersion,
    joinId,
    seq,
  ];
  const sealed = aeadEncrypt({
    key: session.sessionKey,
    plaintext: padded,
    ad: canonical('live-message-payload/v1', bound),
  });
  const signature = sign(
    ctx.identity,
    canonical('live-message/v1', [...bound, hash(sealedBytes(sealed))]),
  );
  return {
    kind,
    senderId: sender.id,
    senderKeyVersion: sender.keyVersion,
    joinId,
    seq,
    sealed,
    signature,
  };
}

/**
 * A start of a session on `page` by `ctx`, from the draft `revisionId`, in
 * the page's region as the server's tree puts it now: the request's body
 * and the session it makes.
 */
export async function sealStart(
  ctx: ClientContext,
  page: Page,
  {
    revisionId,
    sessionId = newId(LiveSessionId),
    joinId = newId(JoinId),
    versionId = newId(MetadataRevisionId),
    snapshotText = 'PLAINTEXT-LIVE-SNAPSHOT-5d1a',
  }: {
    revisionId: RevisionId;
    sessionId?: LiveSessionId;
    joinId?: JoinId;
    versionId?: MetadataRevisionId;
    snapshotText?: string;
  },
) {
  const { permissionVersion, keyTarget } = await writeTargetOf(ctx, page.spaceId, page.pageId);
  const contentKey = new Uint8Array(randomBytes(32));
  const sessionKey = new Uint8Array(randomBytes(32));
  const author = ctx.identity.public;
  const bound = {
    protocol: 2 as const,
    installationId: ctx.installationId,
    spaceId: page.spaceId,
    subjectKind: 'live' as const,
    subjectId: sessionId,
    metadataRevisionId: versionId,
    basedOn: null,
    authorId: author.id,
    authorKeyVersion: author.keyVersion,
  };
  const body = {
    format: { major: 1, minor: 0 },
    pageId: page.pageId,
    revisionId,
    joinId,
    key: toBase64(sessionKey),
    sealedTo: keyTarget.share ? null : keyTarget.recipients.map((r) => r.id),
    extensions: {},
  };
  const payload = aeadEncrypt({
    key: contentKey,
    plaintext: utf8(JSON.stringify(body)),
    ad: canonical('metadata-payload/v1', [
      ctx.installationId,
      bound.spaceId,
      bound.subjectKind,
      bound.subjectId,
      bound.metadataRevisionId,
      bound.authorId,
      bound.authorKeyVersion,
    ]),
  });
  const record: LiveRecord = {
    ...bound,
    payloadHash: hash(sealedBytes(payload)),
    keyCommitment: keyCommitment(contentKey),
  };
  let wrap: KeyWrap | null = null;
  let envelopes: MetadataEnvelopeV2[] = [];
  if (keyTarget.share) {
    const { draftKey } = keyTarget.share;
    if (!draftKey) throw new Error('A reader holds no draft key');
    // Under the draft key (section 5.10, **For the build**); the client's
    // own type gains `live` with its `live` module.
    const subject = {
      spaceId: page.spaceId,
      audienceClass: 'draft',
      subjectKind: 'live',
      subjectId: sessionId,
      versionId,
    } as unknown as WrapSubject;
    wrap = wrapContentKey({
      installationId: ctx.installationId,
      subject,
      shareId: keyTarget.share.shareId,
      keyVersion: keyTarget.share.keyVersion,
      folderKey: draftKey,
      contentKey,
    });
  } else {
    envelopes = keyTarget.recipients.map((recipient) =>
      grantMetadataKeyV2({ granter: ctx.identity, record, contentKey, recipient }),
    );
  }
  const signed = metadataRecordV2Bytes(record);
  const session: TestSession = {
    sessionId,
    versionId,
    spaceId: page.spaceId,
    pageId: page.pageId,
    revisionId,
    joinId,
    record,
    recordHash: hash(signed),
    sessionKey,
    installationId: ctx.installationId,
  };
  const snapshot = sealMessage(ctx, session, {
    kind: 'snapshot',
    joinId,
    seq: 1,
    content: utf8(
      JSON.stringify({ format: { major: 1, minor: 0 }, revisionId, state: snapshotText }),
    ),
  });
  return {
    session,
    body: {
      sessionId,
      joinId,
      revisionId,
      metadata: { record, signature: sign(ctx.identity, signed), payload },
      wrap,
      envelopes,
      snapshot,
      permissionVersion,
    },
  };
}

export type StartBody = Awaited<ReturnType<typeof sealStart>>['body'];

export const sendStart = (ctx: ClientContext, pageId: PageId, body: StartBody) =>
  ctx.api.call(liveRoutes.startLive, { params: { pageId }, body });

/** Start a session on `page` from its draft head, as the app will. */
export async function startSession(person: Person, page: Page) {
  const revisionId = await headOf(person, page);
  const { session, body } = await sealStart(person.ctx, page, { revisionId });
  await sendStart(person.ctx, page.pageId, body);
  return session;
}

export async function headOf(person: Person, page: Page) {
  const live = await person.ctx.api.call(liveRoutes.getLive, { params: { pageId: page.pageId } });
  if (!live.draftHead) throw new Error('expected a draft');
  return live.draftHead;
}

export const liveOf = (person: Person, pageId: PageId) =>
  person.ctx.api.call(liveRoutes.getLive, { params: { pageId } });

/** Send messages from `joinId`, as `sendMessages` takes them. */
export const send = (
  person: Person,
  session: TestSession,
  joinId: JoinId,
  messages: (liveRoutes.LiveMessage | { message: liveRoutes.LiveMessage; covers?: number })[],
  extra: { parent?: JoinId; fold?: string } = {},
) =>
  person.ctx.api.call(liveRoutes.sendMessages, {
    params: { sessionId: session.sessionId },
    body: {
      joinId,
      messages: messages.map((m) => ('message' in m ? m : { message: m })),
      ...extra,
    } as never,
  });

/**
 * `person`'s join, sealing its messages in `seq` order: each stored kind
 * takes the next `seq`, and a refused request gives back the ones it took,
 * as an app numbers what it sends again.
 */
export function typist(person: Person, session: TestSession, joinId: JoinId = newId(JoinId)) {
  let stored = 0;
  let issued = 0;
  return {
    joinId,
    /** The join's first snapshot took `seq` 1 already. */
    started() {
      stored = issued = 1;
    },
    message: (kind: Kind, options: { content?: Uint8Array; size?: number } = {}) => {
      if (kind !== 'presence') issued++;
      return sealMessage(person.ctx, session, { kind, joinId, seq: issued, ...options });
    },
    async send(
      messages: (liveRoutes.LiveMessage | { message: liveRoutes.LiveMessage; covers?: number })[],
      extra: { parent?: JoinId; fold?: string } = {},
    ) {
      try {
        const answer = await send(person, session, joinId, messages, extra);
        stored = issued;
        return answer;
      } catch (error) {
        issued = stored;
        throw error;
      }
    },
  };
}

/**
 * A session's stream, opened as `person`'s join `joinId`: its lines as they
 * come, and `next` for the first line after those already taken that
 * `match` accepts.
 */
export async function openStream(
  person: Person,
  session: Pick<TestSession, 'sessionId'>,
  { joinId, after = 0 }: { joinId: JoinId; after?: number },
) {
  const response = await person.browser.request(
    `/api/live/${session.sessionId}/stream?after=${after}&joinId=${joinId}`,
  );
  if (!response.ok || !response.body) {
    const { error } = (await response.json()) as { error: { code: string } };
    throw Object.assign(new Error(error.code), { code: error.code });
  }
  const reader = response.body.getReader();
  const lines: liveRoutes.StreamLine[] = [];
  let taken = 0;
  let done = false;
  let rest = '';
  const decoder = new TextDecoder();
  const pump = (async () => {
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done) {
        done = true;
        return;
      }
      rest += decoder.decode(chunk.value, { stream: true });
      const parts = rest.split('\n');
      rest = parts.pop() ?? '';
      for (const part of parts) {
        if (part.trim() !== '') lines.push(liveRoutes.StreamLine.parse(JSON.parse(part)));
      }
    }
  })();
  return {
    lines,
    get done() {
      return done;
    },
    /** The first line, after those `next` already took, that `match` accepts. */
    async next(match: (line: liveRoutes.StreamLine) => boolean = () => true) {
      await expect
        .poll(() => lines.slice(taken).some(match) || (done && 'closed'), { timeout: 8000 })
        .toBe(true);
      const at = lines.findIndex((line, index) => index >= taken && match(line));
      taken = at + 1;
      const line = lines[at];
      if (!line) throw new Error('no such line');
      return line;
    },
    async close() {
      await reader.cancel().catch(() => {});
      await pump;
    },
    closed: () => pump,
  };
}

export type OpenStream = Awaited<ReturnType<typeof openStream>>;
