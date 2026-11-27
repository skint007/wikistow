// Replacing the person's identity keys (protocol section 4.6, #327): what
// the rotation dialog lists, the request it sends, and sending it. The
// statement, the new vault and the first contacts version at the new key go
// in one request, so the server takes all of it or none.
import {
  identityRoutes,
  vaultRoutes,
  type AgentEnrollment,
  type IdentityId,
} from '@wikistow/contracts';
import type { z } from 'zod';
import type { ApiClient } from '../api/client.ts';
import { APP_AGENTS_NAMESPACE, appAgentSecrets } from '../app-agents.ts';
import { contactsHash, sealContacts, type ContactsPayloads } from '../contacts.ts';
import { CryptoError } from '../errors.ts';
import { enrollmentFingerprint, generateIdentity, type PrivateIdentity } from '../identity.ts';
import { signIdentityRotation } from '../identity-rotation.ts';
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
    now = () => new Date(),
  }: {
    vault: UnlockedVault;
    crypto: VaultCrypto;
    passphrase: string;
    kdf?: KdfParams;
    keep: readonly string[];
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
    ...afterRotation(payloads, enrollments, now().toISOString()),
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
 * are revoked too.
 */
function afterRotation(
  { shared, private: own }: ContactsPayloads,
  enrollments: readonly AgentEnrollment[],
  revokedAt: string,
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
  const { [APP_AGENTS_NAMESPACE]: _appAgents, ...extensions } = own.extensions;
  return {
    shared: { ...shared, agents, revokedAgents: [...shared.revokedAgents, ...dropped] },
    private: { ...own, extensions },
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
