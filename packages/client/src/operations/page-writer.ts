// The one place the app's offline-capable writes go through (ADR 0009,
// decision 7): drafts, new pages, new folders, files, folder renames,
// deletes, moves and publishing. It decides whether each goes to the server
// or into this device's queue, and falls back to the queue when the server
// doesn't answer. A move or publish goes into the queue only: online, each
// goes through its own operation, which first shows the person what it does.
import {
  FolderId,
  MetadataRevisionId,
  PageId,
  RevisionId,
  type Position,
  type SpaceId,
} from '@wikistow/contracts';
import { ApiError, noAnswer } from '../api/client.ts';
import { newId } from '../ids.ts';
import {
  ICON_NAMESPACE,
  newFolderMetadata,
  type FolderLook,
  type FolderPicture,
} from '../metadata.ts';
import { newPayload, type AttachmentRef, type PagePayload } from '../payload.ts';
import { OWNER_REGION } from '../regions.ts';
import {
  createPage,
  deleteNode,
  saveDraft,
  uploadAttachment,
  uploadBlob,
  type PageRef,
  type Written,
} from './pages.ts';
import type { FolderChanges, OfflineQueue } from './queue.ts';
import type { LoadedMetadata } from './records.ts';
import type { ClientContext } from './session.ts';
import { createFolderAs, updateMetadata } from './spaces.ts';

type File = { name: string; mediaType: string; bytes: Uint8Array };

/** A draft save as the draft view asks for it; the writer picks its revision ID. */
export type DraftSave = Omit<Parameters<typeof saveDraft>[1], 'page' | 'revisionId'>;

/** The server operations the writer writes through, as `serverWrites` gives them for a session. */
export type ServerWrites = {
  createPage(input: {
    spaceId: SpaceId;
    parentId: FolderId | null;
    title: string;
    markdown?: string;
    pageId: PageId;
    revisionId: RevisionId;
  }): Promise<unknown>;
  createFolder(input: Parameters<typeof createFolderAs>[1]): Promise<void>;
  saveDraft(input: Parameters<typeof saveDraft>[1]): Promise<Written>;
  /** Seal a file for a page's draft and upload it. */
  uploadAttachment(page: PageRef, file: File): Promise<AttachmentRef>;
  /** Upload a draft file sealed already, as the queue holds it. */
  uploadBlob(page: PageRef, blob: Uint8Array): Promise<void>;
  updateMetadata(input: Parameters<typeof updateMetadata>[1]): Promise<unknown>;
  deleteNode(input: Parameters<typeof deleteNode>[1]): Promise<void>;
};

/** The server operations for `ctx`'s session. */
export const serverWrites = (ctx: ClientContext): ServerWrites => ({
  createPage: (input) => createPage(ctx, input),
  createFolder: (input) => createFolderAs(ctx, input),
  saveDraft: (input) => saveDraft(ctx, input),
  uploadAttachment: (page, file) => uploadAttachment(ctx, page, file),
  uploadBlob: (page, blob) => uploadBlob(ctx, page, 'draft', blob),
  updateMetadata: (input) => updateMetadata(ctx, input),
  deleteNode: (input) => deleteNode(ctx, input),
});

/**
 * One draft view's saves of one page. It remembers the version of the
 * page's waiting change it last saw, so a save over one another tab or
 * window saved into since is a conflict.
 */
