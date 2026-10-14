// Writes cross-platform test vectors to test/vectors.json: `pnpm run vectors`.
// The keys inside are test-only. Regenerate only when the protocol changes on
// purpose; the vector tests exist to catch accidental changes.
//
// The identities already in the file are kept, so only what a change touches
// moves. Name sections to regenerate just those, leaving the rest as they are:
//
//   pnpm run vectors m2.revision m2.metadata
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import {
  AccountId,
  AttachmentRef,
  createVault,
  enrollAgent,
  fingerprint,
  generateIdentity,
  IdentityId,
  InstallationId,
  MetadataRevisionId,
  newFolderMetadata,
  newPayload,
  PageId,
  PublicIdentity,
  RevisionId,
  sealAttachment,
  sealMetadata,
  sealRevision,
  enrollmentFingerprint,
  SpaceId,
  fromBase64,
  toBase64,
  utf8,
  type PrivateIdentity,
} from '../src/index.ts';
import { sodium } from '../src/sodium.ts';
import { m2Vectors } from './m2-vectors.ts';

const FILE = new URL('../test/vectors.json', import.meta.url);

const exportIdentity = (identity: PrivateIdentity) => ({
  public: identity.public,
  boxSecretKey: toBase64(identity.boxSecretKey),
  signSecretKey: toBase64(identity.signSecretKey),
});

const ExportedIdentity = z
  .object({ public: PublicIdentity, boxSecretKey: z.string(), signSecretKey: z.string() })
  .transform((raw): PrivateIdentity => ({
    public: raw.public,
    boxSecretKey: fromBase64(raw.boxSecretKey),
    signSecretKey: fromBase64(raw.signSecretKey),
  }));

// The identities of the current file, and the Milestone 2 attachment, whose
// format hasn't changed. Agents' secret keys aren't needed here.
const Previous = z.object({
  author: ExportedIdentity,
  reader: ExportedIdentity,
  enrollment: z.object({ agent: PublicIdentity }),
  m2: z.object({
    author: ExportedIdentity,
    reader: ExportedIdentity,
    agent: ExportedIdentity,
    attachment: z
      .object({ ref: AttachmentRef, blob: z.string().transform((blob) => fromBase64(blob)) })
      .optional(),
  }),
});
const previousFile: unknown = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : undefined;
const previous = previousFile === undefined ? undefined : Previous.parse(previousFile);

const installationId = InstallationId.parse('vector-installation');
const author =
  previous?.author ?? generateIdentity({ id: IdentityId.parse('vector-author'), kind: 'human' });
const reader =
  previous?.reader ?? generateIdentity({ id: IdentityId.parse('vector-reader'), kind: 'human' });
const agent = previous
  ? { public: previous.enrollment.agent }
  : generateIdentity({ kind: 'agent', installationId, ownerId: author.public.id });
const target = {
  installationId,
  spaceId: SpaceId.parse('vector-space'),
  pageId: PageId.parse('vector-page'),
  audience: 'published' as const,
};

const attachment = sealAttachment({
  target,
  name: 'notes.txt',
  mediaType: 'text/plain',
  bytes: utf8('attachment plaintext'),
});
const payload = newPayload({
  title: 'Vector page',
  markdown: '# Hello\n\nUnicode survives: ünïcødé ✓',
  attachments: [attachment.ref],
  extensions: { 'wikistow.links': [{ text: 'Other page', target: 'vector-other' }] },
});
const { revision, envelopes } = sealRevision({
  author,
  target: {
    ...target,
    revisionId: RevisionId.parse('vector-revision'),
    basedOn: RevisionId.parse('vector-draft'),
  },
  payload,
  recipients: [reader.public],
});

const folderMetadata = sealMetadata({
  author,
  target: {
    installationId,
    spaceId: target.spaceId,
    subjectKind: 'folder',
    subjectId: 'vector-folder',
    metadataRevisionId: MetadataRevisionId.parse('vector-metadata'),
    basedOn: null,
  },
  metadata: { ...newFolderMetadata('Recipes 🍲'), extensions: { 'future.ns': { kept: true } } },
  recipients: [reader.public],
});

const passphrase = 'vector passphrase';
const vault = createVault({
  accountId: AccountId.parse('vector-account'),
  identity: reader,
  passphrase,
  kdf: { opsLimit: sodium.crypto_pwhash_OPSLIMIT_MIN, memLimit: sodium.crypto_pwhash_MEMLIMIT_MIN },
});

const vectors = {
  author: exportIdentity(author),
  reader: exportIdentity(reader),
  revision,
  envelope: envelopes[0],
  payload,
  attachment: {
    target,
    ref: attachment.ref,
    blob: toBase64(attachment.blob),
    plaintext: 'attachment plaintext',
  },
  enrollment: enrollAgent({
    installationId,
    owner: author,
    agent: agent.public,
    comparedFingerprint: enrollmentFingerprint({
      installationId,
      owner: author.public,
      agent: agent.public,
    }),
  }),
  agentFingerprint: fingerprint(agent.public),
  vault: { wrapper: vault.wrapper, passphrase, recoveryKey: vault.recoveryKey },
  metadata: { sealed: folderMetadata.metadata, envelope: folderMetadata.envelopes[0] },
  m2: m2Vectors(previous?.m2),
};

function isSection(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// With section names, copy just those into the current file.
const only = process.argv.slice(2);
let written: unknown = vectors;
if (only.length > 0 && previousFile !== undefined) {
  written = previousFile;
  for (const path of only) {
    const keys = path.split('.');
    const last = keys.pop();
    let from: unknown = vectors;
    let to: unknown = written;
    for (const key of keys) {
      from = isSection(from) ? from[key] : undefined;
      to = isSection(to) ? to[key] : undefined;
    }
    if (last === undefined || !isSection(from) || !isSection(to)) {
      throw new Error(`No section ${path}`);
    }
    const value = from[last];
    if (value === undefined) delete to[last];
    else to[last] = value;
  }
}
writeFileSync(FILE, `${JSON.stringify(written, null, 2)}\n`);
