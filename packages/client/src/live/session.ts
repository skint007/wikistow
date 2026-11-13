// A live session's record (protocol section 5.10, **The session record**):
// a metadata record v2 with `subjectKind: "live"`, whose payload holds the
// session key, wrapped with the share's draft key in a share and sealed to
// the sealing owners in the owner region. Opening it runs every check
// section 5.10 lists, and `requireLiveAccess` keeps running the ones that
// hold for as long as the app is in the session.
import {
  JoinId,
  LiveSessionId,
  LiveSessionPayload,
  MetadataEnvelopeV2,
  MetadataRevisionId,
  SealedLiveRecord,
  type IdentityId,
  type InstallationId,
  type LiveRecord,
  type PageId,
  type RevisionId,
  type SpaceId,
} from '@wikistow/contracts';
import { z } from 'zod';
import {
  aeadDecrypt,
  aeadEncrypt,
  fromBase64,
  hash,
  keepParsed,
  parseJson,
  parseWith,
  sealedBytes,
  toBase64,
  utf8,
} from '../encoding.ts';
import { checkEnvelopeV2, keyCommitment, openAnyEnvelope, unsealCommitted } from '../envelope.ts';
import { CryptoError } from '../errors.ts';
import {
  KeyWrap,
  wrapAd,
  wrapContentKey,
  type FolderKeyring,
  type HeldKeyVersion,
  type WrapSubject,
} from '../folder-keys.ts';
import {
  isAgentId,
  keyHash,
  sign,
  verifySignature,
  type PrivateIdentity,
  type PublicIdentity,
} from '../identity.ts';
import { newId } from '../ids.ts';
import { highestWritable, requireNotBehind, type KeyVersionMarks } from '../key-versions.ts';
import {
  grantMetadataKeyV2,
  metadataAd,
  metadataEnvelopeV2Bytes,
  metadataRecordV2Bytes,
} from '../metadata.ts';
import { AcceptedOwners } from '../owners.ts';
import { OWNER_REGION, sameRegion, type Region } from '../regions.ts';
import { sodium } from '../sodium.ts';
import type { TrustStore } from '../trust.ts';
import type { LiveBinding } from './messages.ts';

export { LiveSessionPayload, SealedLiveRecord };

/** The session format this client writes (section 5.10). */
export const LIVE_SESSION_FORMAT = { major: 1, minor: 0 } as const;

/**
 * A session record's wrap subject (section 5.10, **For the build**): always
 * the draft class, so its folder key is the draft key, never the published
 * key a name's wrap takes (`metadataWrapSubject`), which would seal the
 * session to the share's readers.
 */
export const liveWrapSubject = (r: {
  spaceId: SpaceId;
  sessionId: LiveSessionId;
  versionId: string;
}): WrapSubject => ({
  spaceId: r.spaceId,
  audienceClass: 'draft',
  subjectKind: 'live',
  subjectId: r.sessionId,
  versionId: r.versionId,
});

/** `recordHash`: BLAKE2b-256 of the session record's signed bytes, which every message binds. */
export const liveRecordHash = (record: LiveRecord): string => hash(metadataRecordV2Bytes(record));

/**
 * Where a session goes: in a share, under the key version this app writes
 * under (`writeKeyVersion`), whose draft key wraps the record; in the owner
 * region, to the sealing owners (`AcceptedOwners.sealingOwners`).
 */
export type LiveKeyTarget =
  | { share: Pick<HeldKeyVersion, 'shareId' | 'keyVersion' | 'draftKey'>; owners?: undefined }
  | { owners: readonly PublicIdentity[]; share?: undefined };

/**
 * A session payload as this module hands it out: without the session key,
 * which lives only in `OpenedLiveSession.key`, a buffer the app wipes when
 * it leaves or locks, never in a string it can't (section 3.4).
 */
export type LiveSessionInfo = Pick<
  LiveSessionPayload,
  'format' | 'pageId' | 'revisionId' | 'joinId' | 'sealedTo' | 'extensions'
>;

const withoutKey = ({ key: _key, ...info }: LiveSessionPayload): LiveSessionInfo => info;

