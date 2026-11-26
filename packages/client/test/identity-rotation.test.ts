import { describe, expect, it } from 'vite-plus/test';
import {
  generateIdentity,
  IdentityId,
  identityRotationBytes,
  InstallationId,
  keyHash,
  parseIdentityRotation,
  RotationChain,
  sign,
  signIdentityRotation,
  toBase64,
  verifyIdentityRotation,
  verifyRotationChain,
  type IdentityRotation,
  type PrivateIdentity,
} from '../src/index.ts';

const installationId = InstallationId.parse('rotation-installation');
const id = IdentityId.parse('rotating-person');
const keyAt = (keyVersion: number) => generateIdentity({ kind: 'human', id, keyVersion });
const [k1, k2, k3] = [keyAt(1), keyAt(2), keyAt(3)] as [
  PrivateIdentity,
  PrivateIdentity,
  PrivateIdentity,
];
const contacts = { version: 4, contactsHash: keyHash(k1.public) };
const rotate = (
  from: PrivateIdentity,
  to: PrivateIdentity,
  named: { version: number; contactsHash: string } | null = contacts,
) => signIdentityRotation({ installationId, from, to, contacts: named });
const s12 = rotate(k1, k2, null);
const s23 = rotate(k2, k3);
const code = (code: string) => expect.objectContaining({ code });

// A statement changed and signed again by both keys, so only the change is wrong.
const resigned = (
  statement: IdentityRotation,
  from: PrivateIdentity,
  to: PrivateIdentity,
  change: Partial<IdentityRotation>,
): IdentityRotation => {
  const changed = { ...statement, ...change };
  const bytes = identityRotationBytes(changed);
  return { ...changed, fromSignature: sign(from, bytes), toSignature: sign(to, bytes) };
};

describe('a rotation statement', () => {
  it('is signed by both keys and moves to the keys it names', () => {
    const to = verifyIdentityRotation({ installationId, from: k2.public, statement: s23 });
    expect(to).toEqual(k3.public);
    expect(s23.from).toEqual({ keyVersion: 2, keyHash: keyHash(k2.public) });
    expect(s23.contacts).toEqual(contacts);
    expect(s12.contacts).toBeNull();
  });

  it('parses strictly, and a later format asks to update', () => {
    expect(parseIdentityRotation(JSON.parse(JSON.stringify(s23)))).toEqual(s23);
    expect(() => parseIdentityRotation({ ...s23, version: 2 })).toThrow(code('unsupported-format'));
    for (const raw of [
      { ...s23, reason: 'leak' },
      { ...s23, from: { ...s23.from, at: 1 } },
      { ...s23, to: { ...s23.to, keyVersion: 4 } },
      { ...s23, contacts: null },
      { ...s23, contacts: { ...contacts, version: 0 } },
      { ...s23, id: `agent-${'A'.repeat(43)}` },
      { ...s23, fromSignature: `${s23.fromSignature}A` },
      { ...s23, toSignature: s23.toSignature.slice(0, -1) },
    ]) {
      expect(() => parseIdentityRotation(raw)).toThrow(code('malformed'));
    }
    const lowOrder = toBase64(new Uint8Array(32));
    expect(() =>
      parseIdentityRotation({ ...s23, to: { ...s23.to, boxPublicKey: lowOrder } }),
    ).toThrow(code('bad-key'));
  });

  it('binds the installation and the exact key it replaces', () => {
    const other = InstallationId.parse('another-installation');
    expect(() =>
      verifyIdentityRotation({ installationId: other, from: k2.public, statement: s23 }),
    ).toThrow(code('binding-mismatch'));
    expect(() =>
      verifyIdentityRotation({ installationId, from: keyAt(2).public, statement: s23 }),
    ).toThrow(code('binding-mismatch'));
    expect(() =>
      verifyIdentityRotation({ installationId, from: k1.public, statement: s23 }),
    ).toThrow(code('binding-mismatch'));
  });

  it('needs both signatures, and new keys of both kinds', () => {
    for (const statement of [
      { ...s23, fromSignature: s23.toSignature },
      { ...s23, toSignature: s23.fromSignature },
      { ...s23, contacts: { ...contacts, version: 5 } },
      resigned(s23, k2, k3, { to: { ...s23.to, boxPublicKey: k2.public.boxPublicKey } }),
      resigned(s23, k2, k2, { to: { ...s23.to, signPublicKey: k2.public.signPublicKey } }),
    ]) {
      expect(() => verifyIdentityRotation({ installationId, from: k2.public, statement })).toThrow(
        code('bad-signature'),
      );
    }
  });

  it('is never signed to another person or kind', () => {
    const someoneElse = generateIdentity({
      kind: 'human',
      id: IdentityId.parse('someone-else'),
      keyVersion: 2,
    });
    expect(() => rotate(k1, someoneElse)).toThrow(code('malformed'));
    expect(() => rotate(k1, k3)).toThrow(code('malformed'));
  });

  it('signs null contacts as two null fields', () => {
    // The last two fields: tag 0, length 0, each.
    expect([...identityRotationBytes(s12).subarray(-10)]).toEqual(new Array(10).fill(0));
  });
});

