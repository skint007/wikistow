// `wikistow page move`, `folder move` and `folder rename`: a page or folder
// moved within its space (protocol section 10), and a folder renamed
// (section 5.4). The CLI acts as its agent, so it moves only within one
// region, inside its picks (section 9.5): a move across a share, or into
// another space, is for its person, in WikiStow.
import {
  ApiError,
  CryptoError,
  moveOperations as moves,
  pageOperations as pages,
  spaceOperations,
  type ClientContext,
} from '@wikistow/client';
import type { FolderId, PageId, SpaceId } from '@wikistow/contracts';
import { CliError } from '../exit.ts';
import type { Io, Printer } from '../io.ts';
import { inputHash } from '../journal.ts';
import type { Deps } from './agent.ts';
import { spaceOfFolder, withAgent, type ContentArgs } from './content.ts';

/** What `page move` and `folder move` move, and where to: a folder, or null for the top of the space. */
export type MoveArgs = ContentArgs &
  ({ kind: 'page'; nodeId: PageId } | { kind: 'folder'; nodeId: FolderId }) & {
    parentId: FolderId | null;
  };

/** The space a page or folder this agent can see is in. */
const spaceOf = async (ctx: ClientContext, args: MoveArgs): Promise<SpaceId> =>
  args.kind === 'page'
    ? (await pages.loadPage(ctx, args.nodeId)).spaceId
    : spaceOfFolder(ctx, args.nodeId);

/**
 * `page move` and `folder move`: move it, with everything in it, under
 * `parentId` in its own space, as Move to... does in WikiStow. One already
 * there is left as it is, and nothing is sent, unless a retry's first run
 * is to be sent again.
 */
export async function moveNode(io: Io, out: Printer, args: MoveArgs, deps: Deps) {
  const input = inputHash(`${args.kind} move`, [args.nodeId, args.parentId]);
  const done = await withAgent(
    io,
    out,
    args,
    deps,
    async (agent) => {
      const { ctx } = agent;
      const spaceId = await spaceOf(ctx, args);
      let preview: moves.MovePreview;
      try {
        preview = await moves.previewMove(ctx, {
          spaceId,
          nodeId: args.nodeId,
          parentId: args.parentId,
        });
      } catch (error) {
        // The only stale-head a preview gives: the destination is inside what moves.
        if (error instanceof ApiError && error.code === 'stale-head') {
          throw new CliError('usage', 'A folder can’t move into itself or a folder inside it');
        }
        throw error;
      }
      const there = preview.fromParentId === args.parentId;
      if (!there || agent.journal.replaying) await moves.moveNode(ctx, { preview });
      return { spaceId, moved: !there || agent.journal.replaying };
    },
    input,
  );
  const result = {
    kind: args.kind,
    spaceId: done.spaceId,
    nodeId: args.nodeId,
    parentId: args.parentId,
    moved: done.moved,
  };
  out.result(result, () => {
    const top = args.parentId === null;
    const to = top ? 'to the top of the space' : `to folder ${args.parentId}`;
    const at = top ? 'at the top of the space' : `in folder ${args.parentId}`;
    out.line(
      done.moved
        ? `Moved ${args.kind} ${args.nodeId} ${to}`
        : `The ${args.kind} ${args.nodeId} is ${at} already; nothing changed`,
    );
  });
}

/**
 * `folder rename`: a new name for a folder this agent may edit, its emoji
 * and colour kept. The same name sends nothing, unless a retry's first run
 * is to be sent again.
 */
export async function renameFolder(
  io: Io,
  out: Printer,
  args: ContentArgs & { folderId: FolderId; name: string },
  deps: Deps,
) {
  const input = inputHash('folder rename', [args.folderId, args.name]);
  const done = await withAgent(
    io,
    out,
    args,
    deps,
    async (agent) => {
      const { ctx } = agent;
      const spaceId = await spaceOfFolder(ctx, args.folderId);
      const { folders } = await spaceOperations.loadTree(ctx, spaceId);
      const current = folders.find((folder) => folder.id === args.folderId)?.metadata;
      if (current === undefined) throw new ApiError(404, 'not-found', 'No such folder');
      if (current === null) throw new CryptoError('missing-key', 'No key opens the folder’s name');
      if (current.opened.kind !== 'current') {
        throw new CliError('failed', 'That folder was written by a newer WikiStow; update the CLI');
      }
      const same = current.opened.metadata.name === args.name;
      if (!same || agent.journal.replaying) {
        await spaceOperations.updateMetadata(ctx, {
          spaceId,
          subject: { kind: 'folder', folderId: args.folderId },
          current,
          changes: { name: args.name },
        });
      }
      return { spaceId, renamed: !same || agent.journal.replaying };
    },
    input,
  );
  const result = {
    spaceId: done.spaceId,
    folderId: args.folderId,
    name: args.name,
    renamed: done.renamed,
  };
  out.result(result, () =>
    out.line(
      done.renamed
        ? `Renamed folder ${args.folderId}`
        : `The folder ${args.folderId} has that name already; nothing changed`,
    ),
  );
}
