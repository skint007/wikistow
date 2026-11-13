// A live session between test identities (protocol section 5.10): Alice and
// Bob own the space, Carol edits its share, Dave only reads it. Each app's
// trust store, owners, keyring and marks are built as a real app's are.
import {
  aeadEncrypt,
  acceptOwners,
  FolderKeyring,
  generateIdentity,
  grantMetadataKeyV2,
  hash,
  IdentityId,
  InstallationId,
  keyCommitment,
  keyHash,
  MemoryKeyVersionMarks,
  metadataAd,
  metadataRecordV2Bytes,
  MetadataRevisionId,
  newFolderKeys,
  openFolderKeys,
  OWNER_REGION,
  PageId,
  RevisionId,
  sealedBytes,
  sealFolderKeys,
  ShareId,
  sign,
  SpaceId,
  toBase64,
  TrustStore,
  utf8,
  wrapContentKey,
  type FolderKeys,
  type PrivateIdentity,
  type PublicIdentity,
  type Region,
} from '../../src/index.ts';
import * as Y from 'yjs';
import {
  JoinId,
  liveClientId,
  LiveDocument,
  liveWrapSubject,
  LiveSessionId,
  openLiveMessage,
  openLiveSession,
  readSnapshot,
  sealLiveMessage,
  startLiveSession,
  type ListedJoin,
  type LiveAccess,
  type LiveBinding,
  type LiveKeyTarget,
  type LiveMessage,
  type StartedLiveSession,
} from '../../src/live/index.ts';
import { sodium } from '../../src/sodium.ts';
import { opensAnyone } from './anyone.ts';
import { directoryEntry } from './testing.ts';

export const code = (expected: string) => ({ code: expected });
export const installationId = InstallationId.parse('test-installation');
export const spaceId = SpaceId.parse('space');
export const pageId = PageId.parse('page');
export const shareId = ShareId.parse('share');
export const draftId = RevisionId.parse('draft-1');
export const share: Region = { kind: 'share', spaceId, shareId };

const person = (id: string) => generateIdentity({ id: IdentityId.parse(id), kind: 'human' });
export const alice = person('alice');
export const bob = person('bob');
export const carol = person('carol');
export const dave = person('dave');
export const mallory = person('mallory');
export const people = [alice, bob, carol, dave, mallory];
const directory = people.map((p) => directoryEntry(p.public));
const ref = (p: PrivateIdentity) => ({ id: p.public.id, keyHash: keyHash(p.public) });

export const v1 = newFolderKeys();
export const v2 = newFolderKeys();

/** A folder key envelope of `keyVersion` from Alice. */
export const folderEnvelope = (
  recipient: PublicIdentity,
  {
    keyVersion = 1,
    keys = v1,
    editor = true,
  }: { keyVersion?: number; keys?: FolderKeys; editor?: boolean } = {},
) =>
  sealFolderKeys({
    sealer: alice,
    installationId,
    spaceId,
    shareId,
    keyVersion,
    recipient,
    keys: { draftKey: editor ? keys.draftKey : null, publishedKey: keys.publishedKey },
  });

