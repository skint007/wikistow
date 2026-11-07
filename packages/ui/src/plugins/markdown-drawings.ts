import { PageId, RevisionId, SpaceId } from '@wikistow/contracts';
import type { Disposer } from '@wikistow/plugin-sdk';
import { z } from 'zod';
import type { HostPages } from './pages';

/**
 * The page `host.app.renderMarkdown` draws for, and the version whose
 * files and links it uses, where it names one: a `PageVersion` passes as
 * it is, its other keys dropped.
 */
export const MarkdownPage = z
  .object({
    spaceId: SpaceId,
    pageId: PageId,
    version: z.enum(['draft', 'published']).optional(),
    revision: RevisionId.optional(),
  })
  .refine(({ version, revision }) => (version === undefined) === (revision === undefined));
export type MarkdownPage = z.infer<typeof MarkdownPage>;

/** One `host.app.renderMarkdown` call: what to draw, where, and the plugin's page operations. */
export type MarkdownDrawing = {
  element: HTMLElement;
  markdown: string;
  page: MarkdownPage;
  /** The calling plugin's `host.pages`, which must read `page`. */
  pages: HostPages;
};

/** A drawing as `RenderedMarkdown` draws it: into a box of its own in the plugin's element. */
export type HeldDrawing = Omit<MarkdownDrawing, 'element'> & { box: HTMLElement; key: number };

/**
 * What plugins asked the app's reader to draw, each into an element of
 * theirs, until undone. `RenderedMarkdown` draws them inside the app's own
 * React tree, so wikilinks, blocks and the rest work as on a page.
 */
export function createMarkdownDrawings() {
  let drawings: readonly HeldDrawing[] = [];
  let next = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    draw: ({ element, ...drawing }: MarkdownDrawing): Disposer => {
      // A box of the app's own: the plugin may empty its element before
      // React lets go of what it drew there, which would then fail.
      const box = document.createElement('div');
      element.append(box);
      const held: HeldDrawing = { ...drawing, box, key: next++ };
      drawings = [...drawings, held];
      emit();
      return () => {
        if (!drawings.includes(held)) return;
        box.remove();
        drawings = drawings.filter((other) => other !== held);
        emit();
      };
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: () => drawings,
  };
}

export type MarkdownDrawings = ReturnType<typeof createMarkdownDrawings>;
