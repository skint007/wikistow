import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import {
  inlineMathReading,
  mathReading,
  wikilinkReading,
  type SyntaxReading,
} from '@wikistow/client/reader';
import type { RootContent } from 'mdast';
import type { ComponentType, ReactElement } from 'react';
import type { VisualHost } from './page/editor/visual/host';
import { MathReader } from './page/math';
import { WikilinkReader } from './page/wikilinks';

/*
 * The static extension points the spec asks for. Core features register
 * here instead of being wired into the page directly, so a plugin API can
 * later expose some of them. Nothing is loaded at run time. The page's own
 * panels are with plugins' in `plugins/places.tsx`: History is the first
 * `page.panel`.
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
 * come first, then math; frontmatter is split off before any of it runs (see
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
  // Math, as MathML. Its editor nodes draw it with KaTeX, which they load
  // only once a page shows math.
  markdownSyntax({
    id: 'math',
    ...mathReading,
    Reader: MathReader,
    editorNode: async () => (await import('./page/editor/visual/math-node')).mathEditorNode,
  }),
  markdownSyntax({
    id: 'inline-math',
    ...inlineMathReading,
    Reader: MathReader,
    editorNode: async () => (await import('./page/editor/visual/math-node')).inlineMathEditorNode,
  }),
];
