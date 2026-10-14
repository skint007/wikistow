export type CryptoErrorCode =
  /** AEAD or sealed-box open failed: wrong key, altered ciphertext, or altered binding. */
  | 'decrypt-failed'
  | 'bad-signature'
  | 'hash-mismatch'
  /** A signer, granter, or recipient is not pinned in the trust store. */
  | 'unknown-identity'
  /** The directory returned a key that differs from the pinned one. Stop sharing. */
  | 'identity-key-changed'
  /** A compared fingerprint doesn't match the keys being trusted. */
  | 'fingerprint-mismatch'
  /** A public key is a non-canonical or low-order X25519 key, or an invalid Ed25519 point. */
  | 'bad-key'
  /** The record is authentic but not the one the caller asked for. */
  | 'binding-mismatch'
  | 'wrong-recipient'
  /** An unsealed content key doesn't match the commitment its record signs. */
  | 'key-commitment'
  /**
   * Key material, or a v1 record, from someone this app doesn't accept for
   * it: not an accepted owner of the space, or for an agent not its person.
   * Possibly an attack.
   */
  | 'untrusted-sealer'
  /** The agent's person revoked it: its record lists the agent in `revokedAgents`. */
  | 'agent-revoked'
  /** This client holds no folder key for the key version and class a wrap names. */
  | 'missing-key'
  /**
   * The server lists an owner this app hasn't accepted, or has removed, or at
   * a key it didn't accept: the app won't seal to them or act as an owner.
   */
  | 'unaccepted-owner'
  /**
   * A record's region, from the key material this app opened it through,
   * isn't where the server's tree puts it, or the server served a record
   * with both a wrap and envelopes. Possibly an attack.
   */
  | 'region-mismatch'
  /**
   * A key version below the highest this app has opened that counts for
   * writing (No going back), or one that doesn't count for writing at all.
   * The server may be hiding a newer version: possibly an attack.
   */
  | 'key-version'
  /** The server served an older version of the contacts record than this client has seen. */
  | 'contacts-rollback'
  /** The server served a contacts record that doesn't chain to the one this client has seen. */
  | 'contacts-fork'
  /** A pending contacts change disagrees with a newer record; the person decides. */
  | 'contacts-conflict'
  /** A confirmed contacts write isn't in the record the server serves back. */
  | 'contacts-unconfirmed'
  /** A newer format, record protocol or envelope version than this client knows. Update to go on. */
  | 'unsupported-format'
  | 'kdf-failed'
  | 'malformed';

/** Every failure from the encryption module. Callers branch on `code`. */
export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CryptoError';
    this.code = code;
  }
}
