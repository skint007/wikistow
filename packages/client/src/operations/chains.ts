// Fetching and checking a person's chain of rotation statements (protocol
// section 4.6), for following them and for their earlier keys.
import { identityRoutes } from '@wikistow/contracts';
import type { ApiClient } from '../api/client.ts';
import { CryptoError } from '../errors.ts';
import { sameKeys, type PublicIdentity } from '../identity.ts';
import {
  parseIdentityRotation,
  verifyRotationChain,
  type RotationChain,
} from '../identity-rotation.ts';
import type { InstallationId } from '../ids.ts';

/**
 * The chain from `from` to the person's current key, as the server serves
 * it, checked (`verifyRotationChain`); `null` while `from` is still current.
 * A chain that doesn't check out, or a current key the server doesn't name,
 * throws `identity-key-changed` or the statement's own code: a key change.
 * With `end`, the chain stops there, a key along it, as when the pin is
 * not the server's current key.
 */
export async function chainFrom(
  api: ApiClient,
  installationId: InstallationId,
  from: PublicIdentity,
  end?: PublicIdentity,
): Promise<RotationChain | null> {
  const { current, rotations } = await api.call(identityRoutes.rotations, {
    params: { identityId: from.id },
    query: { from: from.keyVersion },
  });
  if (!current) throw new CryptoError('identity-key-changed', `${from.id} has no current key`);
  const last = end ?? current;
  if (sameKeys(last, from)) return null;
  const statements = rotations
    .map(parseIdentityRotation)
    .filter((statement) => statement.from.keyVersion < last.keyVersion);
  return verifyRotationChain({ installationId, start: from, end: last, statements });
}
