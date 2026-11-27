import type { KeyWrap, PublicIdentity } from '@wikistow/contracts';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { agentProfiles, folderKeyEnvelopes, identities } from '../db/schema/index.ts';
import { currentOwners, isOwner, type ShareRow } from './access.ts';
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
    if (author.kind === 'agent') await requirePersonWrites(tx, author.id, share);
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

/**
 * An agent writes in a share only where its person's app does (protocol
 * section 4.6): not while every envelope of the current version its person
 * holds was sealed by a key its sealer has since replaced, as when an owner
 * replaced their keys and hasn't yet rotated the share. Its person's app
 * then counts that version for opening only; so does the server for the
 * agent, until an owner rotates it. A person with no envelope there, as an
 * owner whose app sealed none to itself, is left to the usual checks.
 */
async function requirePersonWrites(tx: Database, agentId: string, share: ShareRow) {
  const [agent] = await tx
    .select({ personId: agentProfiles.ownerIdentityId })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, agentId));
  if (!agent) return;
  const held = await tx
    .select({ envelope: folderKeyEnvelopes.envelope })
    .from(folderKeyEnvelopes)
    .where(
      and(
        eq(folderKeyEnvelopes.shareId, share.id),
        eq(folderKeyEnvelopes.keyVersion, share.currentKeyVersion),
        eq(folderKeyEnvelopes.recipientIdentityId, agent.personId),
      ),
    );
  if (held.length === 0) return;
  for (const { envelope } of held) {
    const { sealerId, sealerKeyVersion } = envelope as {
      sealerId: string;
      sealerKeyVersion: number;
    };
    const [current] = await tx
      .select({ keyVersion: identities.keyVersion })
      .from(identities)
      .where(and(eq(identities.id, sealerId), isNull(identities.revokedAt)))
      .orderBy(desc(identities.keyVersion))
      .limit(1);
    if (!current || current.keyVersion <= sealerKeyVersion) return;
  }
  throw new ContentError(
    'forbidden',
    'An owner of this folder replaced their keys: its keys change before anything more is saved',
  );
}

/**
 * A change in a share that carries no keys, as unpublishing, is a member's
 * only while they hold an envelope of the share's current version: one a
 * rotation keeps waiting (protocol section 4.6) holds nothing of it, and
 * waits as a reader would. For an agent, its person must. Owners hold
 * every key, and outside shares there is nothing to check.
 */
export async function requireHoldsCurrent(
  tx: Database,
  caller: { identity: { id: string }; personId: string | null },
  share: ShareRow | null,
) {
  if (!share) return;
  const person = caller.personId ?? caller.identity.id;
  if (await isOwner(tx, person, share.spaceId)) return;
  const [held] = await tx
    .select({ shareId: folderKeyEnvelopes.shareId })
    .from(folderKeyEnvelopes)
    .where(
      and(
        eq(folderKeyEnvelopes.shareId, share.id),
        eq(folderKeyEnvelopes.keyVersion, share.currentKeyVersion),
        eq(folderKeyEnvelopes.recipientIdentityId, person),
      ),
    )
    .limit(1);
  if (!held) throw new ContentError('forbidden', 'You wait for this folder’s new keys');
}
