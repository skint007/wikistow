// Agents enrolled the way the CLI and its person's app enroll them, and
// the agent's own client, for tests of what agents may do.
import {
  agentEnrollment,
  agentOperations,
  createApiClient,
  MemoryAgentPins,
  MemoryKeyVersionMarks,
  openAgentSession,
  type Fetch,
} from '@wikistow/client';
import { expect } from 'vite-plus/test';
import type { Person } from './sharing.ts';
import type { TestApp } from './harness.ts';

/**
 * A `fetch` with no cookie and no Origin, as a CLI sends: the agent's
 * client adds its bearer token. Byte bodies state their length.
 */
export const cliFetch =
  (t: TestApp): Fetch =>
  async (url, init) => {
    const headers = new Headers(init.headers);
    if (init.body instanceof Uint8Array) {
      headers.set('content-length', String(init.body.byteLength));
    }
    return t.app.request(url, { ...init, headers });
  };

/** A raw request as an agent, with its token. */
export const asAgent = (
  t: TestApp,
  token: string,
  path: string,
  { method = 'GET', json }: { method?: string; json?: unknown } = {},
) =>
  t.app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(json === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });

/** What a CLI keeps in its local file between runs (section 9.3), in memory. */
const agentFile = () => ({
  marks: new MemoryKeyVersionMarks(),
  pins: new MemoryAgentPins(),
});

/** A CLI that asked to enroll, up to the lookup code its user reads out. */
export async function cliRequest(t: TestApp) {
  const api = createApiClient({ fetch: cliFetch(t) });
  return { api, pending: await agentEnrollment.requestEnrollment(api) };
}

/**
 * Enroll an agent for `person` up to its approval: the CLI asks, the person
 * claims the code, both see one fingerprint, the CLI confirms, and the
 * person approves with `picks`. The CLI hasn't collected its token yet.
 */
export async function approvedAgent(
  t: TestApp,
  person: Person,
  {
    name = `agent ${Math.random().toString(36).slice(2, 8)}`,
    picks = [],
  }: { name?: string; picks?: agentOperations.AgentPick[] } = {},
) {
  const cli = await cliRequest(t);
  const claim = await agentOperations.claimEnrollment(person.ctx, cli.pending.requested.lookupCode);
  const polled = await agentEnrollment.pollEnrollment(cli.api, cli.pending);
  if (polled.state !== 'claimed') throw new Error(`expected a claim, got ${polled.state}`);
  expect(polled.claimer.fingerprint).toBe(claim.fingerprint);
  await agentEnrollment.confirmEnrollment(cli.api, cli.pending, polled.claimer);
  const agentId = await agentOperations.approveEnrollment(person.ctx, {
    claim,
    comparedFingerprint: polled.claimer.fingerprint,
    name,
    picks,
  });
  return { agentId, name, cli, person: polled.claimer.person };
}

/**
 * Enroll an agent for `person` the whole way (`approvedAgent`), then the
 * CLI collects its token and opens its own session.
 */
export async function enrolledAgent(
  t: TestApp,
  person: Person,
  options: { name?: string; picks?: agentOperations.AgentPick[] } = {},
) {
  const { agentId, name, cli, person: pinned } = await approvedAgent(t, person, options);
  const approved = await agentEnrollment.pollEnrollment(cli.api, cli.pending);
  if (approved.state !== 'approved') throw new Error(`expected a token, got ${approved.state}`);
  const { token, identity } = agentEnrollment.openDeliveredToken(cli.pending, pinned, approved);
  expect(identity.public.id).toBe(agentId);
  const api = createApiClient({ fetch: cliFetch(t), token });
  const kept = agentFile();
  const ctx = await openAgentSession(api, { identity, person: pinned, ...kept });
  return { agentId, name, token, identity, api, ctx, cli, kept };
}

export type Agent = Awaited<ReturnType<typeof enrolledAgent>>;
