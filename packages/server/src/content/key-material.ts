import type { KeyWrap, PublicIdentity } from '@wikistow/contracts';
import type { Database } from '../db/client.ts';
import { currentOwners, type ShareRow } from './access.ts';
import { ContentError } from './errors.ts';
import { checkEnvelopes, type Envelope } from './verify.ts';

/**
 * Check the key material a write carries for its region (protocol section
 * 6.8), as far as the server can see it. In a share: exactly one key wrap,
 * for that share, under its current key version (`key-version` otherwise,
 * naming the current one), and no envelopes. The caller holds the share's
 * row, so no rotation lands before the write is stored. In the owner
 * region: no wrap, and v2 envelopes to exactly the space's current owners
 * at their current keys, each naming this version and signed by the author.
 */
export async function checkKeyMaterial<E extends Envelope>(
  tx: Database,
  {
    spaceId,
    share,
    wrap,
    envelopes,
    author,
    namesVersion,
    signedBytes,
  }: {
    spaceId: string;
    share: ShareRow | null;
    wrap: KeyWrap | null;
    envelopes: readonly E[];
    author: PublicIdentity;
    namesVersion: (envelope: E) => boolean;
    signedBytes: (envelope: E) => Uint8Array;
  },
): Promise<void> {
  if (share) {
    if (!wrap || envelopes.length > 0) {
      throw new ContentError('region-mismatch', 'Content in a share carries one key wrap');
    }
    if (wrap.shareId !== share.id) {
      throw new ContentError('region-mismatch', 'The key wrap is for another share');
    }
    if (wrap.keyVersion !== share.currentKeyVersion) {
      throw new ContentError('key-version', 'The share has another key version', {
        keyVersion: share.currentKeyVersion,
      });
    }
    return;
  }
  if (wrap) {
    throw new ContentError('region-mismatch', 'Content outside shares is sealed to its owners');
  }
  checkEnvelopes({
    envelopes,
    namesVersion,
    author,
    recipients: await currentOwners(tx, spaceId),
    signedBytes,
  });
}