describe('a chain of rotations', () => {
  const chain = (statements: readonly unknown[], start = k1.public, end = k3.public) =>
    verifyRotationChain({ installationId, start, end, statements });

  it('leads from an earlier key to the current one', () => {
    const verified = chain([s12, s23]);
    expect(verified).toBeInstanceOf(RotationChain);
    expect(verified.keys).toEqual([k1.public, k2.public, k3.public]);
    expect(verified.last).toEqual(k3.public);
    expect(chain([s23], k2.public).keys).toEqual([k2.public, k3.public]);
    expect(chain([], k3.public).keys).toEqual([k3.public]);
    // The same statement twice is one statement.
    expect(chain([s12, { ...s12 }, s23]).keys).toHaveLength(3);
  });

  it('is a key change when it doesn’t check out', () => {
    const other23 = rotate(k2, keyAt(3));
    const cases: Record<string, readonly unknown[]> = {
      'a gap': [s23],
      'a missing end': [s12],
      'two statements for one version': [s12, s23, other23],
      'out of order': [s23, s12],
      'past the current key': [s12, s23, rotate(k3, keyAt(4))],
    };
    for (const [why, statements] of Object.entries(cases)) {
      expect(() => chain(statements), why).toThrow(code('identity-key-changed'));
    }
    // Ends at another key than the directory's current one.
    expect(() => chain([s12, other23])).toThrow(code('identity-key-changed'));
    expect(() => chain([s12, s23], k1.public, keyAt(3).public)).toThrow(
      code('identity-key-changed'),
    );
    // Starts at another key.
    expect(() => chain([s12, s23], keyAt(1).public)).toThrow(code('identity-key-changed'));
    // Goes down.
    expect(() => chain([], k3.public, k1.public)).toThrow(code('identity-key-changed'));
  });

  it('never comes back to a key it left', () => {
    // Version 3 holds version 1's keys again.
    const back: PrivateIdentity = { ...k1, public: { ...k1.public, keyVersion: 3 } };
    const s2back = rotate(k2, back);
    expect(() => chain([s12, s2back], k1.public, back.public)).toThrow(
      code('identity-key-changed'),
    );
  });

  it('keeps a statement’s own failure', () => {
    expect(() => chain([s12, { ...s23, toSignature: s23.fromSignature }])).toThrow(
      code('bad-signature'),
    );
    expect(() => chain([s12, { ...s23, version: 2 }])).toThrow(code('unsupported-format'));
    expect(() => chain([s12, { ...s23, extra: true }])).toThrow(code('malformed'));
    const elsewhere = signIdentityRotation({
      installationId: InstallationId.parse('elsewhere'),
      from: k2,
      to: k3,
      contacts,
    });
    expect(() => chain([s12, elsewhere])).toThrow(code('binding-mismatch'));
  });

  it('is made only by checking', () => {
    expect(() => new RotationChain(Symbol('RotationChain') as never, [k1.public], [])).toThrow(
      code('malformed'),
    );
  });
});
