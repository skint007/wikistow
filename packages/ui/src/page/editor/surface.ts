import type { AttachmentRef, LinkablePage, PropertyData } from '@wikistow/client';
import type { Ref } from 'react';

// An editor surface is one way of editing a page's Markdown body: the
// source editor or the visual one. The draft session around it owns
// everything else (saving, conflicts, attachments, the link table), so a
// surface only edits text and reports it.
//
// The contract:
// - `initial` is the text the surface opens with. It is read once, on
//   mount; later changes from outside (a link renamed by a save, files
//   attached with the button) come through `replace`.
// - `onChange` reports the whole text after the person edits it. It may
//   come late (a visual surface serializes lazily), so the session calls
//   `read()` before it saves for good: flush, lock, leaving the page.
//   A surface whose `onChange` comes late calls `onEditing` at once, so
//   the draft doesn't show as saved meanwhile.
// - The text is the page's exact bytes: a surface keeps what it was given
//   and what was typed, line endings and a missing final newline included.
// - Files pasted or dropped go to `onFiles`, with `place` to put their
//   Markdown where they landed, wherever that is by the time they upload.
//   `place` says whether it could: once the surface has gone (the person
//   switched editors meanwhile), the session adds the Markdown instead.
//   A paste that has text as well as files is the text, uploading nothing,
//   unless the text is only the files' names, as the macOS Finder pastes.
// - A surface reports its last edit before it unmounts.

export type LineBreak = '\r\n' | '\n';

/** The line break most of `markdown`'s lines end with, CRLF or LF: the one text added to it takes. */
export function lineBreakOf(markdown: string): LineBreak {
  const crlf = markdown.split('\r\n').length - 1;
  const lf = markdown.split('\n').length - 1 - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/** The line break text added to `text` takes: its own, or the page's if it has none yet. */
export const lineBreakFor = (text: string, page: LineBreak = '\n') =>
  text.includes('\n') ? lineBreakOf(text) : page;

/** What a surface needs to help with wikilinks, all of it as the session sees it now. */
export type LinkAssist = {
  /** The pages the person can open in the space, or null until the tree loads. */
  pages: readonly LinkablePage[] | null;
  /**
   * The pages a link here may name, as the draft is titled now, or null
   * until the tree loads. Only these are offered after `[[`.
   */
  targets(): ReadonlySet<string> | null;
  /** This page, which `[[#Heading]]` names. */
  selfId: string;
  /** The link table the next save starts from, key → page: the saved one and the picks it will keep. */
  table: ReadonlyMap<string, string>;
  /** A page's headings, from its current version; empty when it can't be opened. */
  headings(pageId: string): Promise<readonly string[]>;
  /** The headings of `markdown`, this page's text as it is now; empty when it can't be read. */
  ownHeadings(markdown: string): Promise<readonly string[]>;
  /**
   * Make a page with this title, next to this one, or null where none can
   * be made. Failures are shown by the session.
   */
  create: ((title: string) => void) | null;
  /**
   * Record that links written `key` mean this page. A page a link here may
   * not name isn't recorded: the link is left as typed, still ambiguous.
   */
  pick(key: string, pageId: string): void;
  /** Ask which page an ambiguous link means. */
  choose(link: { key: string; target: string }): void;
};

/** What a surface needs to show the page's attachments. */
export type AttachmentAssist = {
  /** The page's attachments, as the draft has them now. */
  list: readonly AttachmentRef[];
  /**
   * Those the Attachments panel lists, which the visual editor's picker
   * offers: all of `list` if not given, or all but those something else
   * manages, such as the banner image and the page's icon.
   */
  listed?: readonly AttachmentRef[];
  /** A `blob:` URL of one of them, decrypted here and kept until the vault locks; null if it can't be opened. */
  url(ref: AttachmentRef): Promise<string | null>;
};

export type EditorSurfaceProps = {
  initial: string;
  onChange: (markdown: string) => void;
  /** The person edited, and `onChange` will say so later. */
  onEditing?: () => void;
  links: LinkAssist;
  attachments: AttachmentAssist;
  onFiles: (files: File[], place: (markdown: string) => boolean) => void;
  /** The page's line break, its frontmatter's, for text with none of its own yet; LF if not given. */
  lineBreak?: LineBreak;
  /**
   * The page's properties, as its frontmatter has them now, which its
   * references (`` `=key` ``) show and `` `= `` completes; null for none.
   */
  properties?: readonly PropertyData[] | null | undefined;
  /** The page edited, which plugin blocks are drawn for; none in an editor nobody sees. */
  page?: { spaceId: string; pageId: string };
  ref?: Ref<EditorSurfaceHandle>;
};

export type EditorSurfaceHandle = {
  /** The text as the surface holds it now, read afresh. */
  read(): string;
  /** Show `markdown` instead, keeping the cursor where it can. `onChange` isn't called. */
  replace(markdown: string): void;
  /** Focus it. The source surface puts its cursor `at` that offset in `read()`'s text. */
  focus(at?: number): void;
  /** Where the cursor is, as an offset in `read()`'s text; null if it can't tell. */
  caret?(): number | null;
  /**
   * Put `code` as inline code where the cursor is, in place of what's
   * selected, and focus there, the cursor after it. Reported as an edit.
   */
  insertCode?(code: string): void;
};
