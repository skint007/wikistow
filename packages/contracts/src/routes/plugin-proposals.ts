import { PluginFile, PluginId } from '@wikistow/plugin-sdk/manifest';
import { z } from 'zod';
import { Timestamp } from '../records/encoding.ts';
import type { RouteDef } from '../route.ts';
import { DraftId, DraftSummary } from './plugin-drafts.ts';
import { PluginHash } from './plugins.ts';

/*
 * Plugin proposals (#315): a copy draft of someone else's plugin, sent
 * back to the plugin's owner as a read-only bundle of its files, under the
 * original ID again. The owner opens it as a draft of their own, or
 * declines it. Its own routes, so no draft response changes. People only.
 */

export const ProposalId = z.uuid();

/** Someone a proposal is from or to, by their name on the server. */
const Person = z.strictObject({ name: z.string() });

/**
 * A proposal without its files. `pluginId` is the original's, and `hash`
 * the version the copy started from, which may since have been removed.
 * `name` is its manifest's name. `files` and `size` count its fonts and
 * images too.
 */
export const ProposalSummary = z.strictObject({
  id: ProposalId,
  pluginId: PluginId,
  hash: PluginHash,
  name: z.string(),
  from: Person,
  to: Person,
  files: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  createdAt: Timestamp,
});
export type ProposalSummary = z.infer<typeof ProposalSummary>;

const DraftParams = z.object({ draftId: DraftId });
const ProposalParams = z.object({ proposalId: ProposalId });

/**
 * Whom the caller's draft would be proposed to: the owner of the plugin it
 * is a copy of, or null when it is no copy of another account's plugin.
 * `sent` is the caller's proposal for that plugin, if they made one and the
 * owner hasn't opened or declined it yet.
 */
export const getDraftProposal = {
  method: 'GET',
  path: '/api/plugin-drafts/:draftId/proposal',
  params: DraftParams,
  response: z.strictObject({
    to: Person.nullable(),
    sent: ProposalSummary.nullable(),
  }),
} as const satisfies RouteDef;

/**
 * Propose the caller's copy draft to the plugin's owner: its files as they
 * are now, with the manifest's ID set back to the original's. It replaces
 * the caller's earlier proposal for that plugin. Not its conversation,
 * build or samples. Refused with `invalid-request` when the draft is no
 * copy of another account's plugin, or its manifest can't be read.
 */
export const proposeDraft = {
  method: 'POST',
  path: '/api/plugin-drafts/:draftId/proposal',
  params: DraftParams,
  body: z.strictObject({}),
  response: z.strictObject({ proposal: ProposalSummary }),
  status: 201,
} as const satisfies RouteDef;

/** Proposals for the caller's plugins, newest first. They don't count against `MAX_DRAFTS`. */
export const listProposals = {
  method: 'GET',
  path: '/api/plugin-proposals',
  response: z.strictObject({ proposals: z.array(ProposalSummary) }),
} as const satisfies RouteDef;

/**
 * How a proposed file differs from the version it started from: `before`
 * and `after` are its text, or null on the side it's missing from or for
 * a font or image.
 */
export const ProposalChange = z.strictObject({
  path: PluginFile,
  change: z.enum(['added', 'changed', 'removed']),
  before: z.string().nullable(),
  after: z.string().nullable(),
});
export type ProposalChange = z.infer<typeof ProposalChange>;

/**
 * A proposal for one of the caller's plugins, with what changed by file,
 * sorted by path. `base` says whether the version it started from is the
 * plugin's newest, an older one, or gone from the library, when every
 * file reads as added.
 */
export const getProposal = {
  method: 'GET',
  path: '/api/plugin-proposals/:proposalId',
  params: ProposalParams,
  response: z.strictObject({
    proposal: ProposalSummary,
    base: z.enum(['newest', 'older', 'gone']),
    changes: z.array(ProposalChange),
  }),
} as const satisfies RouteDef;

/**
 * Open a proposal as a draft of the caller's own, under the plugin's ID
 * and from the version it started from, and forget the proposal. Like a
 * new draft, it is refused with `draft-limit` at `MAX_DRAFTS` unless
 * `replaces` names one of the caller's drafts, deleted with it.
 */
export const openProposal = {
  method: 'POST',
  path: '/api/plugin-proposals/:proposalId/open',
  params: ProposalParams,
  body: z.strictObject({ replaces: DraftId.optional() }),
  response: z.strictObject({ draft: DraftSummary }),
  status: 201,
} as const satisfies RouteDef;

/** Decline a proposal for one of the caller's plugins: it is deleted. */
export const declineProposal = {
  method: 'DELETE',
  path: '/api/plugin-proposals/:proposalId',
  params: ProposalParams,
  response: z.object({ ok: z.literal(true) }),
} as const satisfies RouteDef;
