// The Milestone 0 cast and story: an owner, an editor agent, and a reader,
// each with independent keys. The agent drafts a page with an attachment,
// the owner publishes it, then the owner makes a private edit.
import {
  AccountId,
  createVault,
  enrollAgent,
  generateIdentity,
  IdentityId,
  InstallationId,
  newId,
  newPayload,
  openRevision,
  PageId,
  resealAttachment,
  revisePayload,
  RevisionId,
  enrollmentFingerprint,
  sealAttachment,
  sealRevision,
  SpaceId,
  TrustStore,
  utf8,
  type AttachmentTarget,
  type Audience,
  type PagePayload,
  type PrivateIdentity,
  type RevisionTarget,
} from '../../src/index.ts';
import { opensAnyone } from '../support/anyone.ts';
import { directoryEntry, FAST_KDF, MARKERS } from '../support/testing.ts';
import { MemoryServer, type Commit } from './server.ts';

export { FAST_KDF, MARKERS };

/** A client: one identity, the keys it has verified, and a connection to the server. */
export class Person {
  readonly identity: PrivateIdentity;
  readonly server: MemoryServer;
  readonly trust: TrustStore;

  constructor(identity: PrivateIdentity, server: MemoryServer) {
    this.identity = identity;
    this.server = server;
    this.trust = new TrustStore(server.installationId);
    server.registerIdentity(identity.public);
    this.trust.pinSelf(identity);
  }

  get id(): IdentityId {
    return this.identity.public.id;
  }

