// The kept vectors' part of the cross-platform vectors (ADR 0016, decision
// 4, see generate-vectors.ts): a file of vectors sealed on the device under
// `meaning-index-key/v1`, bound by `meaning-index/v1`, with the derived key,
// the associated data and the plaintext in the clear so another
// implementation can check each layer on its own. Vectors here have 8
// values, not the model's 384, to keep the file short.
import {
  canonical,
  generateIdentity,
  IdentityId,
  InstallationId,
  MEANING_PASSAGES_VERSION,
  meaningBytes,
  passageHash,
  quantizeVector,
  RevisionId,
  sealMeaningIndex,
  toBase64,
  type MeaningPassage,
  type PrivateIdentity,
} from '../src/index.ts';
import { sodium } from '../src/sodium.ts';

const exportIdentity = (identity: PrivateIdentity) => ({
  public: identity.public,
  boxSecretKey: toBase64(identity.boxSecretKey),
  signSecretKey: toBase64(identity.signSecretKey),
});

const hex = (bytes: Uint8Array) => sodium.to_hex(bytes);

/** The section's identity from the current file, kept so a regeneration moves only what changed. */
export type MeaningPrevious = { keeper: PrivateIdentity };

export function meaningVectors(previous?: MeaningPrevious) {
  const installationId = InstallationId.parse('vector-installation');
  const keeper =
    previous?.keeper ??
    generateIdentity({ id: IdentityId.parse('vector-meaning-keeper'), kind: 'human' });
  // The model's identity, as the build pins it: its file's SHA-256.
  const modelHash = hex(sodium.crypto_hash_sha256(new TextEncoder().encode('vector model')));
  const versions = [
    {
      revisionId: 'vector-meaning-soup',
      passages: [
        {
          text: 'Bean soup\nSoak the beans overnight.',
          start: 0,
          vector: [0.5, -0.25, 0.125, 0, -1, 0.75, 0.0625, -0.5],
        },
        {
          text: 'Bean soup\nMethod\nSimmer for an hour, then season. Ünïcødé ✓',
          start: 34,
          vector: [0, 0.1, -0.2, 0.3, -0.4, 0.5, -0.6, 0.7],
        },
      ],
    },
    { revisionId: 'vector-meaning-empty', passages: [] },
  ];
  const kept = new Map(
    versions.map(({ revisionId, passages }) => [
      RevisionId.parse(revisionId),
      passages.map(({ text, start, vector }): MeaningPassage => ({
        hash: passageHash(text),
        start,
        vector: quantizeVector(vector),
      })),
    ]),
  );
  const keyDomain = 'meaning-index-key/v1';
  const key = sodium.crypto_generichash(32, canonical(keyDomain, []), keeper.boxSecretKey);
  const ad = canonical('meaning-index/v1', [
    installationId,
    keeper.public.id,
    modelHash,
    MEANING_PASSAGES_VERSION,
  ]);
  const sealed = sealMeaningIndex({ identity: keeper, installationId }, kept, modelHash);
  return {
    keeper: exportIdentity(keeper),
    installationId,
    modelHash,
    passagesVersion: MEANING_PASSAGES_VERSION,
    keyDomain,
    key: hex(key),
    ad: hex(ad),
    versions: versions.map(({ revisionId, passages }) => ({
      revisionId,
      passages: passages.map(({ text, start, vector }) => {
        const { scale, values } = quantizeVector(vector);
        return { text, hash: passageHash(text), start, vector, scale, values: [...values] };
      }),
    })),
    plaintext: hex(meaningBytes(kept)),
    sealed: toBase64(sealed),
  };
}
