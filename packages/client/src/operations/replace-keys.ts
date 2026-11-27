// Replacing the person's identity keys (protocol section 4.6, #327): what
// the rotation dialog lists, the request it sends, and sending it. The
// statement, the new vault and the first contacts version at the new key go
// in one request, so the server takes all of it or none.
import {
  identityRoutes,
  systemRoutes,
  vaultRoutes,
  type AgentEnrollment,
  type IdentityId,
  type PublicIdentity,
} from '@wikistow/contracts';
import type { z } from 'zod';
import { ApiError, type ApiClient } from '../api/client.ts';
import { APP_AGENTS_NAMESPACE, appAgentSecrets } from '../app-agents.ts';
import { contactsHash, sealContacts, type ContactsPayloads } from '../contacts.ts';
import { CryptoError } from '../errors.ts';
import {
  enrollmentFingerprint,
  generateIdentity,
  keyHash,
  sameKeys,
  type PrivateIdentity,
} from '../identity.ts';
import {
  parseIdentityRotation,
  signIdentityRotation,
  verifyRotationChain,
} from '../identity-rotation.ts';
import type { KeptAnchor } from '../kept-unlock.ts';
import { enrollAgent } from '../trust.ts';
import type { KdfParams, UnlockedVault } from '../vault.ts';
import { listAgents } from './agents.ts';
import { readContacts } from './contacts.ts';
import { saveContacts, type ClientContext } from './session.ts';
import type { VaultCrypto } from './vault.ts';

/** One live agent the person may keep, as the dialog lists it. */
export type KeepableAgent = {
  agentId: IdentityId;
  /** Its label in the person's own contacts record. */
  name: string;
  /** When the person enrolled it, by their record. */
  enrolledAt: string;
};

/**
 * The agents a rotation can keep: those the server lists live that the
 * person's own record lists too, not revoked, other than the agents the app
 * runs itself (section 9.8), whose secret keys were sealed to the old key.
 * Every other live agent is revoked. None is kept until the person ticks it.
 */
export async function keepableAgents(
  ctx: ClientContext,
  payloads: ContactsPayloads = ctx.contacts.book.payloads,
): Promise<KeepableAgent[]> {
  const live = new Set(
    (await listAgents(ctx)).filter((a) => a.revokedAt === null).map((a) => a.agentId),
  );
  const { shared, private: own } = payloads;
  const revoked = new Set(shared.revokedAgents.map((entry) => entry.agentId));
  const appRun = new Set(appAgentSecrets(own).map((secret) => secret.agentId));
  return shared.agents.flatMap(({ enrollment, label }) => {
    const id = enrollment.agent.id;
    if (!live.has(id) || revoked.has(id) || appRun.has(id)) return [];
    return [{ agentId: id, name: label.name, enrolledAt: label.enrolledAt }];
  });
}

/** What `rotate` sends. */
export type RotateRequest = z.infer<typeof identityRoutes.rotate.body>;

/**
 * A rotation made on this device and not yet sent. Show `recoveryKey` and
 * have the person confirm they saved it, then `sendRotation`. Keep it until
 * the server answers: sending the same one again is safe, and a new one
 * would come with keys and a recovery key nobody saw.
 */
export type PreparedRotation = {
  request: RotateRequest;
  /** The new vault, unlocked, at the new key, with the earlier keys retired. */
  vault: UnlockedVault;
  recoveryKey: string;
};

/**
 * Make everything a rotation sends (section 4.6): new keys at the next key
 * version, under the same ID; the statement both keys sign, naming the
 * contacts version this device holds, after writing what it has waiting;
 * a new vault under `passphrase`, with a new vault key and recovery key,
 * that keeps every earlier key; the enrollments of the agents in `keep`
 * signed again with the new key, every other live agent revoked; and the
 * first contacts version at the new key, which lists only the kept agents,
 * adds every other agent of the version it extends to `revokedAgents`, and
 * drops the app's own agents' secrets. Nothing is sent.
 */
