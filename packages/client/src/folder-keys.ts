import {
  AudienceClass,
  FolderKeyEnvelope,
  KeyWrap,
  type IdentityId,
  type MetadataRecord,
  type RevisionRecord,
  type ShareId,
  type SpaceId,
} from '@wikistow/contracts';
import { aeadDecrypt, aeadEncrypt, canonical, fromBase64, parseWith } from './encoding.ts';
import {
  keyCommitment,
  openSealedKey,
  sealKeyTo,
  requireAcceptedOwner,
  type OpensOwner,
} from './envelope.ts';
import { CryptoError } from './errors.ts';
import { sign, verifySignature, type PrivateIdentity, type PublicIdentity } from './identity.ts';
import type { InstallationId } from './ids.ts';
import type { Region } from './regions.ts';
import { sodium } from './sodium.ts';
import type { TrustStore } from './trust.ts';

export { AudienceClass, FolderKeyEnvelope, KeyWrap };

/** The two keys of one key version of a share (section 6.2). */
export type FolderKeys = { draftKey: Uint8Array; publishedKey: Uint8Array };

/** Two fresh keys for a new key version: version 1 of a new share, or a rotation. */
export const newFolderKeys = (): FolderKeys => ({
  draftKey: sodium.crypto_aead_xchacha20poly1305_ietf_keygen(),
  publishedKey: sodium.crypto_aead_xchacha20poly1305_ietf_keygen(),
});

/** The folder key of `audienceClass`: drafts take the draft key, everything else the published key. */
export const folderKeyOf = <K extends { draftKey: Uint8Array | null; publishedKey: Uint8Array }>(
  keys: K,
  audienceClass: AudienceClass,
): Uint8Array | null => (audienceClass === 'draft' ? keys.draftKey : keys.publishedKey);

/**
 * The record version a key wrap binds to (section 6.3): its space, class,
 * subject and version ID. A wrap made for one can't open as another.
 */
export type WrapSubject = {
  spaceId: SpaceId;
  audienceClass: AudienceClass;
  subjectKind: 'page' | 'space' | 'folder';
  subjectId: string;
  versionId: string;
};

export const revisionWrapSubject = (
  r: Pick<RevisionRecord, 'spaceId' | 'audience' | 'pageId' | 'revisionId'>,
): WrapSubject => ({
  spaceId: r.spaceId,
  audienceClass: r.audience,
  subjectKind: 'page',
  subjectId: r.pageId,
  versionId: r.revisionId,
});

export const metadataWrapSubject = (
  r: Pick<MetadataRecord, 'spaceId' | 'subjectKind' | 'subjectId' | 'metadataRevisionId'>,
): WrapSubject => ({
  spaceId: r.spaceId,
  audienceClass: 'metadata',
  subjectKind: r.subjectKind,
  subjectId: r.subjectId,
  versionId: r.metadataRevisionId,
});

const wrapAd = (
  installationId: InstallationId,
  subject: WrapSubject,
  wrap: Pick<KeyWrap, 'shareId' | 'keyVersion'>,
) =>
  canonical('content-key-wrap/v1', [
    installationId,
    subject.spaceId,
    wrap.shareId,
    wrap.keyVersion,
    subject.audienceClass,
    subject.subjectKind,
    subject.subjectId,
    subject.versionId,
  ]);

/**
 * Wrap a record's content key with the folder key of its class at one key
 * version of a share. `folderKey` must be that class's key: a draft's with
 * the draft key, anything else with the published key.
 */
export function wrapContentKey({
  installationId,
  subject,
  shareId,
  keyVersion,
  folderKey,
  contentKey,
}: {
  installationId: InstallationId;
  subject: WrapSubject;
  shareId: ShareId;
  keyVersion: number;
  folderKey: Uint8Array;
  contentKey: Uint8Array;
}): KeyWrap {
  const ad = wrapAd(installationId, subject, { shareId, keyVersion });
  return {
    shareId,
    keyVersion,
    wrappedKey: aeadEncrypt({ key: folderKey, plaintext: contentKey, ad }),
  };
}

