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

type CopyPreview = copies.CopyPreview;

/** What `page copy` and `folder copy` are asked to copy, and where to. */
export type CopyArgs = ContentArgs &
  (
    | { kind: 'page'; nodeId: PageId; spaceId: SpaceId | null; folderId: FolderId | null }
    | { kind: 'folder'; nodeId: FolderId; spaceId: SpaceId | null; folderId: FolderId | null }
  );

/**
 * `preview` with each new node's ID derived from `--idempotency-key`, what
 * the command was asked and the node it copies, under the local state's
 * key: so a retry makes the same nodes, finds the top one once the first
 * run's copy has finished, and reports that copy's IDs. Nobody without the
 * key file can tell which keys were used.
 */
function keyedIds(
  agent: OpenedAgent,
  preview: CopyPreview,
  key: string,
  input: string,
): CopyPreview {
  const { stateKey } = agent.secrets;
  const ids = new Map(
    preview.nodes.map(({ nodeId, sourceId, kind }) => {
      const bytes = hashBytes(canonical('cli-copy-node/v1', [stateKey, key, input, sourceId]));
      const id = toBase64(bytes.slice(0, 16));
      return [nodeId as string, kind === 'page' ? PageId.parse(id) : FolderId.parse(id)];
    }),
  );
  return {
    ...preview,
    nodes: preview.nodes.map((node) => ({
      ...node,
      nodeId: ids.get(node.nodeId) ?? node.nodeId,
      // A parent is a folder; the top node's, the destination folder, stays.
      parentId: (node.parentId && (ids.get(node.parentId) as FolderId)) ?? node.parentId,
    })),
  };
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
 * the agent may publish there; else with their drafts alone. A finish whose
 * answer was lost is looked for in the destination's tree; with
 * `--idempotency-key`, so is a first run's copy (`keyedIds`).
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
      let preview: CopyPreview;
      try {
        preview = await copies.previewCopy(ctx, {
          kind: 'copy',
          source: { spaceId: from, nodeId: args.nodeId },
          destination: { spaceId, parentId },
        });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'binding-mismatch') {
          throw new CliError('usage', 'A folder can’t be copied into itself');
        }
        throw error;
      }
      const key = args.idempotencyKey;
      if (key !== null) preview = keyedIds(agent, preview, key, input);
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
        if (!finishing || !outcomeUnknown(error)) throw error;
        // The finish's answer was lost: its top node is listed if it landed.
        if (await listed(ctx, spaceId, top).catch(() => false)) return { preview, earlier: false };
        throw new ChangeMayHaveHappened(error, key === null ? 'unkeyed' : 'resend');
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