export async function prepareRotation(
  ctx: ClientContext,
  {
    vault,
    crypto,
    passphrase,
    kdf,
    keep,
    shown,
    now = () => new Date(),
  }: {
    vault: UnlockedVault;
    crypto: VaultCrypto;
    passphrase: string;
    kdf?: KdfParams;
    keep: readonly string[];
    /**
     * What the dialog showed: every live agent, and those of them it
     * offered to keep. An agent enrolled since, which the rotation would
     * revoke unseen, or one it could keep that wasn't offered, makes it
     * refuse (`stale-head`).
     */
    shown?: { live: readonly string[]; keepable: readonly string[] };
    now?: () => Date;
  },
): Promise<PreparedRotation> {
  if (ctx.agent) throw new CryptoError('malformed', 'Only a person replaces their keys');
  if (vault.identity.public.id !== ctx.identity.public.id) {
    throw new CryptoError('binding-mismatch', 'The vault is another person’s');
  }
  // The statement names the version this writes, so nothing waits after
  // it, read again from the server, so a version another device wrote since
  // is the one named.
  await saveContacts(ctx);
  const book = await readContacts(
    { api: ctx.api, installationId: ctx.installationId, identity: ctx.identity },
    ctx.contacts.book.mark,
  );
  const keepable = new Set<string>(
    (await keepableAgents(ctx, book.payloads)).map((agent) => agent.agentId),
  );
  const kept = new Set(keep);
  if (![...kept].every((id) => keepable.has(id))) {
    throw new CryptoError('malformed', 'Only a live agent this person enrolled can be kept');
  }
  const live = (await listAgents(ctx)).filter((a) => a.revokedAt === null).map((a) => a.agentId);
  if (
    shown &&
    (live.some((id) => !shown.live.includes(id)) ||
      [...keepable].some((id) => !shown.keepable.includes(id)))
  ) {
    throw new ApiError(409, 'stale-head', 'The agents changed since the list was shown');
  }
  const { version: expectedVaultVersion } = await ctx.api.call(vaultRoutes.getVault);

  const from = ctx.identity;
  const next = generateIdentity({
    kind: 'human',
    id: from.public.id,
    keyVersion: from.public.keyVersion + 1,
  });
  const head = book.record;
  const rotation = signIdentityRotation({
    installationId: ctx.installationId,
    from,
    to: next,
    contacts: head && { version: head.version, contactsHash: contactsHash(head) },
  });
  const made = await crypto.rotate({
    accountId: vault.accountId,
    identity: next,
    retired: [...vault.retired, vault.identity],
    passphrase,
    ...(kdf ? { kdf } : {}),
  });

  const { payloads } = book;
  const enrollments = payloads.shared.agents
    .filter(({ enrollment }) => kept.has(enrollment.agent.id))
    .map(({ enrollment }) => enrollAgain(ctx, next, enrollment));
  const contacts = sealContacts({
    owner: next,
    installationId: ctx.installationId,
    previous: head,
    ...afterRotation(payloads, {
      enrollments,
      revokedAt: now().toISOString(),
      earlier: [...vault.retired, vault.identity].map((key) => key.public),
      next: next.public,
    }),
  });
  return {
    request: {
      rotation,
      identity: next.public,
      wrapper: made.wrapper,
      expectedVaultVersion,
      contacts,
      enrollments,
      keptAgents: live.filter((id) => kept.has(id)),
      revokedAgents: live.filter((id) => !kept.has(id)),
    },
    vault: made.vault,
    recoveryKey: made.recoveryKey,
  };
}

// The same agent, at its person's new key, with no fingerprint to compare:
// it is already theirs (section 4.6, **Agents**).
function enrollAgain(
  ctx: ClientContext,
  owner: PrivateIdentity,
  { agent }: AgentEnrollment,
): AgentEnrollment {
  const { installationId } = ctx;
  return enrollAgent({
    installationId,
    owner,
    agent,
    comparedFingerprint: enrollmentFingerprint({ installationId, owner: owner.public, agent }),
  });
}

/**
 * The payloads of the first version at the new key: `agents` holds exactly
 * the kept agents, with their new enrollments, so the contacts key goes to
 * them alone; every other agent the version lists is added to
 * `revokedAgents`; and the secrets of the agents the app ran go, as they
 * are revoked too. Beside each `owners` entry for the person's own ID at an
 * earlier key, which stays for opening, it adds one at the new key, and
 * leaves `removedOwners` as it is (section 4.6, **The person's own app**).
 */
function afterRotation(
  { shared, private: ownPrivate }: ContactsPayloads,
  {
    enrollments,
    revokedAt,
    earlier,
    next,
  }: {
    enrollments: readonly AgentEnrollment[];
    revokedAt: string;
    earlier: readonly PublicIdentity[];
    next: PublicIdentity;
  },
): ContactsPayloads {
  const renewed = new Map(enrollments.map((e) => [e.agent.id, e]));
  const revoked = new Set(shared.revokedAgents.map((entry) => entry.agentId));
  const agents = shared.agents.flatMap((agent) => {
    const enrollment = renewed.get(agent.enrollment.agent.id);
    return enrollment ? [{ ...agent, enrollment }] : [];
  });
  const dropped = shared.agents
    .map((agent) => agent.enrollment.agent.id)
    .filter((id) => !renewed.has(id) && !revoked.has(id))
    .map((agentId) => ({ agentId, revokedAt }));
  const earlierHashes = new Set(earlier.map((key) => keyHash(key)));
  const nextHash = keyHash(next);
  const own = (owner: { id: string; keyHash: string }) => owner.id === next.id;
  const spaceOwners = shared.spaceOwners.map((entry) =>
    entry.owners.some((owner) => own(owner) && earlierHashes.has(owner.keyHash)) &&
    !entry.owners.some((owner) => own(owner) && owner.keyHash === nextHash)
      ? { ...entry, owners: [...entry.owners, { id: next.id, keyHash: nextHash }] }
      : entry,
  );
  const { [APP_AGENTS_NAMESPACE]: _appAgents, ...extensions } = ownPrivate.extensions;
  return {
    shared: {
      ...shared,
      agents,
      revokedAgents: [...shared.revokedAgents, ...dropped],
      spaceOwners,
    },
    private: { ...ownPrivate, extensions },
  };
}

