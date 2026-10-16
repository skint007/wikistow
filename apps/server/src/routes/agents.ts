import { agentRoutes } from '@wikistow/contracts';
import {
  addAgentEnvelopes,
  approveEnrollment,
  cancelEnrollment,
  claimEnrollment,
  confirmAgentGroup,
  confirmEnrollment,
  deleteAgentGrant,
  enrollmentState,
  leaveAgentGroup,
  listAgentGroups,
  listAgents,
  missingVersions,
  pollEnrollment,
  putAgentGrant,
  rejectEnrollment,
  requestEnrollment,
  revokeAgent,
  type Database,
} from '@wikistow/server';
import type { Routes } from '../http/mount.ts';
import { toApiError } from './content.ts';

// A CLI asks to enroll rarely; a burst from one address is someone probing.
const REQUEST_LIMIT = { windowSeconds: 600, max: 10 };
// The CLI polls every few seconds for up to ten minutes.
const POLL_LIMIT = { windowSeconds: 60, max: 60 };
const WRITE_LIMIT = { windowSeconds: 60, max: 30 };

/**
 * Agents (protocol section 9). The CLI's enrollment routes take no
 * session, only the poll secret; everything else is the person's own and
 * stays closed to agents.
 */
export function mountAgentRoutes(routes: Routes, { db }: { db: Database }): void {
  routes.public(
    agentRoutes.requestEnrollment,
    async ({ body }) => requestEnrollment(db, body).catch(toApiError),
    { rateLimit: REQUEST_LIMIT },
  );

  routes.public(
    agentRoutes.pollEnrollment,
    async ({ params, body }) => pollEnrollment(db, { ...params, ...body }).catch(toApiError),
    { rateLimit: POLL_LIMIT },
  );

  routes.public(
    agentRoutes.confirmEnrollment,
    async ({ params, body }) => {
      await confirmEnrollment(db, { ...params, ...body }).catch(toApiError);
      return { ok: true as const };
    },
    { rateLimit: POLL_LIMIT },
  );

  routes.public(
    agentRoutes.cancelEnrollment,
    async ({ params, body }) => {
      await cancelEnrollment(db, { ...params, ...body }).catch(toApiError);
      return { ok: true as const };
    },
    { rateLimit: POLL_LIMIT },
  );

  // Claiming and approving need someone at the keyboard (section 9.2).
  routes.account(
    agentRoutes.claimEnrollment,
    async ({ body }, { principal }) =>
      claimEnrollment(db, { accountId: principal.accountId, ...body }).catch(toApiError),
    { recentAuth: true },
  );

  routes.account(agentRoutes.enrollmentState, async ({ params }, { principal }) =>
    enrollmentState(db, { accountId: principal.accountId, ...params }).catch(toApiError),
  );

  routes.account(
    agentRoutes.approveEnrollment,
    async ({ params, body }, { principal }) =>
      approveEnrollment(db, { accountId: principal.accountId, ...params, ...body }).catch(
        toApiError,
      ),
    { recentAuth: true, rateLimit: WRITE_LIMIT },
  );

  routes.account(agentRoutes.rejectEnrollment, async ({ params }, { principal }) => {
    await rejectEnrollment(db, { accountId: principal.accountId, ...params }).catch(toApiError);
    return { ok: true as const };
  });

  routes.account(agentRoutes.myAgents, async (_input, { principal }) => ({
    agents: await listAgents(db, principal.accountId),
  }));

  routes.account(agentRoutes.myAgentGroups, async (_input, { principal }) => ({
    groups: await listAgentGroups(db, principal.accountId),
  }));

  routes.account(
    agentRoutes.confirmAgentGroup,
    async ({ params, body }, { principal }) => {
      await confirmAgentGroup(db, { accountId: principal.accountId, ...params, ...body }).catch(
        toApiError,
      );
      return { ok: true as const };
    },
    { rateLimit: WRITE_LIMIT },
  );

  routes.account(
    agentRoutes.leaveAgentGroup,
    async ({ params }, { principal }) => {
      await leaveAgentGroup(db, { accountId: principal.accountId, ...params }).catch(toApiError);
      return { ok: true as const };
    },
    { rateLimit: WRITE_LIMIT },
  );

  routes.account(
    agentRoutes.revokeAgent,
    async ({ params }, { principal }) => {
      await revokeAgent(db, { accountId: principal.accountId, ...params }).catch(toApiError);
      return { ok: true as const };
    },
    { rateLimit: WRITE_LIMIT },
  );

  routes.account(agentRoutes.missingVersions, async ({ params }, { principal }) => ({
    missing: await missingVersions(db, { accountId: principal.accountId, ...params }).catch(
      toApiError,
    ),
  }));

  routes.account(
    agentRoutes.addAgentEnvelopes,
    async ({ params, body }, { principal }) => {
      await addAgentEnvelopes(db, { accountId: principal.accountId, ...params, ...body }).catch(
        toApiError,
      );
      return { ok: true as const };
    },
    { rateLimit: WRITE_LIMIT },
  );

  routes.account(
    agentRoutes.putAgentGrant,
    async ({ params, body }, { principal }) => {
      await putAgentGrant(db, { accountId: principal.accountId, ...params, ...body }).catch(
        toApiError,
      );
      return { ok: true as const };
    },
    { rateLimit: WRITE_LIMIT },
  );

  routes.account(
    agentRoutes.deleteAgentGrant,
    async ({ params }, { principal }) => {
      await deleteAgentGrant(db, { accountId: principal.accountId, ...params }).catch(toApiError);
      return { ok: true as const };
    },
    { rateLimit: WRITE_LIMIT },
  );
}