/**
 * Unwrap a record's content key with the folder keys this client holds
 * (section 6.3): `missing-key` without one of the wrap's version and class,
 * `decrypt-failed` if none opens it, and `key-commitment` if what it opens to
 * isn't the record's committed key. `commitment` is `null` only for a v1
 * record, which the caller accepts only from an accepted owner. The caller
 * wipes the key.
 */
export function unwrapContentKey({
  installationId,
  subject,
  wrap: raw,
  keyring,
  commitment,
}: {
  installationId: InstallationId;
  subject: WrapSubject;
  wrap: unknown;
  keyring: FolderKeyring;
  commitment: string | null;
}): Uint8Array {
  const wrap = parseWith(KeyWrap, raw, 'Key wrap');
  const keys = keyring.keysFor(
    subject.spaceId,
    wrap.shareId,
    wrap.keyVersion,
    subject.audienceClass,
  );
  if (keys.length === 0) {
    throw new CryptoError(
      'missing-key',
      `No ${subject.audienceClass} key for version ${wrap.keyVersion} of share ${wrap.shareId}`,
    );
  }
  const ad = wrapAd(installationId, subject, wrap);
  // Two envelopes can give one version different keys, though only one is
  // real: the one whose key opens to the committed content key.
  let failure: CryptoError | undefined;
  for (const folderKey of keys) {
    let contentKey: Uint8Array;
    try {
      contentKey = aeadDecrypt({ key: folderKey, sealed: wrap.wrappedKey, ad });
    } catch (error) {
      if (!(error instanceof CryptoError)) throw error;
      failure ??= error;
      continue;
    }
    if (commitment === null || keyCommitment(contentKey) === commitment) return contentKey;
    sodium.memzero(contentKey);
    failure = new CryptoError('key-commitment', 'The wrap opens to another content key');
  }
  throw failure ?? new CryptoError('decrypt-failed', 'The key wrap does not open');
}

/**
 * The key material a record is opened through (section 6.1): the caller's
 * own envelopes, or the record's key wrap and the folder keys to unwrap it.
 * Which one it is fixes the record's region in this app.
 */
export type KeyMaterial =
  | { envelopes: readonly unknown[]; wrap?: undefined; keyring?: undefined }
  | { wrap: unknown; keyring: FolderKeyring; envelopes?: undefined };

/**
 * The key material of a record as the server serves it: its wrap, or the
 * caller's own envelopes for it, of which the first that opens is used. A
 * record served with both is `region-mismatch`, and one with neither is
 * `missing-key`.
 */
export function servedKeyMaterial({
  wrap,
  envelopes,
  keyring,
}: {
  wrap: unknown;
  envelopes: readonly unknown[];
  keyring: FolderKeyring;
}): KeyMaterial {
  if (wrap !== null && wrap !== undefined) {
    if (envelopes.length > 0) {
      throw new CryptoError('region-mismatch', 'A record came with both a key wrap and envelopes');
    }
    return { wrap, keyring };
  }
  if (envelopes.length === 0) throw new CryptoError('missing-key', 'A record came with no key');
  return { envelopes };
}

/**
 * Unwrap a record's content key through its wrap (`unwrapContentKey`), and
 * the region that puts the record in: the wrap's share.
 */
export function openThroughWrap(args: {
  installationId: InstallationId;
  subject: WrapSubject;
  wrap: unknown;
  keyring: FolderKeyring;
  commitment: string | null;
}): { contentKey: Uint8Array; region: Region } {
  const { shareId } = parseWith(KeyWrap, args.wrap, 'Key wrap');
  const { spaceId } = args.subject;
  return { contentKey: unwrapContentKey(args), region: { kind: 'share', spaceId, shareId } };
}