/**
 * Send a prepared rotation. On success the keys are replaced: the caller
 * ends this session, which holds the old key, and opens one with
 * `prepared.vault`. A lost answer is sent again as it is (`rotation-exists`
 * only if another statement for this key version landed first).
 */
export function sendRotation(api: ApiClient, prepared: PreparedRotation) {
  return api.call(identityRoutes.rotate, { body: prepared.request });
}

/**
 * What the directory says of the key this device last unlocked with, its
 * anchor (section 4.6, **When someone else rotated**): still current; or
 * `replaced`, by a valid chain of statements from it to `current`, which
 * only the person or someone holding their old key could sign; or
 * `substituted`, a key the anchor has no valid chain to, reported as a
 * possible attack. Public routes only, so it runs while locked.
 */
export type KeysCheck =
  | { kind: 'same' }
  | { kind: 'replaced'; current: PublicIdentity }
  | { kind: 'substituted' };

export async function checkKeys(api: ApiClient, anchor: PublicIdentity): Promise<KeysCheck> {
  const { installationId } = await api.call(systemRoutes.installation);
  const { current, rotations } = await api.call(identityRoutes.rotations, {
    params: { identityId: anchor.id },
    query: { from: anchor.keyVersion },
  });
  if (current && sameKeys(current, anchor)) return { kind: 'same' };
  if (!current || current.keyVersion <= anchor.keyVersion) return { kind: 'substituted' };
  try {
    verifyRotationChain({
      installationId,
      start: anchor,
      end: current,
      statements: rotations.map(parseIdentityRotation),
    });
    return { kind: 'replaced', current };
  } catch {
    return { kind: 'substituted' };
  }
}

/**
 * Whether this device may open a vault that unlocked to `vault`, judged
 * against what it kept: `ok` at its anchor, or at a later key whose keyring
 * holds the anchor among its retired keys; `replaced-elsewhere` while a
 * successor is recorded and the keyring is older than it, so the device
 * signs and seals nothing with the old keys; and `rollback` for any other
 * keyring: older than the anchor or not holding it, or past the successor
 * without holding it. With nothing kept, the
 * device takes the server's word (A15).
 */
export function judgeUnlock(
  kept: KeptAnchor | null,
  vault: Pick<UnlockedVault, 'identity' | 'retired'>,
): 'ok' | 'replaced-elsewhere' | 'rollback' {
  const at = vault.identity.public;
  // Another person's anchor, as one written for another account in this
  // browser, says nothing of these keys.
  if (!kept || kept.anchor.id !== at.id) return 'ok';
  const { anchor, successor } = kept;
  const fromAnchor =
    sameKeys(at, anchor) ||
    (at.keyVersion > anchor.keyVersion &&
      vault.retired.some((key) => sameKeys(key.public, anchor)));
  if (!fromAnchor) return 'rollback';
  if (successor && !sameKeys(at, successor)) {
    if (at.keyVersion < successor.keyVersion) return 'replaced-elsewhere';
    // Past the successor only through it: a keyring holding it retired.
    const through = vault.retired.some((key) => sameKeys(key.public, successor));
    if (at.keyVersion === successor.keyVersion || !through) return 'rollback';
  }
  return 'ok';
}

/**
 * Whether the server holds `prepared`'s own statement, exactly: after an
 * unclear answer, or a refusal of a resend, which may follow a first send
 * that landed. Its signatures are deterministic, so a match is this one.
 */
export async function rotationLanded(api: ApiClient, prepared: PreparedRotation): Promise<boolean> {
  const { rotation } = prepared.request;
  const { rotations } = await api.call(identityRoutes.rotations, {
    params: { identityId: rotation.id },
    query: { from: rotation.from.keyVersion },
  });
  return rotations.some(
    (stored) =>
      stored['fromSignature'] === rotation.fromSignature &&
      stored['toSignature'] === rotation.toSignature,
  );
}
