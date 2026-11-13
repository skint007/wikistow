import { ParserReady, parserCtx, remarkCtx, schemaCtx } from '@milkdown/kit/core';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import type { Node, Schema } from '@milkdown/kit/prose/model';
import { ParserState, type MarkdownNode, type RemarkParser } from '@milkdown/kit/transformer';
import type { Root } from 'mdast';

// Where each top-level block of a document was read from (ADR 0015
// decision 3, step 2), so a block nobody edited is written back as its
// source, not in the editor's style.

/** Where a top-level block is in a text: from its first character to just after its last. */
export type Span = { readonly from: number; readonly to: number };

/**
 * A document and the page text it holds, with where each of its top-level
 * blocks is in that text, in order; null for one whose place can't be told,
 * which is written in the editor's style. Text between blocks is the page's
 * own.
 */
export type Source = {
  readonly doc: Node;
  readonly text: string;
  readonly spans: readonly (Span | null)[];
};

// The spans each document read has in the LF text it was read from.
const read = new WeakMap<Node, readonly (Span | null)[]>();

/**
 * Where each top-level block of `doc`, as the editor's parser read it
 * (`readingSpans`), is in the text it was read from; null if it wasn't read
 * so, or its blocks can't be told apart from what was read, as a document
 * the parser filled with an empty paragraph.
 */
export const spansOf = (doc: Node): readonly (Span | null)[] | null => read.get(doc) ?? null;

// Where the line `at` is on starts, if only spaces and tabs are before it
// there, else `at`: a block's place starts after the spaces it's indented
// by, which are part of what it says, as a fence's indent is taken off
// its lines.
function lineStart(markdown: string, at: number): number {
  let from = at;
  while (from > 0 && (markdown[from - 1] === ' ' || markdown[from - 1] === '\t')) from--;
  return from === 0 || markdown[from - 1] === '\n' ? from : at;
}

/**
 * Milkdown's reading of Markdown, as the editor's own parser does it, noting
 * where each top-level block came from: a node of the tree read makes most
 * often one block, whose span is its position. One that makes none leaves
 * its text between blocks; one that makes more, or has no position, gives
 * them none.
 */
function reading(schema: Schema, remark: RemarkParser) {
  return (markdown: string): Node => {
    const tree = remark.runSync(remark.parse(markdown), markdown) as Root;
    const state = new ParserState(schema);
    // As the document's own runner does (`injectRoot`), a child at a time.
    state.openNode(schema.topNodeType);
    const spans: (Span | null)[] = [];
    for (const child of tree.children) {
      const before = state.top()?.content.length ?? 0;
      state.next(child as MarkdownNode);
      const made = (state.top()?.content.length ?? 0) - before;
      const { start, end } = child.position ?? {};
      const span =
        made === 1 && start?.offset !== undefined && end?.offset !== undefined
          ? { from: lineStart(markdown, start.offset), to: end.offset }
          : null;
      for (let i = 0; i < made; i++) spans.push(span);
    }
    const doc = state.toDoc();
    if (doc.childCount === spans.length && spans.length > 0) read.set(doc, spans);
    return doc;
  };
}

/** The editor's parser, as it reads, noting each document's spans (`spansOf`). */
export const readingSpans: MilkdownPlugin = (ctx) => async () => {
  await ctx.wait(ParserReady);
  ctx.set(parserCtx, reading(ctx.get(schemaCtx), ctx.get(remarkCtx)));
};

/**
 * `spans`, in increasing order, from places in `withLf(text)` to the same
 * places in `text`: each CRLF is one character there, and two here.
 */
export function inText(text: string, spans: readonly (Span | null)[]): (Span | null)[] {
  // Where each CRLF is, as a place in the LF text.
  const pairs: number[] = [];
  for (let at = text.indexOf('\r\n'); at >= 0; at = text.indexOf('\r\n', at + 2))
    pairs.push(at - pairs.length);
  let k = 0;
  const place = (lf: number) => {
    while (k < pairs.length && (pairs[k] ?? Infinity) < lf) k++;
    return lf + k;
  };
  return spans.map((span) => span && { from: place(span.from), to: place(span.to) });
}

/** Where `lf`, a place in `withLf(text)`, is in `text`. */
export function rawPlace(text: string, lf: number): number {
  let at = 0;
  for (let seen = 0; seen < lf && at < text.length; seen++)
    at += text.startsWith('\r\n', at) ? 2 : 1;
  return at;
}
