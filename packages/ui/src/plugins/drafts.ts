import { pageOperations } from '@wikistow/client';
import { PageId } from '@wikistow/contracts';
import {
  PluginError,
  type PageChange,
  type PageHandle,
  type PageRef,
  type PageVersion,
} from '@wikistow/plugin-sdk';
import { payloadChanges, pluginError, readShown, session, type Caller } from './pages';
import type { OpenDraft, ShownPage } from './runtime';

const unloaded = () => new PluginError('unloaded', 'The plugin was turned off');

const headOf = async (page: PageRef) => {
  const info = await pageOperations.loadPage(session(), PageId.parse(page.pageId));
  if (!info.heads.draftHead) throw new PluginError('forbidden', 'The person can’t edit this page');
  return info.heads.draftHead;
};

/**
 * The drafts open in this window's editor, which plugins change through the
 * editor, and the page handles the app's own plugins get for the page shown.
 */
export function editorDrafts() {
  /** The drafts open in this window's editor, by page. */
  const openDrafts = new Map<string, OpenDraft>();
  /**
   * The plugin the editor saves for next, by page, which isn't told of that
   * save: its change, or what is typed, saved because it read the draft, so
   * a plugin reading on `draft.saved` doesn't keep the editor saving.
   */
  const savingFor = new Map<string, string>();

  /**
   * Change a draft open in the editor through the editor: what is typed is
   * saved first, and `base` is checked against what the editor then holds,
   * with nothing awaited before the change goes in, so nothing typed
   * meanwhile is overwritten. The change is then the person's next edit,
   * saved at once, and the editor never falls behind. Null if the page
   * isn't open here.
   */
  async function through(
    caller: Caller,
    page: PageRef,
    base: string | null,
    change: PageChange,
  ): Promise<PageVersion | null> {
    const draft = openDrafts.get(page.pageId);
    if (!draft) return null;
    await draft.flush();
    const head = draft.saved();
    if (head === null || (base !== null && base !== head)) {
      throw new PluginError('conflict', 'This draft changed since that revision; read it again');
    }
    const changes = payloadChanges(caller, change);
    // Refused before the editor gets it, which would hold it unsaved.
    draft.fits(changes);
    savingFor.set(page.pageId, caller.id);
    try {
      draft.revise(changes);
      await draft.flush();
    } finally {
      // A change the draft already had saves nothing, and must not mark the next save.
      if (savingFor.get(page.pageId) === caller.id) savingFor.delete(page.pageId);
    }
    // Typed into since, the editor has no saved revision; the server's head is the change.
    const revision = draft.saved() ?? (await headOf(page));
    return readShown(caller, session(), page, { version: 'draft', revision });
  }

  return {
    through,

    /**
     * The page handle a plugin gets for `shown`. In the draft view it reads
     * the draft as it is now, what is typed saved first, and an edit must be
     * on top of the version it last read.
     */
    handle(caller: Caller, shown: ShownPage): PageHandle {
      let lastRead: string | null = null;
      return {
        page: { ...shown.page },
        read: async () => {
          try {
            if (!caller.live()) throw unloaded();
            const draft = shown.draft ? openDrafts.get(shown.page.pageId) : undefined;
            if (!draft?.ready()) {
              // The published version, or a draft view whose editor isn't open yet, as
              // when a view drawn with the page reads at once: nothing is typed so far.
              const version = await readShown(caller, session(), shown.page, shown);
              if (shown.draft) lastRead = version.revision;
              return version;
            }
            const { pageId } = shown.page;
            const { id } = caller;
            if (!savingFor.has(pageId)) savingFor.set(pageId, id);
            try {
              await draft.flush();
            } finally {
              if (savingFor.get(pageId) === id) savingFor.delete(pageId);
            }
            const revision = draft.saved() ?? (await headOf(shown.page));
            const version = await readShown(caller, session(), shown.page, {
              version: 'draft',
              revision,
            });
            if (!caller.live()) throw unloaded();
            lastRead = version.revision;
            return version;
          } catch (error) {
            throw pluginError(error);
          }
        },
        edit: shown.draft
          ? async (change: PageChange) => {
              try {
                if (!caller.live()) throw unloaded();
                caller.write();
                const written = await through(caller, shown.page, lastRead, change);
                if (!written) throw new PluginError('unloaded', 'The draft view was closed');
                if (!caller.live()) throw unloaded();
                lastRead = written.revision;
                return written;
              } catch (error) {
                throw pluginError(error);
              }
            }
          : null,
      };
    },

    /** The draft view opened `page` in the editor; plugins change it through `draft` until the returned function runs. */
    open(page: PageRef, draft: OpenDraft) {
      openDrafts.set(page.pageId, draft);
      return () => {
        if (openDrafts.get(page.pageId) === draft) openDrafts.delete(page.pageId);
      };
    },

    /** The plugin the editor just saved `page` for, which isn't told of that save. */
    savedFor(page: PageRef) {
      const by = savingFor.get(page.pageId) ?? null;
      savingFor.delete(page.pageId);
      return by;
    },
  };
}