export type DraftWriter = {
  /**
   * Save the draft: on the server, or into the page's waiting change,
   * offline or while there is one. A save that got no answer is kept as a
   * change under the revision ID it was sent with. A save into the queue
   * comes back as written on its base, as typed.
   */
  save(input: DraftSave): Promise<Written>;
  /** A file for the draft, as `PageWriter.attach` takes it. */
  attach(file: File): Promise<AttachmentRef>;
  /** The person chose to save theirs on top of `revisionId` (Save mine on top). */
  onTopOf(revisionId: RevisionId): void;
  /**
   * The draft the page's waiting change stands for, or null if it has none
   * (then the server's draft head is). The next save goes on top of that
   * change as it is now, so a conflict with another window's ends here.
   */
  waitingHead(): Promise<RevisionId | null>;
  /**
   * The page's draft change waiting on this device as it is now, for a
   * merge with another window's (ADR 0013, decision 2): its version, the
   * draft it stands for (as `waitingHead`), and its payload. Null if it has none.
   */
  waitingChange(): Promise<WaitingChange | null>;
  /**
   * The person merged with the waiting change at `version`: the next save
   * goes into it, unless another tab or window saved into it since.
   */
  mergedWith(version: number): void;
  /** Whether the last save was refused over a change another tab or window saved here. */
  conflictWithDevice(): boolean;
};

/** A page's draft change waiting on this device, as `DraftWriter.waitingChange` reads it. */
export type WaitingChange = { version: number; head: RevisionId | null; payload: PagePayload };

export type PageWriter = {
  /**
   * A new page with that title, at the space root or in a folder. It is
   * made on this device, to be made on the server once it answers, offline
   * or in a folder made offline and not sent yet, as is one whose request
   * got no answer, under the IDs it was sent with.
   */
  newPage(input: { spaceId: SpaceId; parentId: FolderId | null; title: string }): Promise<PageId>;
  /**
   * As `newPage`, its first draft holding `markdown`: the page, and that
   * draft's revision, for a save on top of it (`draft`), as a clip from the
   * browser is saved once its images are attached (ADR 0017).
   */
  newPageDraft(input: {
    spaceId: SpaceId;
    parentId: FolderId | null;
    title: string;
    markdown: string;
  }): Promise<{ pageId: PageId; revisionId: RevisionId }>;
  /** A new folder, made where `newPage` would make a page. */
  newFolder(input: {
    spaceId: SpaceId;
    parentId: FolderId | null;
    name: string;
    look?: FolderLook;
    picture?: FolderPicture;
  }): Promise<FolderId>;
  /**
   * Seal a file for a page's draft and upload it, or, where the draft saves
   * into the queue, keep it there until the change is sent. Add the
   * returned ref to the draft's attachments to keep it.
   */
  attach(page: PageRef, file: File): Promise<AttachmentRef>;
  /** Saves of `page`'s draft, by a view that opened its waiting change at version `seen`, or none. */
  draft(page: PageRef, { seen }: { seen: number | null }): DraftWriter;
  /**
   * Rename a folder, or change its look: `changes` on top of `current`, its
   * metadata as the tree shows it. On the server (`'saved'`), or on this
   * device (`'waiting'`), as for a draft. An image is changed online only.
   */
  renameFolder(input: {
    spaceId: SpaceId;
    folderId: FolderId;
    current: LoadedMetadata;
    changes: FolderChanges;
  }): Promise<'saved' | 'waiting'>;
  /**
   * Put a page or folder in the trash (`'trashed'`), or, on this device, wait
   * to (`'waiting'`), or drop it with what's in it if it was made offline and
   * isn't sent yet (`'dropped'`). `dropChanges` drops the page's draft
   * waiting here first, which otherwise goes before, into the trash with it.
   */
  deleteNode(input: {
    spaceId: SpaceId;
    nodeId: PageId | FolderId;
    node: 'page' | 'folder';
    name: string;
    dropChanges?: boolean;
  }): Promise<'trashed' | 'waiting' | 'dropped'>;
  /**
   * Move a page or folder within its space, and within one share, on this
   * device (#331), as `OfflineQueue.move`. One that changes who can read it
   * is made online, once the person looked it over (`moveNode`).
   */
  moveNode(input: {
    spaceId: SpaceId;
    nodeId: PageId | FolderId;
    node: 'page' | 'folder';
    name: string;
    parentId: FolderId | null;
    /** Where among what is there (#400); a reorder moves it where it is already. */
    position?: Position | null;
  }): Promise<void>;
  /** Publish a page's draft as it stands now on this device (#331), as `OfflineQueue.publish`. */
  publish(input: { page: PageRef; title: string; draftHead: RevisionId }): Promise<void>;
  /** Put what is in a folder, or at the top, in order on this device (#400), as `OfflineQueue.order`. */
  order(input: {
    spaceId: SpaceId;
    parentId: FolderId | null;
    name: string;
    positions: readonly { nodeId: string; position: Position | null }[];
  }): Promise<void>;
};

