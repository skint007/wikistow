import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import type { ClientContext, pageOperations, RevisionId } from '@wikistow/client';
import { wikilinkReading, type SyntaxReading } from '@wikistow/client/reader';
import { History, type LucideIcon } from 'lucide-react';
import type { RootContent } from 'mdast';
import type { ComponentType, ReactElement } from 'react';
import type { VisualHost } from './page/editor/visual/host';
import { HistorySheet } from './page/history-sheet';
import { WikilinkReader } from './page/wikilinks';

/*
 * The static extension points the spec asks for. Core features register
 * here instead of being wired into the page directly, so a plugin API can
 * later expose some of them. Nothing is loaded at run time.
 */

/**
 * A Markdown syntax beyond GitHub's: the remark plugins that read it into
 * `type` nodes and write those back (its `SyntaxReading`, which the
 * reader's worker loads without React), and how each view shows a node.
 */
export type MarkdownSyntax = SyntaxReading & {
  id: string;
  /** Shows one of its nodes in a page body, inside the reader's page context. */
  render: (node: RootContent) => ReactElement | null;
  /**
   * Its node in the visual editor, with its view: Milkdown plugins, loaded
   * with that editor. A body holding a node type no syntax has stays in
   * source mode.
   */
  editorNode: () => Promise<(host: VisualHost) => MilkdownPlugin[]>;
};

/** A syntax whose `type` nodes `Reader` shows. */
function markdownSyntax<Type extends RootContent['type']>({
  Reader,
  ...syntax
}: Omit<MarkdownSyntax, 'type' | 'render'> & {
  type: Type;
  Reader: ComponentType<{ node: Extract<RootContent, { type: Type }> }>;
}): MarkdownSyntax {
  const owns = (node: RootContent): node is Extract<RootContent, { type: Type }> =>
    node.type === syntax.type;
  return { ...syntax, render: (node) => (owns(node) ? <Reader node={node} /> : null) };
}

/**
 * Syntax every page body is read with. Wikilinks and attachment embeds
 * come first; frontmatter is split off before any of it runs (see
 * `splitFrontmatter`), and shown by the reader's Properties box. Each
 * one's reading is listed in `syntaxReadings` too
 * (packages/client/src/reader/reading.ts), which the reader's worker reads
 * with, without React.
 */
export const markdownSyntaxes: readonly MarkdownSyntax[] = [
  markdownSyntax({
    id: 'wikilink',
    ...wikilinkReading,
    Reader: WikilinkReader,
    // With the editor itself, in one chunk.
    editorNode: async () =>
      (await import('./page/editor/visual/visual-surface')).wikilinkEditorNode,
  }),
];

/** What a page tells each of its panels. */
export type PagePanelProps = {
  ctx: ClientContext;
  page: pageOperations.PageRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The person can change the page: an editor, on a page with a draft. */
  editor: boolean;
  /** The publication shown, or null in the draft view. */
  published: RevisionId | null;
  /** In the draft view: save what's typed, and open the draft afresh. */
  draft: { flush: () => Promise<void>; reopen: () => Promise<void> } | null;
};

/** A panel a page opens from its toolbar. */
export type PagePanel = {
  id: string;
  label: string;
  icon: LucideIcon;
  Panel: ComponentType<PagePanelProps>;
};

export const pagePanels: readonly PagePanel[] = [
  {
    id: 'history',
    label: 'History',
    icon: History,
    Panel: ({ editor, published, draft, ...props }) => (
      <HistorySheet
        {...props}
        canRestore={editor}
        showing={published}
        beforeRestore={draft?.flush}
        onRestored={draft?.reopen}
      />
    ),
  },
];