/** One person's app: what it trusts, its owners and folder keys, and its marks. */
export function app(
  self: PrivateIdentity,
  {
    listedOwners = [alice, bob],
    editor = self !== dave,
    region = share,
  }: { listedOwners?: PrivateIdentity[]; editor?: boolean; region?: Region } = {},
) {
  const trust = new TrustStore(installationId);
  trust.pinSelf(self);
  for (const other of people) if (other !== self) trust.use(directoryEntry(other.public));
  const keyring = new FolderKeyring();
  keyring.add(
    openFolderKeys({
      reader: self,
      trust,
      installationId,
      envelope: folderEnvelope(self.public, { editor }),
      expect: { spaceId, shareId },
      sealers: opensAnyone,
    }),
  );
  const owners = acceptOwners({
    installationId,
    spaceId,
    self: self.public,
    trust,
    entry: { spaceId, owners: [ref(alice), ref(bob)], removedOwners: [] },
    nameRecords: [],
    statements: [],
    envelopes: [],
    listedOwners: listedOwners.map((p) => p.public),
    directory,
  });
  const marks = new MemoryKeyVersionMarks();
  const access: LiveAccess = { owners, keyring, marks, draftRegion: region };
  /** Hold version 2 of the share too, as after a rotation. */
  const rotate = () =>
    keyring.add(
      openFolderKeys({
        reader: self,
        trust,
        installationId,
        envelope: folderEnvelope(self.public, { keyVersion: 2, keys: v2 }),
        expect: { spaceId, shareId },
        sealers: opensAnyone,
      }),
    );
  return { self, trust, keyring, owners, marks, access, rotate };
}
export type App = ReturnType<typeof app>;

/** Where a session goes from Alice's app: the share at version 1, or the owners. */
export const inShare: LiveKeyTarget = {
  share: { shareId, keyVersion: 1, draftKey: v1.draftKey },
};
export const toOwners: LiveKeyTarget = { owners: [alice.public, bob.public] };

export const start = (author: PrivateIdentity = carol, to: LiveKeyTarget = inShare) =>
  startLiveSession({ author, installationId, spaceId, pageId, revisionId: draftId, ...to });

/** Open `started` in `reader`'s app, as served: its wrap, or that reader's envelopes. */
export const open = (
  started: {
    sealed: unknown;
    wrap: unknown;
    envelopes: readonly { recipientId: string }[];
    sessionId: StartedLiveSession['sessionId'];
  },
  reader: App,
  envelopesFor: PublicIdentity = reader.self.public,
) =>
  openLiveSession({
    reader: reader.self,
    trust: reader.trust,
    installationId,
    sealed: {
      record: started.sealed,
      wrap: started.wrap,
      envelopes: started.envelopes.filter((e) => e.recipientId === envelopesFor.id),
    },
    expected: { spaceId, pageId, sessionId: started.sessionId },
    access: reader.access,
  });

/**
 * A session record made by hand, for what an honest starter never writes:
 * any payload, any author, wrapped under any folder key, or sealed to any
 * recipients by any granter.
 */
export function forge({
  author = carol,
  payload,
  folderKey = v1.draftKey,
  keyVersion = 1,
  audienceClass = 'draft' as const,
  recipients,
  granter = author,
}: {
  author?: PrivateIdentity;
  payload: Record<string, unknown>;
  folderKey?: Uint8Array;
  keyVersion?: number;
  audienceClass?: 'draft' | 'published';
  recipients?: PublicIdentity[];
  granter?: PrivateIdentity;
}): Pick<StartedLiveSession, 'sealed' | 'wrap' | 'envelopes' | 'sessionId'> {
  const sessionId = LiveSessionId.parse('forged-session');
  const bound = {
    protocol: 2 as const,
    installationId,
    spaceId,
    subjectKind: 'live' as const,
    subjectId: sessionId,
    metadataRevisionId: MetadataRevisionId.parse('forged-version'),
    basedOn: null,
    authorId: author.public.id,
    authorKeyVersion: author.public.keyVersion,
  };
  const contentKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  const sealedPayload = aeadEncrypt({
    key: contentKey,
    plaintext: utf8(JSON.stringify(payload)),
    ad: metadataAd(bound),
  });
  const record = {
    ...bound,
    payloadHash: hash(sealedBytes(sealedPayload)),
    keyCommitment: keyCommitment(contentKey),
  };
  const sealed = {
    record,
    signature: sign(author, metadataRecordV2Bytes(record)),
    payload: sealedPayload,
  };
  if (recipients) {
    const envelopes = recipients.map((recipient) =>
      grantMetadataKeyV2({ granter, record, contentKey, recipient }),
    );
    return { sessionId, sealed, wrap: null, envelopes };
  }
  const subject = {
    ...liveWrapSubject({ spaceId, sessionId, versionId: record.metadataRevisionId }),
    audienceClass,
  };
  const wrap = wrapContentKey({
    installationId,
    subject,
    shareId,
    keyVersion,
    folderKey,
    contentKey,
  });
  return { sessionId, sealed, wrap, envelopes: [] };
}

