import { describe, expect, it } from 'vite-plus/test';
import {
  FolderKeyring,
  generateIdentity,
  highestWritable,
  IdentityId,
  keyHash,
  markOpened,
  MemoryKeyVersionMarks,
  newFolderKeys,
  ownersFromContacts,
  ShareId,
  SpaceId,
  writeKeyVersion,
  type KeyVersionMarks,
  type PublicIdentity,
} from '../src/index.ts';

const code = (expected: string) => expect.objectContaining({ code: expected });
const spaceId = SpaceId.parse('space');
const shareId = ShareId.parse('share');
const alice = generateIdentity({ id: IdentityId.parse('alice'), kind: 'human' }).public;
const bob = generateIdentity({ id: IdentityId.parse('bob'), kind: 'human' }).public;
const ref = (p: PublicIdentity) => ({ id: p.id, keyHash: keyHash(p) });

// Holding versions as if each envelope were opened: what matters here is
// each version's number and sealer.
const holding = (versions: [number, PublicIdentity][]) => {
  const keyring = new FolderKeyring();
  for (const [keyVersion, sealer] of versions) {
    keyring.add({ spaceId, shareId, keyVersion, sealer, ...newFolderKeys() });
  }
  return keyring;
};
// Alice's app, which removed bob as an owner of the space.
const removerWrites = ownersFromContacts({
  spaceId,
  owners: [ref(alice), ref(bob)],
  removedOwners: [bob.id],
}).writes;
const choose = (
  keyring: FolderKeyring,
  currentKeyVersion: number,
  marks: KeyVersionMarks = new MemoryKeyVersionMarks(),
  writes = removerWrites,
) => writeKeyVersion({ keyring, marks, spaceId, shareId, writes, currentKeyVersion }).keyVersion;

describe('choosing the key version to write under (section 6.8)', () => {
  it('take the highest version an accepted owner sealed', () => {
    const everyone = ownersFromContacts({
      spaceId,
      owners: [ref(alice), ref(bob)],
      removedOwners: [],
    });
    expect(
      choose(
        holding([
          [1, alice],
          [3, bob],
          [2, alice],
        ]),
        3,
        undefined,
        everyone.writes,
      ),
    ).toBe(3);
  });

  it('never count a version a removed owner sealed, in the remover’s app', () => {
    const keyring = holding([
      [1, alice],
      [2, bob],
    ]);
    expect(choose(keyring, 2)).toBe(1);
    expect(highestWritable({ keyring, spaceId, shareId, writes: removerWrites })?.keyVersion).toBe(
      1,
    );
    // Version 2 still opens: only writing leaves it out.
    expect(keyring.keysFor(spaceId, shareId, 2, 'published')).toHaveLength(1);
    // Nor a version sealed by someone the app never accepted.
    const stranger = generateIdentity({ id: IdentityId.parse('stranger'), kind: 'human' }).public;
    expect(() => choose(holding([[1, stranger]]), 1)).toThrow(code('missing-key'));
  });
});

describe('No going back (section 6.8)', () => {
  it('refuse a server version below the highest one opened', () => {
    const marks = new MemoryKeyVersionMarks();
    const keyring = holding([
      [1, alice],
      [2, alice],
      [3, alice],
    ]);
    markOpened({ keyring, marks, spaceId, shareId, writes: removerWrites });
    expect(marks.get(spaceId, shareId)).toBe(3);
    expect(() => choose(keyring, 2, marks)).toThrow(code('key-version'));
    expect(choose(keyring, 3, marks)).toBe(3);
  });
});
