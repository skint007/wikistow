// Test-only helpers shared with other packages' tests as `@wikistow/client/testing`.
import {
  aeadEncrypt,
  canonical,
  CryptoError,
  decryptRevisionPayload,
  fromBase64,
  hash,
  keyEnvelopeBytes,
  openAttachment,
  openSealedKey,
  revisionRecordBytes,
  sealedBytes,
  sealKeyTo,
  sign,
  toBase64,
  utf8,
  type AttachmentId,
  type AttachmentTarget,
  type Lookup,
  type PrivateIdentity,
  type PublicIdentity,
  type RevisionRecord,
  type sealRevision,
  type SealedRevision,
} from '../../src/index.ts';
import type { ApiClient } from '../../src/api/client.ts';
import type { AccountId } from '../../src/ids.ts';
import { spaceKeys } from '../../src/operations/keys.ts';
import { keyTargetFor, treeTarget } from '../../src/operations/records.ts';
import type { ClientContext } from '../../src/operations/session.ts';
import { prepareVault, registerVault, type VaultCrypto } from '../../src/operations/vault.ts';
import { OWNER_REGION } from '../../src/regions.ts';
import type { FolderId, PageId, SpaceId } from '../../src/ids.ts';
import { sodium } from '../../src/sodium.ts';
import type { KdfParams, UnlockedVault } from '../../src/vault.ts';

/** Argon2id at its minimum cost, so tests stay fast. Never use outside tests. */
export const FAST_KDF: KdfParams = {
  opsLimit: sodium.crypto_pwhash_OPSLIMIT_MIN,
  memLimit: sodium.crypto_pwhash_MEMLIMIT_MIN,
};

/**
 * `identity` as the directory would list it, named `name`, with an email made
 * from the name, looked up by identity rather than by email (`foundBy: null`;
 * spread in `foundBy` for a lookup by email). Tests only: pinning it with
 * `TrustStore.use` stands for meeting the person for the first time.
 */
export const directoryEntry = (identity: PublicIdentity, name: string = identity.id): Lookup => ({
  identity,
  name,
  foundBy: null,
  email: `${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '')}@example.org`,
});

/** Strings that must never appear in anything the server stores or logs. */
export const MARKERS = {
  title: 'Network notes PLAINTEXT-TITLE-7f3a',
  publishedBody: 'Router admin is on vlan 20. PLAINTEXT-PUBLISHED-c41d',
  privateBody: 'The wifi password is hunter2. PLAINTEXT-PRIVATE-9b2e',
  attachmentName: 'router-photo PLAINTEXT-FILENAME-15aa.jpg',
  attachmentBody: 'JPEG bytes PLAINTEXT-ATTACHMENT-e07c',
  privatePageBody: 'Owner-only page PLAINTEXT-OTHER-PAGE-33d1',
  ownerPassphrase: 'owner vault passphrase PLAINTEXT-PASSPHRASE-a8f0',
  ownerPassword: 'owner account password PLAINTEXT-PASSWORD-61c2',
} as const;

/**
 * Everything an attacker could read from a snapshot: its text, plus every
 * base64url field decoded to bytes, recursing into decoded JSON. Searching
 * decoded bytes finds data inside a larger encoded field at any byte offset,
 * which a search of the encoded text alone would miss.
 */
export function readableCorpus(snapshot: string): Buffer {
  const parts = [Buffer.from(snapshot)];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (!/^[\w-]{4,}$/.test(value)) return;
      const bytes = Buffer.from(value, 'base64url');
      parts.push(bytes);
      try {
        visit(JSON.parse(bytes.toString('utf8')));
      } catch {
        // Not JSON; the raw bytes are already in the corpus.
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value !== null && typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  };
  visit(JSON.parse(snapshot));
  return Buffer.concat(parts);
}

/** Whether `secret` appears raw, or in any encoding a bug might plausibly use. */
export const exposes = (corpus: Buffer, secret: Uint8Array) =>
  [
    secret,
    utf8(toBase64(secret)),
    utf8(sodium.to_base64(secret, sodium.base64_variants.ORIGINAL)),
    utf8(sodium.to_hex(secret)),
  ].some((form) => corpus.includes(form));

/**
 * A v1 revision sealed as a Milestone 1 client did: its shape checked, but
 * with no strict round trip, so its text may hold a lone surrogate that no
 * writer seals today. Pass `contentKey` to keep the key, say to wrap it the
 * way making a share does; it is left unwiped.
 */
export function sealAsMilestone1(
  { author, target, payload, recipients }: Parameters<typeof sealRevision>[0],
  contentKey?: Uint8Array,
): ReturnType<typeof sealRevision> {
  const key = contentKey ?? sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  const authored = { authorId: author.public.id, authorKeyVersion: author.public.keyVersion };
  const sealed = aeadEncrypt({
    key,
    plaintext: utf8(JSON.stringify(payload)),
    ad: canonical('revision-payload/v1', [
      target.installationId,
      target.spaceId,
      target.pageId,
      target.revisionId,
      target.audience,
      authored.authorId,
      authored.authorKeyVersion,
    ]),
  });
  const record: RevisionRecord = {
    protocol: 1,
    ...target,
    ...authored,
    payloadHash: hash(sealedBytes(sealed)),
  };
  const envelopes = recipients.map((recipient) => {
    const unsigned = {
      revisionId: target.revisionId,
      recipientId: recipient.id,
      recipientKeyVersion: recipient.keyVersion,
      sealedKey: sealKeyTo(key, recipient),
      granterId: authored.authorId,
      granterKeyVersion: authored.authorKeyVersion,
    };
    return { ...unsigned, signature: sign(author, keyEnvelopeBytes(record, unsigned)) };
  });
  if (!contentKey) sodium.memzero(key);
  return {
    revision: { record, signature: sign(author, revisionRecordBytes(record)), payload: sealed },
    envelopes,
  };
}

