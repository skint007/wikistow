// A disposable, in-memory stand-in for the WikiStow server, for Milestone 0.
// It plays the untrusted role: it stores only what the real server would
// (IDs, ciphertext, wrapped keys, public keys) and enforces authorization,
// expected heads, and permission versions. Tests can tamper with it directly.
import {
  KeyEnvelope,
  SealedRevision,
  verifySignature,
  hash,
  keyEnvelopeBytes,
  revisionRecordBytes,
  type AccountId,
  type Audience,
  type IdentityId,
  type InstallationId,
  type PageId,
  type PublicIdentity,
  type RevisionId,
  type SpaceId,
  type VaultWrapper,
} from '../../src/index.ts';

export type Role = 'reader' | 'editor' | 'publisher' | 'owner';

const readsDrafts = (role: Role) => role !== 'reader';
const publishes = (role: Role) => role === 'publisher' || role === 'owner';

type PageState = {
  spaceId: SpaceId;
  permissionVersion: number;
  grants: Map<IdentityId, Role>;
  draftHead: RevisionId | null;
  publishedHead: RevisionId | null;
};

type StoredBlob = { pageId: PageId; audience: Audience; bytes: Uint8Array };

export type CommitFailure =
  | 'forbidden'
  | 'stale-head'
  | 'permission-version'
  | 'recipients-mismatch'
  | 'bad-signature'
  /** The revision ID is taken, or a blob already belongs to another page or audience. */
  | 'duplicate'
  /** A blob the revision references is neither uploaded with it nor stored for its page and audience. */
  | 'missing-blob';

export type CommitResult = { ok: true } | { ok: false; reason: CommitFailure };

export type Commit = {
  actor: IdentityId;
  revision: SealedRevision;
  envelopes: KeyEnvelope[];
  /** New encrypted blobs to store with this revision. */
  blobs: Uint8Array[];
  /**
   * Hashes of every blob the revision's attachments use. The server can't read
   * the payload, so the client declares them and the server checks they exist.
   */
  references: string[];
  permissionVersion: number;
};

export class MemoryServer {
  readonly installationId: InstallationId;
  readonly directory = new Map<IdentityId, PublicIdentity>();
  readonly vaults = new Map<AccountId, VaultWrapper>();
  readonly pages = new Map<PageId, PageState>();
  readonly revisions = new Map<RevisionId, SealedRevision>();
  readonly envelopes: KeyEnvelope[] = [];
  readonly blobs = new Map<string, StoredBlob>();

  constructor(installationId: InstallationId) {
    this.installationId = installationId;
  }

  registerIdentity(identity: PublicIdentity): void {
    this.directory.set(identity.id, structuredClone(identity));
  }

  createPage({
    pageId,
    spaceId,
    owner,
  }: {
    pageId: PageId;
    spaceId: SpaceId;
    owner: IdentityId;
  }): void {
    this.pages.set(pageId, {
      spaceId,
      permissionVersion: 1,
      grants: new Map([[owner, 'owner']]),
      draftHead: null,
      publishedHead: null,
    });
  }

  grant(pageId: PageId, identityId: IdentityId, role: Role): void {
    const page = this.#page(pageId);
    page.grants.set(identityId, role);
    page.permissionVersion += 1;
  }

