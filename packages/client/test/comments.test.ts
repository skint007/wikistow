// Opening a comment (protocol section 5.9, ADR 0014 decision 4): the checks
// that keep a server from moving a comment to another page, thread,
// audience or region, which only this module makes.
import { describe, expect, it } from 'vite-plus/test';
import {
  aeadEncrypt,
  CommentId,
  commentWrapSubject,
  FolderKeyring,
  generateIdentity,
  hash,
  IdentityId,
  InstallationId,
  keyCommitment,
  metadataAd,
  metadataRecordV2Bytes,
  MetadataRevisionId,
  newCommentPayload,
  newFolderKeys,
  openComment,
  openFolderKeys,
  OWNER_REGION,
  PageId,
  RevisionId,
  sealComment,
  sealedBytes,
  sealFolderKeys,
  ShareId,
  sign,
  SpaceId,
  TrustStore,
  utf8,
  wrapContentKey,
  type CommentPayload,
  type ListedComment,
  type Region,
} from '../src/index.ts';
import { opensFor } from '../src/owner-predicates.ts';
import { sodium } from '../src/sodium.ts';
import { directoryEntry } from './support/testing.ts';

const code = (expected: string) => expect.objectContaining({ code: expected });
const installationId = InstallationId.parse('test-installation');
const owner = generateIdentity({ id: IdentityId.parse('owner'), kind: 'human' });
const reader = generateIdentity({ id: IdentityId.parse('reader'), kind: 'human' });
const spaceId = SpaceId.parse('space');
const pageId = PageId.parse('page');
const shareId = ShareId.parse('share');
const share: Region = { kind: 'share', spaceId, shareId };
const owners = opensFor((who) => who.id === owner.public.id);

// The reader holds the share's published key, from the owner.
const trust = new TrustStore(installationId);
trust.pinSelf(reader);
trust.use(directoryEntry(owner.public));
const folderKeys = newFolderKeys();
const keyring = new FolderKeyring();
keyring.add(
  openFolderKeys({
    reader,
    trust,
    installationId,
    envelope: sealFolderKeys({
      sealer: owner,
      installationId,
      spaceId,
      shareId,
      keyVersion: 1,
      recipient: reader.public,
      keys: { draftKey: null, publishedKey: folderKeys.publishedKey },
    }),
    expect: { spaceId, shareId },
    sealers: owners,
  }),
);
const writing = {
  share: {
    shareId,
    keyVersion: 1,
    draftKey: folderKeys.draftKey,
    publishedKey: folderKeys.publishedKey,
  },
};

const seal = (payload: CommentPayload, commentId = CommentId.parse('question')) =>
  sealComment({
    author: owner,
    target: {
      installationId,
      spaceId,
      commentId,
      versionId: MetadataRevisionId.parse(`${commentId}-1`),
      basedOn: null,
    },
    payload,
    ...writing,
  });

const open = (
  sealed: ReturnType<typeof seal>,
  listed: Partial<ListedComment> = {},
  region: Region = share,
) =>
  openComment({
    reader,
    trust,
    owners,
    installationId,
    keyring,
    sealed: { comment: sealed.metadata, wrap: sealed.wrap, envelopes: sealed.envelopes },
    listed: {
      spaceId,
      pageId,
      commentId: sealed.metadata.record.subjectId,
      thread: null,
      audience: 'published',
      ...listed,
    },
    region,
  });

const question = newCommentPayload({ pageId, audience: 'published', text: 'Fan oven or not?' });

describe('opening a comment (section 5.9)', () => {
  it('opens one as written, in the region of the page on screen', () => {
    const opened = open(seal(question));
    expect(opened).toMatchObject({
      kind: 'current',
      region: share,
      payload: { text: 'Fan oven or not?', thread: null, audience: 'published' },
    });
    expect(opened.record.authorId).toBe(owner.public.id);
  });

  it('refuses keys from another region than the page’s', () => {
    expect(() => open(seal(question), {}, OWNER_REGION)).toThrow(code('region-mismatch'));
    const elsewhere: Region = { kind: 'share', spaceId, shareId: ShareId.parse('other') };
    expect(() => open(seal(question), {}, elsewhere)).toThrow(code('region-mismatch'));
  });

  it('refuses a comment listed on another page or thread than it names', () => {
    expect(() => open(seal(question), { pageId: PageId.parse('other') })).toThrow(
      code('binding-mismatch'),
    );
    expect(() => open(seal(question), { thread: CommentId.parse('other') })).toThrow(
      code('binding-mismatch'),
    );
  });

  it('opens a wrap only with the AD of the audience listed, and the payload must say it', () => {
    // A reader holds no draft key, so one listed for editors doesn't open.
    expect(() => open(seal(question), { audience: 'draft' })).toThrow(code('missing-key'));
    // A comment for editors wrapped under the published key, as a member
    // could: the wrap opens, but its payload says otherwise.
    const notes = newCommentPayload({ pageId, audience: 'draft', text: 'Drop Gran’s part?' });
    const key = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
    const bound = {
      protocol: 2 as const,
      installationId,
      spaceId,
      subjectKind: 'comment' as const,
      subjectId: CommentId.parse('notes'),
      metadataRevisionId: MetadataRevisionId.parse('notes-1'),
      basedOn: null,
      authorId: owner.public.id,
      authorKeyVersion: owner.public.keyVersion,
    };
    const payload = aeadEncrypt({
      key,
      plaintext: utf8(JSON.stringify(notes)),
      ad: metadataAd(bound),
    });
    const record = {
      ...bound,
      payloadHash: hash(sealedBytes(payload)),
      keyCommitment: keyCommitment(key),
    };
    const wrap = wrapContentKey({
      installationId,
      subject: commentWrapSubject({
        spaceId,
        audience: 'published',
        commentId: record.subjectId,
        versionId: record.metadataRevisionId,
      }),
      shareId,
      keyVersion: 1,
      folderKey: folderKeys.publishedKey,
      contentKey: key,
    });
    const forged = {
      metadata: { record, signature: sign(owner, metadataRecordV2Bytes(record)), payload },
      wrap,
      envelopes: [],
    };
    expect(() => open(forged)).toThrow(code('binding-mismatch'));
  });

  it('refuses a reply with a quote, and a thread without its author', () => {
    const reply = newCommentPayload({
      pageId,
      audience: 'published',
      text: 'Fan: 170 °C.',
      reply: { thread: CommentId.parse('question'), threadAuthor: owner.public.id },
    });
    const quote = { revisionId: RevisionId.parse('r'), exact: 'at 180 °C', prefix: '', suffix: '' };
    expect(() => seal({ ...reply, quote })).toThrow(code('malformed'));
    expect(() => seal({ ...reply, threadAuthor: null })).toThrow(code('malformed'));
    expect(() => seal({ ...question, text: '' })).toThrow(code('malformed'));
  });
});