// Attacks on stored ciphertext that bypass the server, using one identity's keys.

/** Every content key `identity` can unseal from a full envelope table. */
export function stealableKeys(
  envelopes: readonly { sealedKey: string }[],
  identity: PrivateIdentity,
): Uint8Array[] {
  return envelopes.flatMap((envelope) => {
    try {
      return [openSealedKey(identity, envelope.sealedKey)];
    } catch (error) {
      if (error instanceof CryptoError && error.code === 'decrypt-failed') return [];
      throw error;
    }
  });
}

/** Whether any of `keys` decrypts `revision` under its real binding. */
export function anyKeyDecrypts(keys: Uint8Array[], revision: SealedRevision): boolean {
  return keys.some((contentKey) => {
    try {
      decryptRevisionPayload({ ...revision, contentKey });
      return true;
    } catch (error) {
      if (error instanceof CryptoError && error.code === 'decrypt-failed') return false;
      throw error;
    }
  });
}

/**
 * Every 32-byte value hidden in data someone can decrypt: any string that
 * decodes from base64url to 32 bytes. Lets a test try keys an attacker could
 * find inside content they're allowed to read, not just their own envelopes.
 */
export function keysIn(json: unknown): Uint8Array[] {
  if (typeof json === 'string') {
    try {
      const bytes = fromBase64(json);
      return bytes.length === 32 ? [bytes] : [];
    } catch {
      return [];
    }
  }
  if (Array.isArray(json)) return json.flatMap(keysIn);
  if (json !== null && typeof json === 'object') return Object.values(json).flatMap(keysIn);
  return [];
}

/** Whether any key opens `blob` as an attachment with any of the known IDs at `target`. */
export function anyKeyOpensBlob({
  keys,
  ids,
  target,
  blob,
}: {
  keys: Uint8Array[];
  ids: AttachmentId[];
  target: AttachmentTarget;
  blob: Uint8Array;
}): boolean {
  return keys.some((key) =>
    ids.some((id) => {
      const ref = {
        id,
        name: '',
        mediaType: '',
        size: 0,
        key: toBase64(key),
        blobHash: hash(blob),
      };
      try {
        openAttachment({ target, ref, blob });
        return true;
      } catch (error) {
        if (error instanceof CryptoError && error.code === 'decrypt-failed') return false;
        throw error;
      }
    }),
  );
}

/**
 * Prepare and register a vault in one step. Tests only: a real client shows
 * the recovery key between the two, and retries a lost registration with the
 * same prepared vault, so the key shown stays the one that works.
 */
export async function setUpVault(input: {
  api: ApiClient;
  crypto: VaultCrypto;
  accountId: AccountId;
  passphrase: string;
  kdf?: KdfParams;
}): Promise<{ vault: UnlockedVault; recoveryKey: string }> {
  const prepared = await prepareVault(input);
  await registerVault(input.api, prepared);
  return { vault: prepared.vault, recoveryKey: prepared.recoveryKey };
}

/**
 * Where a hand-made write at `nodeId` (a page, or for a new node its parent
 * folder, or the space at `null`) puts its content key, and the permission
 * version it carries, worked out with the operations' own rules, taking the
 * region from the server's tree: a test that breaks one thing on purpose
 * starts from a write the server would accept.
 */
export async function writeTargetOf(
  ctx: ClientContext,
  spaceId: SpaceId,
  nodeId: FolderId | PageId | null,
) {
  const target = await treeTarget(ctx, spaceId, nodeId);
  const keys = await spaceKeys(ctx, spaceId, { refresh: true });
  const region = target.share
    ? { kind: 'share' as const, spaceId, shareId: target.share.shareId }
    : OWNER_REGION;
  return {
    keyTarget: keyTargetFor(ctx, keys, region, target.share),
    permissionVersion: target.permissionVersion,
  };
}

// Wikilink pieces and whitespace, often enough to meet in every order.
const FUZZ_PIECES = '[[ ]] ![[ [ ] ! # | \\ ^ .png a é ` `` \\` < <b> > - * \n \r'.split(' ');
const FUZZ_SPACES = [' ', '\t', '\t', '\u00a0', '\u3000'];
const FUZZ_ALPHABET = [...FUZZ_PIECES, ...FUZZ_SPACES, ...FUZZ_SPACES];

/**
 * `count` short Markdown texts made of wikilink pieces, tabs and other
 * spaces (or of `alphabet`), the same every run, so a failure names its
 * input again.
 */
export function wikilinkFuzz(
  count: number,
  seed = 7,
  alphabet: readonly string[] = FUZZ_ALPHABET,
): string[] {
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 2 ** 32;
  };
  return Array.from({ length: count }, () =>
    Array.from(
      { length: Math.floor(next() * 24) },
      () => alphabet[Math.floor(next() * alphabet.length)],
    ).join(''),
  );
}