  /** Fetch and open a revision the server is willing to give this person. */
  read(pageId: PageId, revisionId: RevisionId, audience?: Audience) {
    const fetched = this.server.fetchRevision(this.id, revisionId);
    if (!fetched) throw new Error(`${this.id} cannot fetch ${revisionId}`);
    return openRevision({
      reader: this.identity,
      trust: this.trust,
      owners: opensAnyone,
      ...fetched,
      expect: { ...this.#where(pageId), revisionId, ...(audience ? { audience } : {}) },
    });
  }

  /** Encrypt a new draft against the current head and audience, without committing it. */
  prepareDraft(pageId: PageId, payload: PagePayload, blobs: Uint8Array[] = []): Commit {
    const { draftHead } = this.server.heads(pageId);
    const { permissionVersion, recipients } = this.server.audience(pageId, 'draft');
    const target: RevisionTarget = {
      ...this.#where(pageId),
      revisionId: newId(RevisionId),
      audience: 'draft',
      basedOn: draftHead,
    };
    const sealed = sealRevision({
      author: this.identity,
      target,
      payload,
      recipients: this.trust.recipients(recipients.map((identity) => directoryEntry(identity))),
    });
    const references = payload.attachments.map((ref) => ref.blobHash);
    return { actor: this.id, ...sealed, blobs, references, permissionVersion };
  }

  saveDraft(pageId: PageId, payload: PagePayload, blobs: Uint8Array[] = []): RevisionId {
    const commit = this.prepareDraft(pageId, payload, blobs);
    const result = this.server.saveDraft(commit);
    if (!result.ok) throw new Error(`Draft rejected: ${result.reason}`);
    return commit.revision.record.revisionId;
  }

  /**
   * Publish the current draft: decrypt it, re-encrypt its content and every
   * attachment under fresh keys for the published audience.
   */
  preparePublication(pageId: PageId): Commit & { expectedPublishedHead: RevisionId | null } {
    const { draftHead, publishedHead } = this.server.heads(pageId);
    if (!draftHead) throw new Error('Nothing to publish');
    const { opened } = this.read(pageId, draftHead, 'draft');
    if (opened.kind !== 'current') throw new Error('Draft is in a newer format');

    const from: AttachmentTarget = { ...this.#where(pageId), audience: 'draft' };
    const to: AttachmentTarget = { ...from, audience: 'published' };
    const attachments = opened.payload.attachments.map((ref) => {
      const blob = this.server.fetchBlob(this.id, ref.blobHash);
      if (!blob) throw new Error(`Missing attachment ${ref.id}`);
      return resealAttachment({ from, to, ref, blob });
    });

    const { permissionVersion, recipients } = this.server.audience(pageId, 'published');
    const sealed = sealRevision({
      author: this.identity,
      target: { ...to, revisionId: newId(RevisionId), basedOn: draftHead },
      payload: revisePayload(opened, { attachments: attachments.map((a) => a.ref) }),
      recipients: this.trust.recipients(recipients.map((identity) => directoryEntry(identity))),
    });
    return {
      actor: this.id,
      ...sealed,
      blobs: attachments.map((a) => a.blob),
      references: attachments.map((a) => a.ref.blobHash),
      permissionVersion,
      expectedPublishedHead: publishedHead,
    };
  }

  publish(pageId: PageId): RevisionId {
    const commit = this.preparePublication(pageId);
    const result = this.server.publish(commit);
    if (!result.ok) throw new Error(`Publish rejected: ${result.reason}`);
    return commit.revision.record.revisionId;
  }

  #where(pageId: PageId) {
    const { spaceId } = this.server.heads(pageId);
    return { installationId: this.server.installationId, spaceId, pageId };
  }
}

function enrolledPair() {
  const installationId = newId(InstallationId);
  const owner = generateIdentity({ id: newId(IdentityId), kind: 'human' });
  const agent = generateIdentity({ kind: 'agent', installationId, ownerId: owner.public.id });
  // Agent enrollment: the CLI and the owner's unlocked session each show the
  // pair's enrollment fingerprint, and the owner confirms they match before signing.
  const enrollment = enrollAgent({
    installationId,
    owner,
    agent: agent.public,
    comparedFingerprint: enrollmentFingerprint({
      installationId,
      owner: owner.public,
      agent: agent.public,
    }),
  });
  return { installationId, owner, agent, enrollment };
}

/** Build the whole Milestone 0 scenario. Each call creates fresh people, keys and content. */
export function buildWorld() {
  const pair = enrolledPair();
  const server = new MemoryServer(pair.installationId);
  const installationId = server.installationId;

  const ownerAccount = newId(AccountId);
  const owner = new Person(pair.owner, server);
  const ownerVault = createVault({
    accountId: ownerAccount,
    identity: owner.identity,
    passphrase: MARKERS.ownerPassphrase,
    kdf: FAST_KDF,
  });
  server.vaults.set(ownerAccount, ownerVault.wrapper);

  const reader = new Person(generateIdentity({ id: newId(IdentityId), kind: 'human' }), server);
  const agent = new Person(pair.agent, server);

  // Owner and reader compare fingerprints in person.
  owner.trust.use(directoryEntry(reader.identity.public));
  reader.trust.use(directoryEntry(owner.identity.public));

  const { enrollment } = pair;
  owner.trust.pinEnrolledAgent(enrollment);
  agent.trust.use(directoryEntry(owner.identity.public));

  const spaceId = newId(SpaceId);
  const page = newId(PageId);
  const privatePage = newId(PageId);
  server.createPage({ pageId: page, spaceId, owner: owner.id });
  server.createPage({ pageId: privatePage, spaceId, owner: owner.id });
  server.grant(page, agent.id, 'editor');
  server.grant(page, reader.id, 'reader');

  // The agent drafts the page with a photo attached.
  const photo = sealAttachment({
    target: { installationId, spaceId, pageId: page, audience: 'draft' },
    name: MARKERS.attachmentName,
    mediaType: 'image/jpeg',
    bytes: utf8(MARKERS.attachmentBody),
  });
  const firstDraft = agent.saveDraft(
    page,
    newPayload({
      title: MARKERS.title,
      markdown: MARKERS.publishedBody,
      attachments: [photo.ref],
      extensions: { 'wikistow.links': [] },
    }),
    [photo.blob],
  );

  const publication = owner.publish(page);

  // A private edit after publication.
  const { opened } = owner.read(page, firstDraft);
  const privateDraft = owner.saveDraft(
    page,
    revisePayload(opened, { markdown: MARKERS.privateBody }),
  );

  owner.saveDraft(
    privatePage,
    newPayload({ title: 'Owner only', markdown: MARKERS.privatePageBody }),
  );

  return {
    server,
    installationId,
    spaceId,
    owner,
    ownerAccount,
    ownerVault,
    reader,
    agent,
    page,
    privatePage,
    revisions: { firstDraft, publication, privateDraft },
  };
}

export type World = ReturnType<typeof buildWorld>;