/**
 * The writer over `queue` (none where the device keeps nothing: then every
 * write goes to the server) and `server`. A write goes into the queue
 * offline (`isOnline`), and online too while what it writes on has a
 * change waiting, so it goes after: the page itself for a draft or a
 * file, the folder it goes in for a new page or folder, the folder or
 * page renamed or deleted.
 */
export function createPageWriter({
  queue,
  server,
  isOnline,
}: {
  queue: OfflineQueue | null;
  server: ServerWrites;
  isOnline: () => boolean;
}): PageWriter {
  // The queue, if what's written on `id` goes there.
  const onDevice = async (id: PageId | FolderId | null) =>
    queue && (!isOnline() || (id !== null && (await queue.waiting(id)).length > 0)) ? queue : null;

  const writer: PageWriter = {
    newPage: async (input) => (await writer.newPageDraft({ ...input, markdown: '' })).pageId,

    async newPageDraft({ spaceId, parentId, title, markdown }) {
      const payload = newPayload({ title, markdown });
      const device = await onDevice(parentId);
      if (device) {
        const entry = await device.newPage({ spaceId, parentId, payload });
        return { pageId: entry.id, revisionId: entry.newPage!.revisionId };
      }
      const pageId = newId(PageId);
      const revisionId = newId(RevisionId);
      try {
        await server.createPage({
          spaceId,
          parentId,
          title,
          ...(markdown && { markdown }),
          pageId,
          revisionId,
        });
      } catch (error) {
        if (!queue || !noAnswer(error)) throw error;
        await queue.newPage({ spaceId, parentId, payload, pageId, revisionId });
      }
      return { pageId, revisionId };
    },

    async newFolder({ spaceId, parentId, name, look, picture }) {
      const metadata = newFolderMetadata(name, look, picture);
      const folderId = newId(FolderId);
      const device = await onDevice(parentId);
      if (device) return (await device.newFolder({ spaceId, parentId, metadata, folderId })).id;
      try {
        await server.createFolder({ spaceId, parentId, folderId, metadata });
      } catch (error) {
        if (!queue || !noAnswer(error)) throw error;
        await queue.newFolder({ spaceId, parentId, metadata, folderId, tried: true });
      }
      return folderId;
    },

    async attach(page, file) {
      const device = await onDevice(page.pageId);
      return device ? device.attach(page, file) : server.uploadAttachment(page, file);
    },

    draft(page, { seen: opened }) {
      // An entry gone since, when its change was sent, is made afresh by the next save into it.
      let seen = opened;
      // What the person chose to save theirs on top of, for the next save into the queue.
      let onTop: RevisionId | null = null;
      let otherWindow = false;
      // A save into the queue, as the draft view takes it: on its base, as
      // typed, its links worked out once it is sent.
      const asTyped = (input: DraftSave): Written => ({
        revisionId: input.basedOn,
        repaired: false,
        region: input.basedOnRegion ?? input.tableRegion ?? OWNER_REGION,
        payload: input.payload,
        inUse: input.payload,
        renamed: [],
        linksKept: true,
      });
      const entryOf = (input: DraftSave) => ({
        page,
        basedOn: input.basedOn,
        region: input.tableRegion ?? input.basedOnRegion ?? null,
        payload: input.payload,
        ...(input.linkChoices && { linkChoices: input.linkChoices }),
      });
      return {
        async save(input) {
          // A conflict with another window's change is the last save's only.
          otherWindow = false;
          const device = await onDevice(page.pageId);
          if (device) {
            try {
              seen = await device.saveDraft({
                ...entryOf(input),
                seen,
                onTop: onTop === input.basedOn,
              });
            } catch (error) {
              otherWindow = error instanceof ApiError && error.code === 'stale-head';
              throw error;
            }
            onTop = null;
            return asTyped(input);
          }
          const revisionId = newId(RevisionId);
          const { attachments } = input.payload;
          try {
            // Files added while the page's changes went into the queue are
            // there only: they go up first, and are let go of once saved.
            await queue?.upload(attachments, (blob) => server.uploadBlob(page, blob));
            const written = await server.saveDraft({ page, ...input, revisionId });
            void queue?.sent(attachments).catch(() => {});
            return written;
          } catch (error) {
            if (!queue || !noAnswer(error)) throw error;
            seen = await queue.lost({ ...entryOf(input), revisionId });
            return asTyped(input);
          }
        },
        attach: (file) => writer.attach(page, file),
        onTopOf(revisionId) {
          onTop = revisionId;
        },
        async waitingHead() {
          otherWindow = false;
          const entry = await queue?.entry(page.pageId);
          if (entry?.kind !== 'page' || entry.failure) return null;
          seen = entry.version;
          return entry.basedOn ?? entry.newPage?.revisionId ?? null;
        },
        async waitingChange() {
          const entry = await queue?.entry(page.pageId);
          if (entry?.kind !== 'page') return null;
          const head = entry.basedOn ?? entry.newPage?.revisionId ?? null;
          return { version: entry.version, head, payload: entry.payload };
        },
        mergedWith(version) {
          seen = version;
          otherWindow = false;
        },
        conflictWithDevice: () => otherWindow,
      };
    },

    async renameFolder({ spaceId, folderId, current, changes }) {
      const device = await onDevice(folderId);
      const image = changes.extensions?.[ICON_NAMESPACE] !== undefined;
      if (device) {
        if (image) throw new Error('A folder’s image is changed online only');
        await device.rename({ spaceId, folderId, current, changes });
        return 'waiting';
      }
      const metadataRevisionId = newId(MetadataRevisionId);
      const subject = { kind: 'folder' as const, folderId };
      try {
        await server.updateMetadata({ spaceId, subject, current, changes, metadataRevisionId });
        return 'saved';
      } catch (error) {
        // An image is never kept in the queue: the person tries again online.
        if (!queue || !noAnswer(error) || image) throw error;
        await queue.rename({ spaceId, folderId, current, changes, metadataRevisionId });
        return 'waiting';
      }
    },

    async deleteNode({ spaceId, nodeId, node, name, dropChanges = false }) {
      const own = dropChanges ? await queue?.entry(nodeId) : null;
      if (own?.kind === 'page' && !own.newPage) await queue?.discard(own);
      const device = await onDevice(nodeId);
      if (device) return device.delete({ spaceId, id: nodeId, node, name });
      try {
        await server.deleteNode({ spaceId, nodeId });
        return 'trashed';
      } catch (error) {
        if (!queue || !noAnswer(error)) throw error;
        return queue.delete({ spaceId, id: nodeId, node, name, tried: true });
      }
    },

    async moveNode({ spaceId, nodeId, node, name, parentId, position }) {
      if (!queue) throw new Error('This device keeps no changes');
      await queue.move({
        spaceId,
        id: nodeId,
        node,
        name,
        parentId,
        ...(position !== undefined && { position }),
      });
    },

    async publish(input) {
      if (!queue) throw new Error('This device keeps no changes');
      await queue.publish(input);
    },

    async order(input) {
      if (!queue) throw new Error('This device keeps no changes');
      await queue.order(input);
    },
  };
  return writer;
}