/** A session as its starter made it: what the start request carries. */
export type StartedLiveSession = {
  sessionId: LiveSessionId;
  /** The starter's join, which the payload names and which sends the first snapshot. */
  joinId: JoinId;
  sealed: SealedLiveRecord;
  /** In a share: the record's one wrap. */
  wrap: KeyWrap | null;
  /** In the owner region: one envelope per sealing owner. */
  envelopes: MetadataEnvelopeV2[];
  payload: LiveSessionInfo;
};

/**
 * Make a new session record (section 5.10): a fresh session ID, record
 * version ID, join ID and session key, all new for every start. A start the
 * server refuses, for any reason, is made again with this, never sent again
 * with the same payload under new key material, since the refused wrap or
 * envelopes would still open the key; only a start sent again byte for
 * byte, after a lost answer, goes out unchanged. The starter then opens its
 * own record with `openLiveSession`, as anyone would, before it sends
 * anything under the key.
 */
export function startLiveSession({
  author,
  installationId,
  spaceId,
  pageId,
  revisionId,
  ...to
}: {
  author: PrivateIdentity;
  installationId: InstallationId;
  spaceId: SpaceId;
  pageId: PageId;
  /** The draft head the session starts from. */
  revisionId: RevisionId;
} & LiveKeyTarget): StartedLiveSession {
  if (isAgentId(author.public.id)) {
    throw new CryptoError('malformed', 'Only people start live sessions');
  }
  const sessionKey = sodium.randombytes_buf(32);
  const sessionId = newId(LiveSessionId);
  const joinId = newId(JoinId);
  const payload: LiveSessionPayload = {
    format: { ...LIVE_SESSION_FORMAT },
    pageId,
    revisionId,
    joinId,
    key: toBase64(sessionKey),
    sealedTo: to.share ? null : to.owners.map((owner) => owner.id),
    extensions: {},
  };
  sodium.memzero(sessionKey);
  const record = {
    protocol: 2 as const,
    installationId,
    spaceId,
    subjectKind: 'live' as const,
    subjectId: sessionId,
    metadataRevisionId: newId(MetadataRevisionId),
    basedOn: null,
    authorId: author.public.id,
    authorKeyVersion: author.public.keyVersion,
  };
  const contentKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  const plaintext = utf8(JSON.stringify(payload));
  try {
    const sealedPayload = aeadEncrypt({ key: contentKey, plaintext, ad: metadataAd(record) });
    const full: LiveRecord = {
      ...record,
      payloadHash: hash(sealedBytes(sealedPayload)),
      keyCommitment: keyCommitment(contentKey),
    };
    const sealed = {
      record: full,
      signature: sign(author, metadataRecordV2Bytes(full)),
      payload: sealedPayload,
    };
    if (to.share) {
      if (!to.share.draftKey) {
        throw new CryptoError('missing-key', 'A live session needs the share’s draft key');
      }
      const wrap = wrapContentKey({
        installationId,
        subject: liveWrapSubject({ spaceId, sessionId, versionId: full.metadataRevisionId }),
        shareId: to.share.shareId,
        keyVersion: to.share.keyVersion,
        folderKey: to.share.draftKey,
        contentKey,
      });
      return { sessionId, joinId, sealed, wrap, envelopes: [], payload: withoutKey(payload) };
    }
    if (to.owners.length === 0) {
      throw new CryptoError('unaccepted-owner', 'A session in the owner region needs its owners');
    }
    const envelopes = to.owners.map((recipient) =>
      grantMetadataKeyV2({ granter: author, record: full, contentKey, recipient }),
    );
    return { sessionId, joinId, sealed, wrap: null, envelopes, payload: withoutKey(payload) };
  } finally {
    sodium.memzero(contentKey);
    plaintext.fill(0);
  }
}

/** A session record, opened and checked. The caller wipes `key` when it leaves or locks. */
export type OpenedLiveSession = {
  record: LiveRecord;
  payload: LiveSessionInfo;
  /** The session key, 32 bytes. */
  key: Uint8Array;
  recordHash: string;
  /** The region of the record's key material: the wrap's share, or the owner region. */
  region: Region;
  /** In a share, the wrap's key version; null in the owner region. */
  keyVersion: number | null;
  /**
   * In a share, the owners who sealed to this app a draft key the wrap
   * opens under, one of whom must count for writing for as long as the app
   * is in the session. Empty in the owner region.
   */
  wrapSealers: PublicIdentity[];
  /** The record's signer, at the key that verified it. */
  author: PublicIdentity;
  /** In the owner region, the granters of the envelopes this app was served. */
  granters: PublicIdentity[];
  /** The starter's join, which sends the first snapshot (`seq` 1). */
  starter: { senderId: IdentityId; senderKeyVersion: number; joinId: JoinId };
};