/** The bytes a sealer signs for a folder key envelope. The server verifies them too. */
export const folderKeyEnvelopeBytes = (
  installationId: InstallationId,
  e: Omit<FolderKeyEnvelope, 'signature'>,
) =>
  canonical('folder-key-envelope/v1', [
    installationId,
    e.spaceId,
    e.shareId,
    e.keyVersion,
    e.recipientId,
    e.recipientKeyVersion,
    e.draftKey === null ? null : fromBase64(e.draftKey),
    fromBase64(e.publishedKey),
    e.sealerId,
    e.sealerKeyVersion,
  ]);

/**
 * Seal one key version of a share to one person or agent (section 6.4).
 * `draftKey: null` is a reader's envelope: it never carries the draft key.
 * `recipient` must come from the trust store (`TrustStore.recipients`), or for
 * an agent from its verified enrollment.
 */
export function sealFolderKeys({
  sealer,
  installationId,
  spaceId,
  shareId,
  keyVersion,
  recipient,
  keys,
}: {
  sealer: PrivateIdentity;
  installationId: InstallationId;
  spaceId: SpaceId;
  shareId: ShareId;
  keyVersion: number;
  recipient: PublicIdentity;
  keys: { draftKey: Uint8Array | null; publishedKey: Uint8Array };
}): FolderKeyEnvelope {
  const unsigned = {
    spaceId,
    shareId,
    keyVersion,
    recipientId: recipient.id,
    recipientKeyVersion: recipient.keyVersion,
    draftKey: keys.draftKey === null ? null : sealKeyTo(keys.draftKey, recipient),
    publishedKey: sealKeyTo(keys.publishedKey, recipient),
    sealerId: sealer.public.id,
    sealerKeyVersion: sealer.public.keyVersion,
  };
  return { ...unsigned, signature: sign(sealer, folderKeyEnvelopeBytes(installationId, unsigned)) };
}

/** A key version opened from a verified envelope, with who sealed it. */
export type OpenedFolderKeys = {
  spaceId: SpaceId;
  shareId: ShareId;
  keyVersion: number;
  /** `null` when the envelope was a reader's. */
  draftKey: Uint8Array | null;
  publishedKey: Uint8Array;
  sealer: PublicIdentity;
};

/**
 * Verify and open a folder key envelope addressed to `reader` (section 6.4):
 * the space and share asked for, this reader at its current key version, a
 * sealer `sealers` trusts at a pinned key, a valid signature, and both keys
 * opening. For a person, `sealers` is the space's accepted owners for
 * opening; for an agent, its own person. Throws a `CryptoError`.
 */
export function openFolderKeys({
  reader,
  trust,
  installationId,
  envelope: raw,
  expect,
  sealers,
}: {
  reader: PrivateIdentity;
  trust: TrustStore;
  installationId: InstallationId;
  envelope: unknown;
  expect: { spaceId: SpaceId; shareId: ShareId };
  sealers: OpensOwner;
}): OpenedFolderKeys {
  const envelope = parseWith(FolderKeyEnvelope, raw, 'Folder key envelope');
  if (envelope.spaceId !== expect.spaceId || envelope.shareId !== expect.shareId) {
    throw new CryptoError('binding-mismatch', 'Folder key envelope is for another share');
  }
  if (
    envelope.recipientId !== reader.public.id ||
    envelope.recipientKeyVersion !== reader.public.keyVersion
  ) {
    throw new CryptoError('wrong-recipient', 'Folder key envelope is not for this reader');
  }
  const sealer = trust.require(envelope.sealerId, envelope.sealerKeyVersion);
  requireAcceptedOwner(sealers, sealer, 'sealer');
  if (
    !verifySignature(sealer, folderKeyEnvelopeBytes(installationId, envelope), envelope.signature)
  ) {
    throw new CryptoError('bad-signature', 'Folder key envelope signature is invalid');
  }
  // The shape fixes each sealed key at 80 bytes, so each opens to 32.
  const publishedKey = openSealedKey(reader, envelope.publishedKey);
  try {
    const draftKey = envelope.draftKey === null ? null : openSealedKey(reader, envelope.draftKey);
    return { ...expect, keyVersion: envelope.keyVersion, draftKey, publishedKey, sealer };
  } catch (error) {
    sodium.memzero(publishedKey);
    throw error;
  }
}

