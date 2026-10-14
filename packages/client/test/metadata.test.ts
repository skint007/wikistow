import { describe, expect, it } from 'vite-plus/test';
import {
  FolderId,
  generateIdentity,
  IdentityId,
  InstallationId,
  MetadataRevisionId,
  newFolderMetadata,
  newId,
  parseMetadata,
  reviseMetadata,
  sealMetadata,
  SpaceId,
  type MetadataTarget,
} from '../src/index.ts';

const installationId = newId(InstallationId);
const owner = generateIdentity({ kind: 'human', id: newId(IdentityId) });

const target: MetadataTarget = {
  installationId,
  spaceId: newId(SpaceId),
  subjectKind: 'folder',
  subjectId: newId(FolderId),
  metadataRevisionId: newId(MetadataRevisionId),
  basedOn: null,
};

const code = (c: string) => expect.objectContaining({ code: c });

describe('folder metadata', () => {
  it('keeps unknown fields through a rename and refuses newer major formats', () => {
    const fromNewerClient = {
      ...newFolderMetadata('Old'),
      format: { major: 1, minor: 2 },
      cover: 'x',
      extensions: { 'future.ns': [1] },
    };
    const renamed = reviseMetadata(parseMetadata(fromNewerClient), { name: 'New' });
    expect(renamed).toMatchObject({
      name: 'New',
      cover: 'x',
      format: { major: 1, minor: 2 },
      extensions: { 'future.ns': [1] },
    });
    const newer = parseMetadata({ format: { major: 2, minor: 0 } });
    expect(() => reviseMetadata(newer, { name: 'x' })).toThrow(code('unsupported-format'));
  });

  it('refuses to seal metadata that could never be opened again', () => {
    for (const metadata of [
      newFolderMetadata(''),
      newFolderMetadata('x'.repeat(201)),
      { ...newFolderMetadata('ok'), emoji: 'e'.repeat(33) },
    ]) {
      expect(() =>
        sealMetadata({ author: owner, target, metadata, recipients: [owner.public] }),
      ).toThrow(code('malformed'));
    }
  });
});
