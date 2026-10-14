import type { FolderKeyEnvelope, ShareId, SpaceId } from '@wikistow/contracts';
import type { OwnAgent, SharedContacts } from './contacts.ts';
import { CryptoError } from './errors.ts';
import { sealFolderKeys, type FolderKeyring } from './folder-keys.ts';
import type { PrivateIdentity } from './identity.ts';
import type { InstallationId } from './ids.ts';
import type { WritesOwner } from './owner-predicates.ts';
import { verifyEnrollment } from './trust.ts';

/** Versions of one share the server says an agent lacks (`GET /api/me/agents/:agentId/missing`). */
export type MissingVersions = {
  spaceId: SpaceId;
  shareId: ShareId;
  keyVersions: readonly number[];
};

/**
 * Seal to one of the person's own agents the key versions it lacks (section
 * 9.4), at unlock or when the person grants it a share. Only shares on the
 * agent's `shares` list in the person's own contacts record, and only
 * versions this app holds that count for its own writing (`writes`, per
 * space), so never one above the highest that does. The class comes from
 * that list's `drafts`, never from the server: both keys only if `drafts` is
 * true and this app holds the draft key. A revoked agent, or one whose
 * enrollment doesn't verify under the person's key, gets nothing, so one
 * broken entry doesn't stop the others at unlock. Whatever the server lists
 * beyond that is ignored, so a person who loses access stops sealing new
 * versions too.
 */
export function sealForAgent({
  person,
  installationId,
  contacts,
  agent,
  missing,
  keyring,
  writes,
}: {
  person: PrivateIdentity;
  installationId: InstallationId;
  /** The person's own shared contacts payload. */
  contacts: Pick<SharedContacts, 'revokedAgents'>;
  /** The agent's entry in that payload. */
  agent: OwnAgent;
  missing: readonly MissingVersions[];
  keyring: FolderKeyring;
  /** The person's accepted owners for writing in a space. */
  writes: (spaceId: SpaceId) => WritesOwner;
}): FolderKeyEnvelope[] {
  const { enrollment } = agent;
  if (contacts.revokedAgents.some((revoked) => revoked.agentId === enrollment.agent.id)) return [];
  try {
    verifyEnrollment({ installationId, owner: person.public, enrollment });
  } catch (error) {
    if (error instanceof CryptoError) return [];
    throw error;
  }
  return missing.flatMap(({ spaceId, shareId, keyVersions }) => {
    const granted = agent.shares.find(
      (share) => share.spaceId === spaceId && share.shareId === shareId,
    );
    if (!granted) return [];
    const counts = writes(spaceId);
    const wanted = new Set(keyVersions);
    const sealed = new Set<number>();
    return keyring.versions(spaceId, shareId).flatMap((held) => {
      if (!wanted.has(held.keyVersion) || sealed.has(held.keyVersion) || !counts(held.sealer)) {
        return [];
      }
      sealed.add(held.keyVersion);
      return [
        sealFolderKeys({
          sealer: person,
          installationId,
          spaceId,
          shareId,
          keyVersion: held.keyVersion,
          recipient: enrollment.agent,
          keys: {
            draftKey: granted.drafts ? held.draftKey : null,
            publishedKey: held.publishedKey,
          },
        }),
      ];
    });
  });
}
