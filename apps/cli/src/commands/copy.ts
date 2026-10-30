// `wikistow page copy` and `folder copy`: a page or folder, with everything
// under it, copied as new nodes under a folder of any space (protocol
// section 10, "Copies, and moves between spaces"; ADR 0007). The CLI acts as
// its agent, so it copies within its picks and never moves. An agent's copy
// has no preview: the command prints where the copy went.
import {
  ApiError,
  canonical,
  copyOperations as copies,
  hashBytes,
  outcomeUnknown,
  pageOperations as pages,
  spaceOperations,
  toBase64,
  type ClientContext,
} from '@wikistow/client';
import { FolderId, PageId, type SpaceId } from '@wikistow/contracts';
import type { OpenedAgent } from '../agent.ts';
import { ChangeMayHaveHappened, CliError } from '../exit.ts';
import type { Io, Printer } from '../io.ts';
import { inputHash } from '../journal.ts';
import type { Deps } from './agent.ts';
import { shareStart, spaceOfFolder, withAgent, type ContentArgs } from './content.ts';

/** What `page copy` and `folder copy` are asked to copy, and where to. */
export type CopyArgs = ContentArgs &
  (
    | { kind: 'page'; nodeId: PageId; spaceId: SpaceId | null; folderId: FolderId | null }
    | { kind: 'folder'; nodeId: FolderId; spaceId: SpaceId | null; folderId: FolderId | null }
  );

/**
 * Each new node's ID, by the node it copies, derived from
 * `--idempotency-key` and what the command was asked, under the local
 * state's key: so a retry makes the same nodes, finds the top one once the
 * first run's copy has finished, and reports that copy's IDs. Nobody
 * without the key file can tell which keys were used. The copy's own ID
 * stays new each run: a run that failed cancelled its copy, so a retry
 * opens another.
 */
function keyedIds(agent: OpenedAgent, key: string, input: string) {
  const { stateKey } = agent.secrets;
  return (sourceId: string) =>
    toBase64(
      hashBytes(canonical('cli-copy-node/v1', [stateKey, key, input, sourceId])).slice(0, 16),
    );
}

/**
 * A copy's `forbidden` in words for a copy, which needs editing, not
 * publishing, with the pages a refusal names; anything else as it is.
 */
function refusal(error: unknown): unknown {
  if (!(error instanceof ApiError) || error.code !== 'forbidden') return error;
  const nodeIds = error.detail.nodeIds;
  if (nodeIds && nodeIds.length > 0) {
    return new CliError(
      'forbidden',
      'Some pages in it are published there from other pages, which are detached first, ' +
        'or have no version to copy: detail.nodeIds names them',
      { cause: error, detail: { nodeIds } },
    );
  }
  return new CliError(
    'forbidden',
    'This agent or its person may not copy that there: both must be allowed to edit it, ' +
      'and to make pages where it goes',
    { cause: error },
  );
}

/** Whether `spaceId`'s tree, as this agent sees it, lists `nodeId`: a copy's top shows once it finished. */
async function listed(ctx: ClientContext, spaceId: SpaceId, nodeId: string) {
  const { folders, pages: listedPages } = await spaceOperations.loadTree(ctx, spaceId);
  return [...folders, ...listedPages].some((node) => node.id === nodeId);
}

/**
 * `page copy` and `folder copy`: copy the page or folder, with what this
 * agent sees under it, into `--folder` or the top of its share in
 * `--space`. Pages arrive published where they are published now only if
 * the agent may publish there; else with their drafts alone. With
 * `--idempotency-key`, a first run's copy is looked for in the
 * destination's tree (`keyedIds`). A finish whose answer was lost is sent
 * again by `makeCopy`; one never answered may have made the copy.
 */
export async function copyNode(io: Io, out: Printer, args: CopyArgs, deps: Deps) {
  const command = `${args.kind} copy`;
  const input = inputHash(command, [args.nodeId, args.spaceId, args.folderId]);
  const done = await withAgent(
    io,
    out,
    args,
    deps,
    async (agent) => {
      const { ctx } = agent;
      const from =
        args.kind === 'page'
          ? (await pages.loadPage(ctx, args.nodeId)).spaceId
          : await spaceOfFolder(ctx, args.nodeId);
      let { spaceId, folderId: parentId } = args;
      if (spaceId === null) {
        if (parentId === null) throw new CliError('usage', 'Give --space, --folder or both');
        spaceId = await spaceOfFolder(ctx, parentId);
      } else if (parentId === null) {
        parentId = await shareStart(ctx, spaceId, '--folder');
      }
      const key = args.idempotencyKey;
      let preview: copies.CopyPreview;
      try {
        preview = await copies.previewCopy(ctx, {
          kind: 'copy',
          source: { spaceId: from, nodeId: args.nodeId },
          destination: { spaceId, parentId },
          ...(key !== null && { ids: keyedIds(agent, key, input) }),
        });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'binding-mismatch') {
          throw new CliError('usage', 'A folder can’t be copied into itself');
        }
        throw refusal(error);
      }
      const top = preview.nodes[0]?.nodeId ?? args.nodeId;
      if (key !== null && (await listed(ctx, spaceId, top))) return { preview, earlier: true };
      let finishing = false;
      try {
        await copies.makeCopy(ctx, preview, {
          onProgress: ({ stage }) => {
            finishing ||= stage === 'finishing';
          },
        });
      } catch (error) {
        // Before the finish, a failure ends the copy unseen: nothing was made.
        // A finish never answered, though sent again, may have made it.
        if (finishing && outcomeUnknown(error)) {
          throw new ChangeMayHaveHappened(error, key === null ? 'unkeyed' : 'resend');
        }
        throw refusal(error);
      }
      return { preview, earlier: false };
    },
    input,
  );
  const { preview, earlier } = done;
  const { source, destination, nodes } = preview;
  const newIds = new Map(nodes.map((node) => [node.sourceId, node.nodeId]));
  const top = nodes[0];
  const unpublished = preview.unpublished.map(({ pageId, title }) => ({
    pageId: newIds.get(pageId) ?? null,
    sourceId: pageId,
    title,
  }));
  const result = {
    kind: source.kind,
    source: { spaceId: source.spaceId, nodeId: source.nodeId },
    spaceId: destination.spaceId,
    nodeId: top?.nodeId ?? null,
    parentId: destination.parentId,
    pages: nodes.filter((node) => node.kind === 'page').length,
    folders: nodes.filter((node) => node.kind === 'folder').length,
    unpublished,
    links: preview.links,
  };
  out.result(result, () => {
    const where = destination.parentId
      ? `folder ${destination.parentId} of space ${destination.spaceId}`
      : `the top of space ${destination.spaceId}`;
    const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
    out.line(
      `Copied ${result.kind} ${source.nodeId} to ${where}, as ${result.kind} ${result.nodeId}: ` +
        `${count(result.pages, 'page')} and ${count(result.folders, 'folder')}`,
    );
    if (earlier) out.line('  copied by an earlier run with this --idempotency-key');
    if (unpublished.length > 0) {
      out.line('  published here, but unpublished there, where this agent can’t publish:');
    }
    for (const page of unpublished) {
      out.line(`    ${out.foreign(page.title ?? '(unreadable title)')}  ${page.pageId}`);
    }
    if (preview.links === null) out.line('  links couldn’t be read, so some may not open there');
    else if (preview.links.length > 0) out.line('  links that may not find their page there:');
    for (const link of preview.links ?? []) {
      const times = link.count > 1 ? ` (${link.count} links)` : '';
      out.line(`    ${out.foreign(link.text)}${times}`);
    }
  });
}