/** A session payload as an honest starter writes it, to change one thing in. */
export const sessionPayload = (changes: Record<string, unknown> = {}) => ({
  format: { major: 1, minor: 0 },
  pageId,
  revisionId: draftId,
  joinId: JoinId.parse('starter-join'),
  key: toBase64(new Uint8Array(32).fill(1)),
  sealedTo: null,
  extensions: {},
  ...changes,
});

export { OWNER_REGION };

/**
 * One join of a session, typing into its own document and sealing what it
 * sends as an app does: each batch the merge of its transactions' updates,
 * its `clock` the client's state after them, numbered by `seq` from 1.
 */
export class Typist {
  readonly sender: PrivateIdentity;
  readonly joinId: JoinId;
  readonly clientId: number;
  readonly document: LiveDocument;
  readonly binding: LiveBinding;
  seq = 0;
  #unsent: Uint8Array[] = [];

  constructor(
    sender: PrivateIdentity,
    binding: LiveBinding,
    joinId = JoinId.parse(`${sender.public.id}-join`),
    document?: LiveDocument,
  ) {
    this.sender = sender;
    this.binding = binding;
    this.joinId = joinId;
    this.clientId = liveClientId({
      installationId,
      sessionId: binding.sessionId,
      senderId: sender.public.id,
      senderKeyVersion: sender.public.keyVersion,
      joinId,
    });
    this.document = document ?? new LiveDocument(this.clientId);
    this.document.doc.on(
      'update',
      (u: Uint8Array, _origin: unknown, _doc: unknown, transaction: { local: boolean }) => {
        if (transaction.local) this.#unsent.push(u);
      },
    );
  }

  get listed(): ListedJoin {
    return {
      senderId: this.sender.public.id,
      senderKeyVersion: this.sender.public.keyVersion,
      joinId: this.joinId,
      parent: null,
      present: true,
    };
  }

  type(change: (document: LiveDocument) => void): this {
    this.document.edit(() => change(this.document));
    return this;
  }

  /** Take what another join sent into this document, as a receiver would after its checks. */
  receive(message: LiveMessage): void {
    const opened = openLiveMessage({
      binding: this.binding,
      trust: TRUST,
      listed: () => true,
      message,
    });
    const read = opened.kind === 'snapshot' ? readSnapshot(opened.content) : null;
    const update = read
      ? read.kind === 'current'
        ? read.state
        : new Uint8Array()
      : opened.content;
    const misplaced = this.document.apply(update);
    if (misplaced.length > 0) throw new Error(misplaced[0]?.why);
  }

  /** Seal what is unsent as one `update`. */
  send(): LiveMessage {
    const batch =
      this.#unsent.length === 1 ? (this.#unsent[0] as Uint8Array) : Y.mergeUpdates(this.#unsent);
    this.#unsent = [];
    return this.seal('update', batch);
  }

  seal(
    kind: 'update' | 'snapshot' | 'saved',
    content: Uint8Array,
    clock = Y.getState(this.document.doc.store, this.clientId),
  ): LiveMessage {
    this.seq += 1;
    return sealLiveMessage({
      sender: this.sender,
      binding: this.binding,
      kind,
      joinId: this.joinId,
      seq: this.seq,
      clock,
      content,
    });
  }
}

// Every test identity, pinned, for typists that take each other's messages.
const TRUST = new TrustStore(installationId);
for (const p of people) TRUST.use(directoryEntry(p.public));
export { TRUST as everyoneTrusted };