/** What the app knows of access to the page, which a session must be no older than. */
export type LiveAccess = {
  owners: AcceptedOwners;
  keyring: FolderKeyring;
  marks: KeyVersionMarks;
  /** The region of the page's draft as this app knows it now (section 6.8). */
  draftRegion: Region;
};

/**
 * Verify and open a session record (section 5.10, **Opening the record**):
 * its key material in the region of the page's draft this app opened
 * (`region-mismatch`); the checks of a metadata record v2 with
 * `subjectKind: "live"` for this session, a wrap opened as the draft class
 * whatever the server says, or an envelope from an accepted owner; the key
 * commitment; a payload of this page whose `sealedTo` is `null` exactly in
 * a share (`binding-mismatch`); a signer who is a person, at a pinned key;
 * and `requireLiveAccess`. A newer major session format is
 * `unsupported-format`: the app says to update, and edits as a writer
 * outside the session.
 */
export function openLiveSession({
  reader,
  trust,
  installationId,
  sealed,
  expected,
  access,
}: {
  reader: PrivateIdentity;
  trust: TrustStore;
  installationId: InstallationId;
  /** The record as served, with this reader's key material for it. */
  sealed: { record: unknown; wrap: unknown; envelopes: readonly unknown[] };
  expected: { spaceId: SpaceId; pageId: PageId; sessionId: LiveSessionId };
  access: LiveAccess;
}): OpenedLiveSession {
  const { owners, keyring } = access;
  if (!(owners instanceof AcceptedOwners)) {
    throw new CryptoError(
      'malformed',
      'A session opens with owners only as acceptOwners made them',
    );
  }
  const wrapped = sealed.wrap !== null && sealed.wrap !== undefined;
  if (wrapped && sealed.envelopes.length > 0) {
    throw new CryptoError('region-mismatch', 'A session came with both a key wrap and envelopes');
  }
  if (!wrapped && sealed.envelopes.length === 0) {
    throw new CryptoError('missing-key', 'A session came with no key');
  }
  const wrap = wrapped ? parseWith(KeyWrap, sealed.wrap, 'Key wrap') : null;
  const region: Region = wrap
    ? { kind: 'share', spaceId: expected.spaceId, shareId: wrap.shareId }
    : OWNER_REGION;
  if (!sameRegion(region, access.draftRegion)) {
    throw new CryptoError('region-mismatch', 'The session’s keys aren’t those of its page’s draft');
  }
  const {
    record,
    signature,
    payload: sealedPayload,
  } = parseWith(SealedLiveRecord, sealed.record, 'Live session');
  if (
    record.installationId !== installationId ||
    record.spaceId !== expected.spaceId ||
    record.subjectId !== expected.sessionId
  ) {
    throw new CryptoError('binding-mismatch', 'The session isn’t the one asked for');
  }
  if (isAgentId(record.authorId)) {
    throw new CryptoError(
      'untrusted-sealer',
      'An agent signed this session; only people start one',
    );
  }
  const author = trust.require(record.authorId, record.authorKeyVersion);
  if (!verifySignature(author, metadataRecordV2Bytes(record), signature)) {
    throw new CryptoError('bad-signature', 'Session record signature is invalid');
  }
  if (hash(sealedBytes(sealedPayload)) !== record.payloadHash) {
    throw new CryptoError('hash-mismatch', 'Session ciphertext does not match its signed hash');
  }
  const granters: PublicIdentity[] = [];
  let wrapSealers: PublicIdentity[] = [];
  let contentKey: Uint8Array;
  if (wrap) {
    const opened = openWrap({ installationId, record, wrap, keyring, owners });
    contentKey = opened.contentKey;
    wrapSealers = opened.sealers;
  } else {
    contentKey = openGrantedKey({
      reader,
      trust,
      owners,
      record,
      envelopes: sealed.envelopes,
      granters,
    });
  }
  let plaintext: Uint8Array;
  try {
    plaintext = aeadDecrypt({ key: contentKey, sealed: sealedPayload, ad: metadataAd(record) });
  } finally {
    sodium.memzero(contentKey);
  }
  let payload: LiveSessionPayload;
  try {
    payload = readSessionPayload(plaintext);
  } finally {
    plaintext.fill(0);
  }
  if (payload.pageId !== expected.pageId) {
    throw new CryptoError('binding-mismatch', 'The session is of another page');
  }
  if ((payload.sealedTo === null) !== (wrap !== null)) {
    throw new CryptoError(
      'binding-mismatch',
      wrap
        ? 'A session in a share lists owners it was sealed to'
        : 'A session sealed to owners lists none',
    );
  }
  const opened: OpenedLiveSession = {
    record,
    payload: withoutKey(payload),
    key: fromBase64(payload.key),
    recordHash: liveRecordHash(record),
    region,
    keyVersion: wrap?.keyVersion ?? null,
    wrapSealers,
    author,
    granters,
    starter: {
      senderId: record.authorId,
      senderKeyVersion: record.authorKeyVersion,
      joinId: payload.joinId,
    },
  };
  try {
    requireLiveAccess(opened, access);
  } catch (error) {
    sodium.memzero(opened.key);
    throw error;
  }
  return opened;
}

