import { AgentId, AgentToken, type IdentityId } from '@wikistow/contracts';
import { z } from 'zod';
import type { PrivateContacts, SharedContacts } from './contacts.ts';
import { fromBase64 } from './encoding.ts';
import type { PrivateIdentity } from './identity.ts';

/**
 * Where a person's contacts record keeps the agents their own app runs (the
 * page chat): each one's secret keys and bearer token, in the private
 * payload, which only the person can open. A CLI agent keeps these in its
 * key file instead; here the person's vault is the key file.
 */
export const APP_AGENTS_NAMESPACE = 'wikistow.appAgents';

const Base64 = z.string().regex(/^[A-Za-z0-9_-]+$/);

/** One app-run agent's secrets. Its public keys are in its enrollment, in the shared payload. */
export const AppAgentSecret = z.object({
  agentId: AgentId,
  boxSecretKey: Base64,
  signSecretKey: Base64,
  token: AgentToken,
});
export type AppAgentSecret = z.infer<typeof AppAgentSecret>;

const AppAgents = z.looseObject({ agents: z.array(z.json()) });

/** Every readable secret in the private payload. One that doesn't parse is left out, not fatal. */
export function appAgentSecrets(own: PrivateContacts): AppAgentSecret[] {
  const stored = AppAgents.safeParse(own.extensions[APP_AGENTS_NAMESPACE]);
  if (!stored.success) return [];
  return stored.data.agents.flatMap((entry) => {
    const secret = AppAgentSecret.safeParse(entry);
    return secret.success ? [secret.data] : [];
  });
}

/** The private payload with `secret` kept for its agent, replacing any earlier one. */
export function withAppAgentSecret(own: PrivateContacts, secret: AppAgentSecret): PrivateContacts {
  const stored = AppAgents.safeParse(own.extensions[APP_AGENTS_NAMESPACE]);
  // Entries this version can't read stay as they are.
  const others = (stored.success ? stored.data.agents : []).filter(
    (entry) => AppAgentSecret.safeParse(entry).data?.agentId !== secret.agentId,
  );
  return {
    ...own,
    extensions: { ...own.extensions, [APP_AGENTS_NAMESPACE]: { agents: [...others, secret] } },
  };
}

/** An app-run agent this person can open now: on their record, not revoked, with its secret. */
export type AppAgent = { agentId: IdentityId; name: string; secret: AppAgentSecret };

/** The app-run agents a person's record lists live, in the record's order. */
export function listAppAgents(payloads: {
  shared: SharedContacts;
  private: PrivateContacts;
}): AppAgent[] {
  const secrets = appAgentSecrets(payloads.private);
  const revoked = new Set(payloads.shared.revokedAgents.map((entry) => entry.agentId));
  return payloads.shared.agents.flatMap((agent) => {
    const agentId = AgentId.parse(agent.enrollment.agent.id);
    const secret = secrets.find((s) => s.agentId === agentId);
    return secret && !revoked.has(agentId) ? [{ agentId, name: agent.label.name, secret }] : [];
  });
}

/** The agent's private identity, from its enrollment's public keys and its secret. */
export const appAgentIdentity = (
  agent: Pick<SharedContacts['agents'][number], 'enrollment'>,
  secret: AppAgentSecret,
): PrivateIdentity => ({
  public: agent.enrollment.agent,
  boxSecretKey: fromBase64(secret.boxSecretKey),
  signSecretKey: fromBase64(secret.signSecretKey),
});
