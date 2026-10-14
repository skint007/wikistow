import { parseMarkdown } from '@wikistow/client';
import type { Nodes } from 'mdast';

/**
 * The one node the reader reads `markdown` as, alone or as a paragraph's
 * only child; null if it reads as anything more. What pasted HTML claims as
 * a node's Markdown is taken only if it's just that node.
 */
export function readAlone(markdown: string): Nodes | null {
  let nodes: Nodes[];
  try {
    nodes = parseMarkdown(markdown).children;
  } catch {
    return null;
  }
  const [node] = nodes;
  if (nodes.length !== 1 || !node) return null;
  if (node.type !== 'paragraph') return node;
  const [child] = node.children;
  return node.children.length === 1 && child ? child : null;
}

/**
 * Whether HTML `value` reads as itself after text on a line, as inline
 * HTML; or, `starting` a line with text after it, there. Other HTML is a
 * block of its own (`<div>` and the lines below it), which Markdown can't
 * hold beside other text or in a mark.
 */
export function inlineHtml(value: string, starting = false): boolean {
  let nodes: Nodes[];
  try {
    nodes = parseMarkdown(starting ? `${value}x` : `x${value}`).children;
  } catch {
    return false;
  }
  const [paragraph] = nodes;
  if (nodes.length !== 1 || paragraph?.type !== 'paragraph') return false;
  const [first, second, ...rest] = paragraph.children;
  const [html, text] = starting ? [first, second] : [second, first];
  return html?.type === 'html' && html.value === value && text?.type === 'text' && !rest.length;
}