/** One key version this client holds, as one envelope gave it. */
export type HeldKeyVersion = Readonly<OpenedFolderKeys>;

/**
 * The folder keys this client has opened, in memory while it is unlocked
 * (section 3.4), always named by `(spaceId, shareId, keyVersion)`, never by
 * share alone. Each envelope's keys are kept with their sealer, so writing
 * can take only versions sealed by an owner it still accepts for writing
 * (section 6.5).
 */
export class FolderKeyring {
  // Keyed by space and share, then by key version, then by sealer.
  readonly #held = new Map<string, Map<number, Map<IdentityId, HeldKeyVersion>>>();
  #wiped = false;

  /**
   * Keep an opened key version. The keyring then owns its keys, and wipes
   * them when they are replaced or it is wiped. A later envelope from the
   * same sealer for the same version replaces the earlier one, as when a
   * reader becomes an editor, but a reader's envelope never takes away a
   * draft key held for that version: only a rotation demotes (section 7.4).
   * Once the keyring is wiped, it wipes what it is given and refuses it
   * (`missing-key`), so a load still running when the app locked keeps
   * nothing.
   */
  add(opened: OpenedFolderKeys): void {
    if (this.#wiped) {
      wipe(opened);
      throw new CryptoError('missing-key', 'The app locked; its folder keys are gone');
    }
    const share = `${opened.spaceId} ${opened.shareId}`;
    const versions = this.#held.get(share) ?? new Map<number, Map<IdentityId, HeldKeyVersion>>();
    this.#held.set(share, versions);
    const sealers = versions.get(opened.keyVersion) ?? new Map<IdentityId, HeldKeyVersion>();
    versions.set(opened.keyVersion, sealers);
    const replaced = sealers.get(opened.sealer.id);
    if (replaced?.draftKey && opened.draftKey === null) {
      wipe(opened, replaced);
      return;
    }
    sealers.set(opened.sealer.id, Object.freeze({ ...opened }));
    if (replaced) wipe(replaced, opened);
  }

  /** Every key version held for one share, each once per sealer, highest first. */
  versions(spaceId: SpaceId, shareId: ShareId): HeldKeyVersion[] {
    const versions = this.#held.get(`${spaceId} ${shareId}`);
    if (!versions) return [];
    return [...versions.values()]
      .flatMap((sealers) => [...sealers.values()])
      .sort((a, b) => b.keyVersion - a.keyVersion);
  }

  /** The keys held for one version and class. Normally one; none for a reader's draft class. */
  keysFor(
    spaceId: SpaceId,
    shareId: ShareId,
    keyVersion: number,
    audienceClass: AudienceClass,
  ): Uint8Array[] {
    return this.versions(spaceId, shareId).flatMap((held) => {
      const key = held.keyVersion === keyVersion ? folderKeyOf(held, audienceClass) : null;
      return key ? [key] : [];
    });
  }

  /** Wipe every key, as the app does when it locks. */
  wipe(): void {
    this.#wiped = true;
    for (const versions of this.#held.values()) {
      for (const sealers of versions.values()) for (const held of sealers.values()) wipe(held);
    }
    this.#held.clear();
  }
}

// Wipe `held`'s keys, but not an array `kept` still holds, as when the same
// keys are added twice.
function wipe(held: HeldKeyVersion, kept?: HeldKeyVersion): void {
  for (const key of [held.publishedKey, held.draftKey]) {
    if (key && key !== kept?.publishedKey && key !== kept?.draftKey) sodium.memzero(key);
  }
}