  /** Who must receive keys for a new revision, from the (untrusted) directory. */
  audience(
    pageId: PageId,
    audience: Audience,
  ): { permissionVersion: number; recipients: PublicIdentity[] } {
    const page = this.#page(pageId);
    const recipients = [...page.grants]
      .filter(([, role]) => audience === 'published' || readsDrafts(role))
      .map(([id]) => this.#identity(id));
    return { permissionVersion: page.permissionVersion, recipients };
  }

  heads(pageId: PageId): Omit<PageState, 'grants'> {
    const { grants: _grants, ...heads } = this.#page(pageId);
    return heads;
  }

  /** Advance the draft head if `basedOn` is still the head and permissions have not changed. */
  saveDraft(commit: Commit): CommitResult {
    const { record } = commit.revision;
    const page = this.#page(record.pageId);
    const role = page.grants.get(commit.actor);
    if (record.audience !== 'draft' || !role || !readsDrafts(role))
      return this.#reject(commit, 'forbidden');
    if (record.basedOn !== page.draftHead) return this.#reject(commit, 'stale-head');
    return this.#commit(commit, page, () => {
      page.draftHead = record.revisionId;
    });
  }

  /** Advance the published head to a payload prepared from the current draft head. */
  publish(commit: Commit & { expectedPublishedHead: RevisionId | null }): CommitResult {
    const { record } = commit.revision;
    const page = this.#page(record.pageId);
    const role = page.grants.get(commit.actor);
    if (record.audience !== 'published' || !role || !publishes(role))
      return this.#reject(commit, 'forbidden');
    if (record.basedOn === null || record.basedOn !== page.draftHead)
      return this.#reject(commit, 'stale-head');
    if (commit.expectedPublishedHead !== page.publishedHead)
      return this.#reject(commit, 'stale-head');
    return this.#commit(commit, page, () => {
      page.publishedHead = record.revisionId;
    });
  }

  /** A revision and the caller's own envelope, if the caller's current grants allow it. */
  fetchRevision(
    actor: IdentityId,
    revisionId: RevisionId,
  ): { revision: SealedRevision; envelopes: KeyEnvelope[] } | undefined {
    const revision = this.revisions.get(revisionId);
    if (!revision) return undefined;
    const role = this.pages.get(revision.record.pageId)?.grants.get(actor);
    const allowed =
      role !== undefined && (revision.record.audience === 'published' || readsDrafts(role));
    const envelope = this.envelopes.find(
      (e) => e.revisionId === revisionId && e.recipientId === actor,
    );
    return allowed && envelope ? { revision, envelopes: [envelope] } : undefined;
  }

  fetchBlob(actor: IdentityId, blobHash: string): Uint8Array | undefined {
    const blob = this.blobs.get(blobHash);
    if (!blob) return undefined;
    const role = this.pages.get(blob.pageId)?.grants.get(actor);
    const allowed = role !== undefined && (blob.audience === 'published' || readsDrafts(role));
    return allowed ? blob.bytes : undefined;
  }

  #commit(commit: Commit, page: PageState, advance: () => void): CommitResult {
    const { record, signature } = commit.revision;
    if (commit.actor !== record.authorId) return this.#reject(commit, 'forbidden');
    if (record.installationId !== this.installationId || record.spaceId !== page.spaceId) {
      return this.#reject(commit, 'forbidden');
    }
    if (commit.permissionVersion !== page.permissionVersion)
      return this.#reject(commit, 'permission-version');

    // Revisions are immutable and blobs keep the audience they were uploaded for.
    if (this.revisions.has(record.revisionId)) return this.#reject(commit, 'duplicate');
    const relabels = commit.blobs.some((bytes) => {
      const existing = this.blobs.get(hash(bytes));
      return (
        existing && (existing.pageId !== record.pageId || existing.audience !== record.audience)
      );
    });
    if (relabels) return this.#reject(commit, 'duplicate');

    // Readers must never see a publication whose attachments can't be fetched.
    const uploaded = new Set(commit.blobs.map((bytes) => hash(bytes)));
    const missing = commit.references.some((blobHash) => {
      if (uploaded.has(blobHash)) return false;
      const stored = this.blobs.get(blobHash);
      return !stored || stored.pageId !== record.pageId || stored.audience !== record.audience;
    });
    if (missing) return this.#reject(commit, 'missing-blob');

    // The server can't read content, but it can check what it can see:
    // the author's signature and that keys went to exactly the current audience.
    const author = this.#identity(record.authorId);
    const signed = revisionRecordBytes(record);
    if (
      author.keyVersion !== record.authorKeyVersion ||
      !verifySignature(author, signed, signature)
    ) {
      return this.#reject(commit, 'bad-signature');
    }
    const expected = this.audience(record.pageId, record.audience).recipients.map(
      (r) => `${r.id}@${r.keyVersion}`,
    );
    const given = commit.envelopes.map((e) => `${e.recipientId}@${e.recipientKeyVersion}`);
    const allForThisRevision = commit.envelopes.every((e) => e.revisionId === record.revisionId);
    if (!allForThisRevision || !sameSet(expected, given))
      return this.#reject(commit, 'recipients-mismatch');

    // The committer grants these keys, so every envelope must carry their
    // valid signature, or recipients would get a revision they can't verify.
    const envelopesSigned = commit.envelopes.every(
      (e) =>
        e.granterId === commit.actor &&
        e.granterKeyVersion === author.keyVersion &&
        verifySignature(author, keyEnvelopeBytes(record, e), e.signature),
    );
    if (!envelopesSigned) return this.#reject(commit, 'bad-signature');

    this.revisions.set(record.revisionId, commit.revision);
    this.envelopes.push(...commit.envelopes);
    for (const bytes of commit.blobs) {
      this.blobs.set(hash(bytes), { pageId: record.pageId, audience: record.audience, bytes });
    }
    advance();
    return { ok: true };
  }

  #reject(commit: Commit, reason: CommitFailure): CommitResult {
    return { ok: false, reason };
  }

  #page(pageId: PageId): PageState {
    const page = this.pages.get(pageId);
    if (!page) throw new Error(`No page ${pageId}`);
    return page;
  }

  #identity(id: IdentityId): PublicIdentity {
    const identity = this.directory.get(id);
    if (!identity) throw new Error(`No identity ${id}`);
    return identity;
  }
}

const sameSet = (a: string[], b: string[]) => [...a].sort().join('\n') === [...b].sort().join('\n');