/**
 * The content key through the session's wrap, opened only with a draft key
 * of the wrap's version that an owner who counts for writing sealed to this
 * app (section 6.5, **Writing**). A key a removed owner sealed for the same
 * version opens nothing here: otherwise they could wrap a session under a
 * key of their own choosing, and read everything typed in it.
 */
function openWrap({
  installationId,
  record,
  wrap,
  keyring,
  owners,
}: {
  installationId: InstallationId;
  record: LiveRecord;
  wrap: KeyWrap;
  keyring: FolderKeyring;
  owners: AcceptedOwners;
}): { contentKey: Uint8Array; sealers: PublicIdentity[] } {
  const subject = liveWrapSubject({
    spaceId: record.spaceId,
    sessionId: record.subjectId,
    versionId: record.metadataRevisionId,
  });
  const held = keyring
    .versions(record.spaceId, wrap.shareId)
    .filter((version) => version.keyVersion === wrap.keyVersion && version.draftKey);
  const counting = held.filter((version) => owners.writes(version.sealer));
  if (counting.length === 0) {
    throw held.length > 0
      ? new CryptoError(
          'key-version',
          `No owner who counts for writing sealed version ${wrap.keyVersion} of share ${wrap.shareId} to this app`,
        )
      : new CryptoError(
          'missing-key',
          `No draft key for version ${wrap.keyVersion} of share ${wrap.shareId}`,
        );
  }
  const ad = wrapAd(installationId, subject, wrap);
  let failure: CryptoError = new CryptoError('decrypt-failed', 'The key wrap does not open');
  let found: Uint8Array | null = null;
  const sealers: PublicIdentity[] = [];
  for (const version of counting) {
    let contentKey: Uint8Array;
    try {
      contentKey = aeadDecrypt({
        key: version.draftKey as Uint8Array,
        sealed: wrap.wrappedKey,
        ad,
      });
    } catch (error) {
      if (!(error instanceof CryptoError)) throw error;
      continue;
    }
    if (keyCommitment(contentKey) !== record.keyCommitment) {
      sodium.memzero(contentKey);
      failure = new CryptoError('key-commitment', 'The wrap opens to another content key');
      continue;
    }
    sealers.push(version.sealer);
    if (found) sodium.memzero(contentKey);
    else found = contentKey;
  }
  if (!found) throw failure;
  return { contentKey: found, sealers };
}

