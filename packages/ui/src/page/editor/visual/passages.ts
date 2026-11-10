import {
  findQuote,
  ownSource,
  parsePropertyReference,
  quoteAt,
  type QuoteText,
} from '@wikistow/client';
import { claimedInline } from '@wikistow/plugin-sdk';
import type { Node } from '@milkdown/kit/prose/model';
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { fencedAsSource, type Passages } from '../../../comments/passages';
import { alertIn } from './alerts';

// Passages in the visual editor (ADR 0014, decision 5): the page's own text
// read from the document, as the reader reads it from what it shows. A
// wikilink, math, a property reference, a claimed span, and a query,
// diagram or plugin block read as their source, whatever the editor draws
// for them.

/** A run of the document, `from` to `to`, at offset `at` in the text; an atom counts whole. */
type Piece = { from: number; to: number; at: number; length: number; atom: boolean };

type OwnText = { text: string; pieces: Piece[] };

/** The page's own text in `doc`, with a line break between blocks. */
export function ownTextOf(doc: Node): OwnText {
  let text = '';
  const pieces: Piece[] = [];
  const separate = () => {
    if (text !== '' && !text.endsWith('\n')) text += '\n';
  };
  const add = (from: number, to: number, piece: string, atom: boolean) => {
    pieces.push({ from, to, at: text.length, length: piece.length, atom });
    text += piece;
  };
  // An alert's marker and the line break after it, which the reader shows
  // as its label, not as text.
  let marker = { from: -1, to: -1 };
  doc.descendants((node, pos) => {
    if (node.type.name === 'blockquote') {
      const alert = alertIn(node);
      if (alert) {
        const from = pos + 2;
        const to = from + alert.length + (alert.next?.type.name === 'hardbreak' ? 1 : 0);
        marker = { from, to };
      }
    }
    if (node.type.name === 'math_block') {
      separate();
      add(pos, pos + node.nodeSize, ownSource.math(String(node.attrs['value']), true), true);
      separate();
      return false;
    }
    if (!node.isTextblock) {
      if (node.isBlock) separate();
      return true;
    }
    separate();
    if (node.type.spec.code) {
      const language = String(node.attrs['language'] ?? '');
      if (fencedAsSource(language)) {
        add(pos, pos + node.nodeSize, ownSource.fence(language, node.textContent), true);
      } else {
        add(pos + 1, pos + 1 + node.content.size, node.textContent, false);
      }
      return false;
    }
    // Inline code in one run, which a reference or a claimed span is as a whole.
    let code: { from: number; to: number; text: string } | null = null;
    const endCode = () => {
      if (!code) return;
      const { from, to, text: value } = code;
      code = null;
      if (parsePropertyReference(value) || claimedInline(value))
        add(from, to, ownSource.inlineCode(value), true);
      else add(from, to, value.replace(/[\n\r\t]/g, ' '), false);
    };
    node.forEach((whole, offset) => {
      const start = pos + 1 + offset;
      const end = start + whole.nodeSize;
      const inMarker = start < marker.to && end > marker.from;
      if (inMarker && (!whole.isText || end <= marker.to)) return;
      // Text going on after the marker, in the same node, from there.
      const at = inMarker ? marker.to : start;
      const child = inMarker ? whole.cut(marker.to - start) : whole;
      if (child.isText && child.marks.some((m) => m.type.name === 'inlineCode')) {
        if (code && code.to === at) {
          code.to = end;
          code.text += child.text!;
        } else {
          endCode();
          code = { from: at, to: end, text: child.text! };
        }
        return;
      }
      endCode();
      if (child.isText) add(at, end, child.text!.replace(/[\n\r\t]/g, ' '), false);
      // A soft line break (`isInline`) shows as the space the reader shows.
      else if (child.type.name === 'hardbreak')
        add(at, end, child.attrs['isInline'] ? ' ' : '\n', true);
      // A `<br>` written as HTML, as in a table's cell, breaks the line as the reader shows it.
      else if (child.type.name === 'html' && /^<br\s*\/?>$/i.test(String(child.attrs['value'])))
        add(at, end, '\n', true);
      else if (child.type.name === 'math_inline')
        add(at, end, ownSource.math(String(child.attrs['value']), false), true);
      else if (typeof child.attrs['source'] === 'string')
        // A wikilink, an embed or a claimed span, as written.
        add(at, end, child.attrs['source'], true);
    });
    endCode();
    return false;
  });
  return { text, pieces };
}

/** Where the selection `from` to `to` is in the text; an atom it touches counts whole. */
function offsetsOf({ pieces }: OwnText, from: number, to: number) {
  let start: number | null = null;
  let end = 0;
  for (const piece of pieces) {
    if (piece.to <= from || piece.from >= to) continue;
    start ??= piece.atom ? piece.at : piece.at + Math.max(0, from - piece.from);
    end = piece.atom ? piece.at + piece.length : piece.at + Math.min(piece.length, to - piece.from);
  }
  return start === null ? null : { from: start, to: end };
}

/** The document positions of `from` to `to` in the text. */
function positionsOf({ pieces }: OwnText, from: number, to: number) {
  const first = pieces.find((p) => p.at + p.length > from);
  const last = pieces.findLast((p) => p.at < to);
  if (!first || !last) return null;
  return {
    from: first.atom ? first.from : first.from + Math.max(0, from - first.at),
    to: last.atom ? last.to : last.from + Math.min(last.length, to - last.at),
  };
}

/** Passages in the visual editor `view()`, while it's there. */
export function visualPassages(view: () => EditorView | null): Passages {
  const found = (quote: QuoteText) => {
    const editor = view();
    if (!editor) return undefined;
    const own = ownTextOf(editor.state.doc);
    const match = findQuote(own.text, quote);
    return { editor, match: match && positionsOf(own, match.from, match.to), at: match?.from };
  };
  return {
    root: () => view()?.dom ?? null,
    quote() {
      const editor = view();
      if (!editor) return null;
      const { selection } = editor.state;
      // A wikilink or math chosen as a whole, as by an arrow key onto it, isn't text selected.
      if (selection.empty || selection instanceof NodeSelection) return null;
      const { from, to } = selection;
      const own = ownTextOf(editor.state.doc);
      const offsets = offsetsOf(own, from, to);
      return offsets ? quoteAt(own.text, offsets.from, offsets.to) : null;
    },
    find: (quote) => {
      const passage = found(quote);
      return passage ? (passage.at ?? null) : undefined;
    },
    show(quote) {
      const passage = found(quote);
      if (!passage?.match) return false;
      const { editor, match } = passage;
      editor.focus();
      editor.dispatch(
        editor.state.tr
          .setSelection(TextSelection.create(editor.state.doc, match.from, match.to))
          .scrollIntoView(),
      );
      return true;
    },
  };
}
