// Agents a person's own app runs, for the page chat: enrolled by the app
// playing both sides of protocol section 9.2, kept in the person's private
// contacts payload, and opened as an agent's session with the agent's own
// keys and token, never the person's.
import type { IdentityId } from '@wikistow/contracts';
import { createApiClient, type Fetch } from '../api/client.ts';
import { appAgentIdentity, appAgentSecrets } from '../app-agents.ts';
import { toBase64 } from '../encoding.ts';
import { CryptoError } from '../errors.ts';
import { sameKeys } from '../identity.ts';
import { MemoryKeyVersionMarks } from '../key-versions.ts';
import {
  agentIdentity,
  confirmEnrollment,
  openDeliveredToken,
  pollEnrollment,
  requestEnrollment,
  type PendingEnrollment,
} from './agent-enrollment.ts';
import {
  claimEnrollment,
  listAgents,
  rejectEnrollment,
  revokeAgent,
  type Claim,
} from './agents.ts';
import { MemoryAgentPins, openAgentSession, saveContacts, type ClientContext } from './session.ts';

/** An enrollment this app is making for itself: its agent's side, and its person's claim. */
export type LocalEnrollment = { pending: PendingEnrollment; claim: Claim };

/**
 * Steps 1 to 4 of section 9.2, both sides in this app, after a recent
 * sign-in: request with fresh keys, claim the code the server gave, check,
 * and confirm as the agent. The check stands in for two people comparing
 * fingerprints: the agent keys the server served with the claim are exactly
 * the ones this app made, and the person it served to the agent's side is
 * this person at their current keys. Either way round, a key the server
 * swapped fails here, as it would show as a different fingerprint. Then
 * approve the claim as for any agent (`approveEnrollment`), and collect the
 * token with `finishLocalEnrollment`. A failure turns the claim down.
 */
export async function beginLocalEnrollment(
  ctx: ClientContext,
  now: () => Date = () => new Date(),
): Promise<LocalEnrollment> {
  const pending = await requestEnrollment(ctx.api, now);
  if (pending.installationId !== ctx.installationId) {
    throw new CryptoError('binding-mismatch', 'The server is another installation');
  }
  const claim = await claimEnrollment(ctx, pending.requested.lookupCode, now);
  try {
    if (!sameKeys(claim.agent, agentIdentity(pending, ctx.identity.public).public)) {
      throw new CryptoError('binding-mismatch', 'The server served other keys for the agent');
    }
    const polled = await pollEnrollment(ctx.api, pending, now);
    if (polled.state !== 'claimed') {
      throw new CryptoError('binding-mismatch', `The enrollment is ${polled.state}`);
    }
    const { claimer } = polled;
    if (
      !sameKeys(claimer.person, ctx.identity.public) ||
      claimer.fingerprint !== claim.fingerprint
    ) {
      throw new CryptoError('binding-mismatch', 'The server served the agent another person');
    }
    await confirmEnrollment(ctx.api, pending, claimer);
  } catch (error) {
    await rejectEnrollment(ctx, claim, now).catch(() => {});
    throw error;
  }
  return { pending, claim };
}

/**
 * Step 6 once the claim is approved: collect the agent's token, checked as
 * the CLI checks it, and keep it with the agent's secret keys in the
 * person's private contacts payload, in a confirmed write. If any of that
 * fails, the token and keys are lost with this app's memory, so the agent
 * is revoked rather than left unusable, holding its name.
 */
export async function finishLocalEnrollment(
  ctx: ClientContext,
  { pending, claim }: LocalEnrollment,
  now: () => Date = () => new Date(),
): Promise<void> {
  const agentId = claim.agent.id;
  try {
    const polled = await pollEnrollment(ctx.api, pending, now);
    if (polled.state !== 'approved') {
      throw new CryptoError('binding-mismatch', `The enrollment is ${polled.state}`);
    }
    const { token, identity } = openDeliveredToken(pending, ctx.identity.public, polled);
    const secret = {
      agentId,
      boxSecretKey: toBase64(identity.boxSecretKey),
      signSecretKey: toBase64(identity.signSecretKey),
      token,
    };
    await saveContacts(ctx, [{ kind: 'app-agent', secret }], {
      holds: (payloads) =>
        appAgentSecrets(payloads.private).some((s) => s.agentId === agentId && s.token === token),
    });
  } catch (error) {
    await revokeAgent(ctx, agentId, now).catch(() => {});
    throw error;
  }
}

/**
 * Give up on an enrollment this app was making for itself, when approving
 * it failed: turn it down, and if the server made the agent anyway (its
 * answer was lost), revoke it, since this app no longer holds its keys.
 */
export async function abandonLocalEnrollment(
  ctx: ClientContext,
  { claim }: LocalEnrollment,
  now: () => Date = () => new Date(),
): Promise<void> {
  await rejectEnrollment(ctx, claim, now).catch(() => {});
  const made = (await listAgents(ctx)).some(
    (agent) => agent.agentId === claim.agent.id && agent.revokedAt === null,
  );
  if (made) await revokeAgent(ctx, claim.agent.id, now);
}

/**
 * Open one of this person's app-run agents as its own session (section
 * 9.3): its keys, its bearer token in a client of its own, and this person
 * at their current keys. It starts from the contacts version this person's
 * session accepted, so it never takes an older one. Nothing it opens goes
 * into the person's keyring or revision cache, and it keeps no pins or
 * marks beyond this session. `baseUrl` and `fetch` are as for
 * `createApiClient`.
 */
export async function openAppAgent(
  ctx: ClientContext,
  agentId: IdentityId,
  connection: { baseUrl?: string; fetch?: Fetch } = {},
): Promise<ClientContext> {
  const { payloads } = ctx.contacts.book;
  const entry = payloads.shared.agents.find((agent) => agent.enrollment.agent.id === agentId);
  const secret = appAgentSecrets(payloads.private).find((s) => s.agentId === agentId);
  if (!entry || !secret) throw new CryptoError('wrong-recipient', 'This app runs no such agent');
  return openAgentSession(createApiClient({ ...connection, token: secret.token }), {
    identity: appAgentIdentity(entry, secret),
    person: ctx.identity.public,
    mark: ctx.contacts.book.mark,
    marks: new MemoryKeyVersionMarks(),
    pins: new MemoryAgentPins(),
  });
}
