import type { FolderId, LinkablePage } from '@wikistow/client';
import { createContext } from 'react';
import type { AttachmentContext } from './attachments';

/** What a page body's syntax renderers need to know about the page and its viewer. */
export type PageBodyContext = {
  attachments: AttachmentContext;
  /** The pages the viewer can open in the space, which wikilinks resolve against; null until loaded. */
  pages: readonly LinkablePage[] | null;
  /** The version's link table, key → page ID; an entry counts only for a page in `pages`. */
  links: ReadonlyMap<string, string>;
  /**
   * Set when the viewer edits the page: a missing link offers to create a
   * page in its folder, where `create` says one can be made.
   */
  editing: { parentId: FolderId | null; create: boolean } | null;
};

export const PageBody = createContext<PageBodyContext | null>(null);

/**
 * Whether what's drawn is in a link's text, as a wikilink in a Markdown
 * link can be; each link a page body draws provides it. A wikilink to a
 * page or a file there, or one an editor clicks to create a page, is drawn
 * as its text, part of the link it's in, as in the editor. As a control of
 * its own, it would take the click the link should.
 */
export const InLink = createContext(false);
