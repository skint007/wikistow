// The agent's side of enrollment (protocol section 9.2), for the CLI: fresh
// keys and a poll secret, the person who claimed the code, the fingerprint
// both sides compare, and the token, collected once. The CLI's own prompts
// and key file are its own; this is what it says to the server.
import {
  agentRoutes,
  systemRoutes,
  type EnrollmentRequested,
  type InstallationId,
} from '@wikistow/contracts';
import type { ApiClient } from '../api/client.ts';
import { toBase64 } from '../encoding.ts';
import {
  checkDeliveredToken,
  enrollmentDeadline,
  parseClaimingHuman,
  parseEnrollmentRequested,
  pollSecretHash,
} from '../enrollment.ts';
import { openSealedKey } from '../envelope.ts';
import { CryptoError } from '../errors.ts';
import {
  agentIdentityId,
  enrollmentFingerprint,
  type PrivateIdentity,
  type PublicIdentity,
} from '../identity.ts';
import { sodium } from '../sodium.ts';

/**
 * What a CLI holds while it enrolls: fresh keys, never reused from an
 * earlier request, its poll secret, the server's answer, and its own
 * deadline: the earlier of `expiresAt` and its start plus ten minutes.
 */
export type PendingEnrollment = {
  installationId: InstallationId;
  requested: EnrollmentRequested;
  deadline: Date;
  pollSecret: Uint8Array;
  box: { publicKey: Uint8Array; privateKey: Uint8Array };
  sign: { publicKey: Uint8Array; privateKey: Uint8Array };
};

/** The person who claimed the code, and what the CLI shows its user to compare. */
export type Claimer = {
  person: PublicIdentity;
  /** Server text, untrusted: printed only escaped, and before the fingerprint. */
  name: string;
  email: string;
  agentId: PublicIdentity['id'];
  /** Computed here, from the person's keys as served and the CLI's own. */
  fingerprint: string;
};

/** Step 1: fresh keys and poll secret, and the lookup code the person types. */
export async function requestEnrollment(
  api: ApiClient,
  now: () => Date = () => new Date(),
): Promise<PendingEnrollment> {
  const { installationId } = await api.call(systemRoutes.installation);
  const startedAt = now();
  const box = sodium.crypto_box_keypair();
  const sign = sodium.crypto_sign_keypair();
  const pollSecret = sodium.randombytes_buf(32);
  const requested = parseEnrollmentRequested(
    await api.call(agentRoutes.requestEnrollment, {
      body: {
        boxPublicKey: toBase64(box.publicKey),
        signPublicKey: toBase64(sign.publicKey),
        pollSecretHash: pollSecretHash(pollSecret),
      },
    }),
  );
  return {
    installationId,
    requested,
    deadline: enrollmentDeadline(requested.expiresAt, startedAt),
    pollSecret,
    box: { publicKey: box.publicKey, privateKey: box.privateKey },
    sign: { publicKey: sign.publicKey, privateKey: sign.privateKey },
  };
}

const keysOf = (pending: PendingEnrollment) => ({
  boxPublicKey: toBase64(pending.box.publicKey),
  signPublicKey: toBase64(pending.sign.publicKey),
});

/** The agent's identity once a person has claimed it: its ID derives from them. */
export function agentIdentity(pending: PendingEnrollment, person: PublicIdentity): PrivateIdentity {
  const keys = keysOf(pending);
  const id = agentIdentityId({
    installationId: pending.installationId,
    ownerId: person.id,
    ...keys,
  });
  return {
    public: { id, kind: 'agent', keyVersion: 1, ...keys },
    boxSecretKey: pending.box.privateKey,
    signSecretKey: pending.sign.privateKey,
  };
}

/** What a poll found. A lapsed deadline, by the CLI's own clock, is `expired`. */
export type Polled =
  | { state: 'requested' | 'cli-confirmed' | 'delivered' | 'expired' | 'cancelled' | 'rejected' }
  | { state: 'claimed'; claimer: Claimer }
  | { state: 'approved'; credentialId: string; sealedToken: string };

/**
 * Step 3: ask where the enrollment is. Once claimed, the person's identity
 * is checked as a pin would be (`parseClaimingHuman`), and the fingerprint
 * computed from it and the CLI's own keys.
 */
export async function pollEnrollment(
  api: ApiClient,
  pending: PendingEnrollment,
  now: () => Date = () => new Date(),
): Promise<Polled> {
  if (now().getTime() >= pending.deadline.getTime()) return { state: 'expired' };
  const polled = await api.call(agentRoutes.pollEnrollment, {
    params: { enrollmentId: pending.requested.enrollmentId },
    body: { pollSecret: toBase64(pending.pollSecret) },
  });
  if (polled.state !== 'claimed') {
    return polled.state === 'approved' ? polled : { state: polled.state };
  }
  const person = parseClaimingHuman(polled.person);
  const identity = agentIdentity(pending, person);
  return {
    state: 'claimed',
    claimer: {
      person,
      name: polled.name,
      email: polled.email,
      agentId: identity.public.id,
      fingerprint: enrollmentFingerprint({
        installationId: pending.installationId,
        owner: person,
        agent: identity.public,
      }),
    },
  };
}

/** Step 4: the CLI's user typed yes to the fingerprint shown for `claimer`. */
export async function confirmEnrollment(
  api: ApiClient,
  pending: PendingEnrollment,
  claimer: Claimer,
): Promise<void> {
  await api.call(agentRoutes.confirmEnrollment, {
    params: { enrollmentId: pending.requested.enrollmentId },
    body: { pollSecret: toBase64(pending.pollSecret), agentId: claimer.agentId },
  });
}

/** The CLI gives up: the enrollment ends, and its keys are never used again. */
export async function cancelEnrollment(api: ApiClient, pending: PendingEnrollment): Promise<void> {
  await api.call(agentRoutes.cancelEnrollment, {
    params: { enrollmentId: pending.requested.enrollmentId },
    body: { pollSecret: toBase64(pending.pollSecret) },
  });
}

/**
 * Step 6: open the token an approved poll delivered, sealed to the agent's
 * key. Anyone can seal to that key, so the token is server text until it
 * has the token's shape and names the credential the poll did.
 */
export function openDeliveredToken(
  pending: PendingEnrollment,
  person: PublicIdentity,
  { credentialId, sealedToken }: { credentialId: string; sealedToken: string },
): { token: string; identity: PrivateIdentity } {
  const identity = agentIdentity(pending, person);
  const opened = openSealedKey(identity, sealedToken);
  try {
    return { token: checkDeliveredToken({ credentialId, opened }), identity };
  } catch (error) {
    if (error instanceof CryptoError) throw error;
    throw new CryptoError('malformed', 'The delivered token does not read', { cause: error });
  } finally {
    sodium.memzero(opened);
  }
}