// The content key through this reader's own envelopes, each checked as a v2
// metadata envelope from an accepted owner, collecting every granter.
function openGrantedKey({
  reader,
  trust,
  owners,
  record,
  envelopes,
  granters,
}: {
  reader: PrivateIdentity;
  trust: TrustStore;
  owners: AcceptedOwners;
  record: LiveRecord;
  envelopes: readonly unknown[];
  granters: PublicIdentity[];
}): Uint8Array {
  // Every envelope served must be one this app could check: a granter
  // section 5.10 wouldn't count can't hide among ones it would.
  for (const raw of envelopes) {
    const envelope = parseWith(MetadataEnvelopeV2, raw, 'Session envelope');
    granters.push(trust.require(envelope.granterId, envelope.granterKeyVersion));
  }
  return openAnyEnvelope(envelopes, (raw) => {
    const envelope = parseWith(MetadataEnvelopeV2, raw, 'Session envelope');
    checkEnvelopeV2({
      reader,
      trust,
      owners: owners.opens,
      envelope,
      namesThisVersion: envelope.metadataRevisionId === record.metadataRevisionId,
      signedBytes: () => metadataEnvelopeV2Bytes(record, envelope),
    });
    return unsealCommitted(reader, envelope.sealedKey, record.keyCommitment);
  });
}

function readSessionPayload(plaintext: Uint8Array): LiveSessionPayload {
  const json = parseJson(z.unknown(), plaintext, 'Live session');
  const format = z
    .object({ format: z.looseObject({ major: z.number().int().positive() }) })
    .safeParse(json);
  if (!format.success) throw new CryptoError('malformed', 'Live session has no format version');
  if (format.data.format.major > LIVE_SESSION_FORMAT.major) {
    throw new CryptoError('unsupported-format', 'Update the app to edit with others');
  }
  return keepParsed(LiveSessionPayload, json, 'Live session');
}

/**
 * Whether a session is still one this app may be in (section 5.10,
 * **Opening the record**): checked when it joins and for as long as it is
 * in the session, so it leaves as soon as this throws.
 *
 * - The page's draft region, as this app knows it, is still the region of
 *   the record's key material, as after a move or the ending of a share,
 *   which rotate nothing (`region-mismatch`).
 * - In a share, the record's key version is the highest this app holds
 *   that counts for writing, an owner who sealed this app a draft key its
 *   wrap opens under still counts for writing, and the version is not below
 *   its No going back mark, nor the mark of a share this app ended
 *   (`key-version`).
 * - In the owner region, every owner `sealedTo` names, the record's signer
 *   and every envelope's granter is one of its sealing owners now
 *   (`unaccepted-owner`), since anyone can seal to owners' public keys.
 */
export function requireLiveAccess(session: OpenedLiveSession, access: LiveAccess): void {
  const { owners, keyring, marks, draftRegion } = access;
  if (!sameRegion(session.region, draftRegion)) {
    throw new CryptoError('region-mismatch', 'The page’s draft is in another region now');
  }
  if (session.region.kind === 'share') {
    const { spaceId, shareId } = session.region;
    const keyVersion = session.keyVersion ?? 0;
    requireNotBehind({ marks, spaceId, shareId, keyVersion });
    const highest = highestWritable({ keyring, spaceId, shareId, writes: owners.writes });
    if (!session.wrapSealers.some((sealer) => owners.writes(sealer))) {
      throw new CryptoError(
        'key-version',
        'The owner who sealed the session’s key version doesn’t count for writing now',
      );
    }
    if (!highest || highest.keyVersion !== keyVersion) {
      throw new CryptoError(
        'key-version',
        `The session is under version ${keyVersion} of share ${shareId}, not the newest this app writes under`,
      );
    }
    return;
  }
  const sealing = owners.sealingOwners();
  const ids = new Set<string>(sealing.map((owner) => owner.id));
  const keys = new Set(sealing.map((owner) => `${owner.id} ${keyHash(owner)}`));
  const isSealing = (who: PublicIdentity) => keys.has(`${who.id} ${keyHash(who)}`);
  const strangers = [
    ...(session.payload.sealedTo ?? []).filter((id) => !ids.has(id)),
    ...[session.author, ...session.granters].filter((who) => !isSealing(who)).map((who) => who.id),
  ];
  if (strangers.length > 0) {
    throw new CryptoError(
      'unaccepted-owner',
      `The session names people who aren’t this space’s owners now: ${[...new Set(strangers)].join(', ')}`,
    );
  }
}

/** What every message of `session` binds, for sealing and opening them. */
export const liveBinding = (session: OpenedLiveSession): LiveBinding => ({
  installationId: session.record.installationId,
  spaceId: session.record.spaceId,
  pageId: session.payload.pageId,
  sessionId: session.record.subjectId,
  recordHash: session.recordHash,
  key: session.key,
});
