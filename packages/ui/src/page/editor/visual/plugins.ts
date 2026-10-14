import { inTableCell, parseWikilink, type WikilinkNode } from '@wikistow/client';
import { parserCtx, schemaCtx, serializerCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { keymap } from '@milkdown/kit/prose/keymap';
import {
  DOMSerializer,
  Fragment,
  type DOMOutputSpec,
  Mark,
  Slice,
  type MarkType,
  type Node,
  type ResolvedPos,
  type Schema,
} from '@milkdown/kit/prose/model';
import {
  NodeSelection,
  Plugin,
  PluginKey,
  type SelectionBookmark,
  TextSelection,
  type Transaction,
} from '@milkdown/kit/prose/state';
import { AddMarkStep, canSplit, dropPoint, RemoveMarkStep } from '@milkdown/kit/prose/transform';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { normalizeIdentifier } from 'micromark-util-normalize-identifier';
import { pastedFiles } from '../pasted-files';
import type { EditorSurfaceProps } from '../surface';
import { fromAnotherTab, MARKDOWN_MARK, markOf } from './copy-marks';
import { BLOCK_TIMED, checkFidelity, fidelityOf, withLf } from './fidelity';
import type { VisualHost } from './host';
import { addressOf, ATOM, literalLinks } from './literals';
import { unstyled } from './pasted-html';
import { inlineHtml } from './read-alone';
import { COPIED, copiedLinkId, linkId } from './schema';
import { ambiguity } from './wikilink-node';
import type { Writer } from './writer';

/** Meta on a change the session made (`replace`), which isn't reported as an edit. */
export const EXTERNAL = 'wikistow-external';

const edits = new PluginKey<number>('wikistow-edits');

/** `edited` runs after each change the person made, not the session. */
export const reportEdits = (edited: () => void) =>
  $prose(() => {
    let seen = 0;
    return new Plugin<number>({
      key: edits,
      state: {
        init: () => 0,
        // Changes plugins add to one the session made aren't the person's either.
        apply: (tr, count) => {
          const made: Transaction = tr.getMeta('appendedTransaction') ?? tr;
          return tr.docChanged && !made.getMeta(EXTERNAL) ? count + 1 : count;
        },
      },
      view: () => ({
        update(view) {
          const count = edits.getState(view.state) ?? 0;
          if (count === seen) return;
          seen = count;
          edited();
        },
      }),
    });
  });

/** `markdown` as the editor's content, open at both ends so a paragraph's text joins the one it lands in. */
export function sliceOf(ctx: Ctx, markdown: string): Slice | null {
  try {
    const doc = ctx.get(parserCtx)(withLf(markdown));
    return Slice.maxOpen(doc.content);
  } catch {
    return null;
  }
}

// `spec`, as a node's `toDOM` gives it, marked as this tab's (`COPIED`) if
// written with attributes: pasted HTML keeps its data attributes only so
// marked (`unstyled`).
function copied(spec: DOMOutputSpec): DOMOutputSpec {
  if (!Array.isArray(spec)) return spec;
  const [tag, attrs, ...rest] = spec;
  const written = typeof attrs === 'object' && attrs !== null && !Array.isArray(attrs);
  return written && !(attrs instanceof globalThis.Node)
    ? [tag, { ...attrs, ...COPIED }, ...rest]
    : spec;
}

// HTML copied, each node marked as this tab's (`copied`), and each link
// with its `id` (`data-link`), not shown otherwise: ProseMirror writes a
// link that a mark starts or ends inside as an `<a>` each side of the
// mark's edge, which are then pasted as one (`pastedLinks`). The id carries
// this tab's own token, so HTML from anywhere else, or another tab, can't
// claim one.
function copying(schema: Schema): DOMSerializer {
  const { nodes, marks } = DOMSerializer.fromSchema(schema);
  const marked = Object.fromEntries(
    Object.entries(nodes).map(([name, toDOM]) => [name, (node: Node) => copied(toDOM(node))]),
  );
  const { link } = marks;
  if (!link) return new DOMSerializer(marked, marks);
  return new DOMSerializer(marked, {
    ...marks,
    link: (mark, inline) => {
      const [tag, attrs] = link(mark, inline) as [string, Record<string, unknown>];
      const { id } = mark.attrs;
      return [tag, id === null ? attrs : { ...attrs, 'data-link': copiedLinkId(id) }];
    },
  });
}

// Whether a drop copies what's dragged in the page rather than moving it:
// with Ctrl held, or Alt on a Mac. ProseMirror decides so too, as it's
// given this (`dragCopies`).
const MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|[ao]d)/.test(navigator.platform);
const copies = (event: DragEvent) => (MAC ? event.altKey : event.ctrlKey);

/**
 * Each of `kept`, a place in the document kept for each version of it,
 * moved by `map` into the one `tr` makes from the one before. A change
 * only tried out (`markdownPaste`) makes a version of its own, never
 * shown, so it moves nothing in the one that is.
 */
function mapKept<T>(kept: Set<WeakMap<Node, T>>, tr: Transaction, map: (place: T) => T) {
  for (const versions of kept) {
    const place = versions.get(tr.before);
    if (place !== undefined) versions.set(tr.doc, tr.docChanged ? map(place) : place);
  }
}

// `slice` dropped near `at`, where ProseMirror would drop it (`dropPoint`),
// and selected, as ProseMirror's own drop does.
function dropIn(tr: Transaction, at: number, slice: Slice): Transaction {
  const from = dropPoint(tr.doc, at, slice) ?? at;
  tr.replaceRange(from, from, slice);
  return tr.setSelection(
    TextSelection.between(tr.doc.resolve(from), tr.doc.resolve(tr.mapping.map(from))),
  );
}

/** Upload `files` and put them in at the cursor, in place of any selection, as pasted ones go. */
export type Upload = (files: File[]) => void;

/**
 * Files pasted or dropped go to `onFiles`, and their Markdown in where they
 * landed once they're uploaded, moved along with edits made meanwhile; so
 * do files chosen elsewhere, at the cursor, by the `Upload` given to
 * `uploads` once the editor's made (null as it goes). A paste with text
 * as well is text, unless the text is only their names
 * (`pastedFiles`). Text pasted alone is read as Markdown, as the visual
 * editor reads a page, unless it holds what the editor would change, or
 * would write otherwise where it lands, as `writer` finds, reading again
 * only the blocks it changes and those beside them, even on a page not
 * yet read back: then it goes in as the plain text it is. Text that may be
 * slow to read is checked as a page is, in the check's worker, and goes in
 * once it's read (`checkedPaste`, `checkedDrop`). Rich text pasted
 * goes through the editor's schema, without its styles (`unstyled`), which
 * keeps only what a page can hold; HTML that gives nothing, as when it
 * can't be read, pasted or dropped, goes in as its text. A copy or drag
 * another of this browser's WikiStow tabs marked as Markdown
 * (`fromAnotherTab`), pasted or dropped, is read as that Markdown instead, as this tab keeps the data attributes,
 * which say what's an image or footnote, only of HTML it copied itself
 * (`unstyled`); where that Markdown can't go in, it's read as it would be
 * unmarked, as its HTML. A footnote pasted under a label the page has
 * already is given a free one (`freshFootnotes`).
 */
export const pasting = (
  onFiles: () => EditorSurfaceProps['onFiles'],
  writer: () => Writer | null,
  uploads?: (upload: Upload | null) => void,
) =>
  $prose((ctx) => {
    // Where files uploading and text dropped being checked go
    // (`checkedDrop`), and the selections text pasted being checked goes in
    // place of (`checkedPaste`), each kept for every document it's in
    // (`mapKept`).
    const spots = new Set<WeakMap<Node, number>>();
    const selections = new Set<WeakMap<Node, SelectionBookmark>>();
    let destroyed = false;
    // The last drop: ProseMirror takes in what it brings before it decides
    // whether it's a move, which `copies` then says as it will.
    let dropped: DragEvent | null = null;
    // The Markdown the copy being written has as its text, if it has.
    let copiedMarkdown: string | null = null;

    const upload = (view: EditorView, files: File[], from: number) => {
      const spot = new WeakMap([[view.state.doc, from]]);
      spots.add(spot);
      onFiles()(files, (markdown) => {
        spots.delete(spot);
        // Gone, as when the person switched editors: Milkdown destroys its
        // view a moment after it leaves the page.
        if (destroyed || !view.dom.isConnected) return false;
        const slice = sliceOf(ctx, markdown);
        const { state } = view;
        const at = spot.get(state.doc);
        if (!slice || at === undefined) return false;
        const { selection } = state;
        const waiting = selection.empty && selection.from === at;
        // Somewhere the files can't go, such as a code block, they go nearby.
        const tr = state.tr.replaceRange(at, at, slice);
        if (waiting) tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(at))));
        view.dispatch(tr.scrollIntoView());
        return true;
      });
    };
    // Files in place of the selection, as pasted.
    const uploadHere = (view: EditorView, files: File[]) => {
      view.dispatch(view.state.tr.deleteSelection());
      upload(view, files, view.state.selection.from);
    };

    // Text pasted as Markdown, in place of the selection, or dropped at
    // `at`, where ProseMirror would drop it (`dropPoint`), and selected, if
    // the editor keeps it whole (`kept`, as its check found) and the blocks
    // it changes, with those beside them, still write back as they show,
    // read back now whether or not the rest of the page has been.
    const markdownPaste = (view: EditorView, text: string, kept: boolean, at?: number) => {
      const write = writer();
      if (!write || !kept) return null;
      const slice = sliceOf(ctx, text);
      if (!slice) return null;
      const { doc, tr } = view.state;
      const fresh = freshFootnotes(slice, doc);
      if (at === undefined) tr.replaceSelection(fresh);
      else dropIn(tr, at, fresh);
      return write.check(view.state.apply(tr).doc, doc) ? tr : null;
    };

    // Whether the editor keeps `text` whole, checked on the page's thread.
    const keptHere = (text: string) =>
      fidelityOf(text, { parse: ctx.get(parserCtx), serialize: ctx.get(serializerCtx) }).visual;

    // Whether the editor keeps `text`, which may be slow to read
    // (`BLOCK_TIMED`), whole, checked first as a page is, its reads in the
    // check's worker (`checkFidelity`).
    const keptChecked = (text: string) =>
      checkFidelity(text)
        .then((fidelity) => fidelity.visual)
        .catch(() => false);

    // Text pasted as Markdown that may be slow to read, put where it was
    // pasted once it's checked (`keptChecked`): as Markdown if it can be,
    // else as `html` would be, or as its text.
    const checkedPaste = (view: EditorView, text: string, html: string) => {
      const held = new WeakMap([[view.state.doc, view.state.selection.getBookmark()]]);
      selections.add(held);
      void keptChecked(text).then((kept) => {
        selections.delete(held);
        const { doc, tr } = view.state;
        const bookmark = held.get(doc);
        if (destroyed || !view.dom.isConnected || !bookmark) return;
        view.dispatch(tr.setSelection(bookmark.resolve(doc)));
        const pasted = markdownPaste(view, text, kept);
        if (pasted) view.dispatch(pasted.scrollIntoView());
        else if (html) view.pasteHTML(html);
        else view.pasteText(text);
      });
    };

    // Markdown another tab dragged that may be slow to read, dropped at
    // `at` once it's checked (`keptChecked`): as Markdown if it can be, else
    // as ProseMirror read its HTML (`slice`).
    const checkedDrop = (view: EditorView, text: string, at: number, slice: Slice) => {
      const spot = new WeakMap([[view.state.doc, at]]);
      spots.add(spot);
      void keptChecked(text).then((kept) => {
        spots.delete(spot);
        const { doc, tr } = view.state;
        const where = spot.get(doc);
        if (destroyed || !view.dom.isConnected || where === undefined) return;
        const dropped = markdownPaste(view, text, kept, where) ?? dropIn(tr, where, slice);
        view.focus();
        view.dispatch(dropped.scrollIntoView());
      });
    };

    return new Plugin({
      state: {
        init: () => null,
        apply(tr) {
          mapKept(spots, tr, (at) => tr.mapping.map(at, -1));
          mapKept(selections, tr, (bookmark) => bookmark.map(tr.mapping));
          return null;
        },
      },
      props: {
        // HTML that can't be read gives nothing, so its text goes in. Thrown
        // out of here, the browser would paste the HTML itself.
        transformPastedHTML: (html) => {
          try {
            return unstyled(html) ?? '';
          } catch {
            return '';
          }
        },
        clipboardSerializer: copying(ctx.get(schemaCtx)),
        dragCopies: copies,
        handleDOMEvents: {
          drop: (_view, event) => {
            dropped = event;
            return false;
          },
        },
        // Not a move within the page, whose links and footnotes are its own.
        transformPasted: (slice, view) => {
          const moved = !!view.dragging && !!dropped && !copies(dropped);
          const linked = pastedLinks(slice, moved);
          return moved ? linked : freshFootnotes(linked, view.state.doc);
        },
        handlePaste(view, event, slice) {
          const data = event.clipboardData;
          const files = pastedFiles(data);
          if (files.length > 0) {
            uploadHere(view, files);
            return true;
          }
          const text = data?.getData('text/plain') ?? '';
          const html = data?.getData('text/html') ?? '';
          const markdown = !view.state.selection.$from.parent.type.spec.code && text;
          // Markdown another of this browser's WikiStow tabs copied, whose
          // HTML this one can't vouch for, is read as the Markdown it is;
          // if it can't go in, the HTML is read, as it would be unmarked.
          const plain = !html || (!!markdown && !!data && fromAnotherTab(data));
          if (markdown && plain && markdown.length >= BLOCK_TIMED) {
            checkedPaste(view, markdown, html);
            return true;
          }
          const tr = markdown && plain ? markdownPaste(view, markdown, keptHere(markdown)) : null;
          if (tr) view.dispatch(tr.scrollIntoView());
          if (tr || !html) return tr !== null;
          if (slice.size > 0) return false;
          // HTML that gives nothing, as when it can't be read (`unstyled`), goes in as its text.
          view.pasteText(text);
          return true;
        },
        handleDrop(view, event, slice, moved) {
          const data = event.dataTransfer;
          const files = Array.from(data?.files ?? []);
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
          const pos = at?.pos ?? view.state.selection.from;
          // Markdown another of this browser's WikiStow tabs dragged, read
          // as it is when pasted; if it can't go in, the HTML is read. A
          // drag within the page is ProseMirror's to move or copy.
          const $pos = view.state.doc.resolve(pos);
          const marked = !view.dragging && !!data && fromAnotherTab(data);
          if (files.length === 0 && data && marked && !$pos.parent.type.spec.code) {
            const markdown = data.getData('text/plain');
            if (markdown.length >= BLOCK_TIMED) {
              checkedDrop(view, markdown, pos, slice);
              return true;
            }
            const tr = markdownPaste(view, markdown, keptHere(markdown), pos);
            if (tr) {
              view.focus();
              view.dispatch(tr.scrollIntoView());
              return true;
            }
          }
          // HTML that gives nothing goes in as its text, as when it's pasted.
          const plain = !moved && !!data?.getData('text/html') && slice.size === 0;
          if (files.length === 0 && !plain) return false;
          event.preventDefault();
          if (files.length > 0) upload(view, files, pos);
          else {
            const { doc, tr } = view.state;
            view.dispatch(tr.setSelection(TextSelection.near(doc.resolve(pos))));
            view.pasteText(data?.getData('text/plain') ?? '');
          }
          return true;
        },
        // Copied text is Markdown, as a page writes it; plain text alone is
        // just its text, as is what starts inside a list item, quote or
        // cell, deeper than a block of its own. What's Markdown is noted
        // (`copiedMarkdown`), for the copy to be marked so.
        clipboardTextSerializer(slice) {
          const { content } = slice;
          const plainText = () => content.textBetween(0, content.size, '\n\n');
          copiedMarkdown = null;
          const block = content.childCount === 1 ? content.firstChild : null;
          let plain = block?.isTextblock === true;
          block?.forEach((node) => {
            if (!node.isText || node.marks.length > 0) plain = false;
          });
          if (plain || slice.openStart > 1) return plainText();
          // An atom selected alone, as an image, is in a paragraph of its own.
          const schema = ctx.get(schemaCtx);
          const paragraph = schema.nodes['paragraph'];
          const blocks =
            content.firstChild?.isInline && paragraph
              ? Fragment.from(paragraph.create(null, content))
              : content;
          const doc = schema.topNodeType.createAndFill(undefined, blocks);
          if (!doc) return plainText();
          copiedMarkdown = ctx.get(serializerCtx)(doc);
          return copiedMarkdown;
        },
      },
      view: (view) => {
        // After ProseMirror has written a copy or a drag's data, which
        // clears what was there first, it's marked as Markdown if it is
        // (`markOf`). ProseMirror's own listeners are added before any
        // plugin's view.
        const markData = (data: DataTransfer | null) => {
          const text = copiedMarkdown;
          copiedMarkdown = null;
          if (!data || text === null || data.getData('text/plain') !== text) return;
          const marked = markOf(text);
          if (marked) data.setData(MARKDOWN_MARK, marked);
        };
        const mark = (event: ClipboardEvent) => markData(event.clipboardData);
        const markDrag = (event: DragEvent) => markData(event.dataTransfer);
        view.dom.addEventListener('copy', mark);
        view.dom.addEventListener('cut', mark);
        view.dom.addEventListener('dragstart', markDrag);
        uploads?.((files) => uploadHere(view, files));
        return {
          destroy() {
            destroyed = true;
            uploads?.(null);
            view.dom.removeEventListener('copy', mark);
            view.dom.removeEventListener('cut', mark);
            view.dom.removeEventListener('dragstart', markDrag);
          },
        };
      },
    });
  });

// `content` with each link of the page's own in it as `pastedLinks` takes it.
function relinked(content: Fragment, moved: boolean): Fragment {
  const first = content.firstChild;
  const type = first?.type.schema.marks['link'];
  if (!first || !type) return content;
  if (!first.isInline) {
    const nodes: Node[] = [];
    content.forEach((node) => nodes.push(node.copy(relinked(node.content, moved))));
    return Fragment.from(nodes);
  }
  const links = ownLinks(content, 0, type, true)
    // Moved whole, it's as it was; so is an autolink moved, which GFM reads again.
    .filter(({ link, text }) => !moved || (!link.attrs['auto'] && text !== link.attrs['read']))
    .map((span) => ({
      ...span,
      next: type.create(
        span.link.attrs['auto']
          ? { ...span.link.attrs, id: linkId() }
          : { ...span.link.attrs, read: span.text, id: linkId() },
      ),
    }));
  const nodes: Node[] = [];
  content.forEach((node, at) => {
    const span = links.find(({ from, to }) => from <= at && at < to);
    nodes.push(span ? node.mark(span.next.addToSet(type.removeFromSet(node.marks))) : node);
  });
  return Fragment.from(nodes);
}

/**
 * `slice`, pasted or dropped, with each link of the page's own in it,
 * other than one moved whole, a link of its own (a new `id`), read with
 * its text: the pieces of one copied here are one (`copying`), and other
 * `<a>` side by side stay apart. It keeps where it goes, as in source
 * mode; if its text is an address, it follows that text once it's edited,
 * as one read from a page does (`follow`). A `read` the HTML claims isn't
 * taken.
 */
export const pastedLinks = (slice: Slice, moved = false) =>
  new Slice(relinked(slice.content, moved), slice.openStart, slice.openEnd);

// A wikilink written out in text, as `[[…]]` typed or pasted as rich text.
const WRITTEN = /!?\[\[[^[\]\n]+\]\]/g;

/** Whether text at `pos` in `doc` may hold a wikilink: not in code. */
function linkable(doc: Node, pos: number, node: Node) {
  return !doc.resolve(pos).parent.type.spec.code && !node.marks.some((m) => m.type.spec.code);
}

/**
 * Text that becomes a wikilink once it's written out whole (`[[Page]]`
 * typed, or in pasted rich text) turns into its atom, which writes it back
 * as it is. Left as text, Markdown would escape its brackets. Only brackets
 * the change wrote make one: text already whole, as escaped brackets read
 * from the page are, stays text.
 */
export const typedLinks = $prose(
  (ctx) =>
    new Plugin({
      appendTransaction(trs, _old, state) {
        if (!trs.some((tr) => tr.docChanged && !tr.getMeta(EXTERNAL))) return null;
        const type = ctx.get(schemaCtx).nodes['wikilink'];
        if (!type) return null;
        const found: { from: number; to: number; link: WikilinkNode }[] = [];
        const touched = changedRange(trs);
        state.doc.nodesBetween(
          Math.max(0, touched.from - 1),
          Math.min(state.doc.content.size, touched.to + 1),
          (node, pos) => {
            if (!node.isText || !node.text?.includes('[[') || !linkable(state.doc, pos, node))
              return;
            for (const match of node.text.matchAll(WRITTEN)) {
              const from = pos + match.index;
              const to = from + match[0].length;
              const opening = from + match[0].indexOf('[[') + 2;
              const link = parseWikilink(match[0]);
              if (link && (wrote(touched, from, opening) || wrote(touched, to - 2, to)))
                found.push({ from, to, link });
            }
          },
        );
        if (found.length === 0) return null;
        const tr = state.tr;
        for (const { from, to, link } of found.reverse())
          tr.replaceWith(from, to, type.create({ source: link.source }));
        return tr;
      },
    }),
);

/**
 * Text GFM reads as a link, an autolink literal (`https://…`, `www.…`, an
 * email), is one: typed, pasted, dropped or edited, wherever the reader
 * would link it, as it does whatever escapes it's written with. It goes
 * where GFM says, and is `auto`, so it follows its text: a letter typed
 * inside or beside it moves or ends it as GFM would. Not in code or in a
 * link of the page's own, which keeps what it covers (`follow`).
 */
export const autolinks = $prose(
  () =>
    new Plugin({
      appendTransaction(trs, _old, state) {
        const type = state.schema.marks['link'];
        if (!type || !trs.some((tr) => tr.docChanged && !tr.getMeta(EXTERNAL))) return null;
        const changed = changedRanges(trs, true);
        const { from, to } = hull(changed);
        const tr = state.tr;
        const end = Math.min(to + 1, state.doc.content.size);
        state.doc.nodesBetween(Math.max(0, from - 1), end, (block, pos) => {
          if (!block.isTextblock) return true;
          if (block.type.spec.code) return false;
          follow(tr, block, pos + 1, type, changed);
          // As left, with text a link no longer is (this isn't run again
          // on what it adds).
          relink(tr, tr.doc.nodeAt(pos) ?? block, pos + 1, type);
          return false;
        });
        return tr.docChanged ? tr : null;
      },
    }),
);

type Span = { link: Mark; from: number; to: number; text: string };

// The links of the page's own in `nodes`, the first at `start`, each over
// its text, an atom as one character, across any other marks in it; with
// `autolinks`, those made of text too.
function ownLinks(nodes: Fragment, start: number, type: MarkType, autolinks = false): Span[] {
  const spans: Span[] = [];
  nodes.forEach((node, at) => {
    const link = type.isInSet(node.marks);
    if (!link || (link.attrs['auto'] && !autolinks)) return;
    const text = node.text ?? ATOM;
    const last = spans.at(-1);
    if (last?.to === start + at && last.link.eq(link))
      [last.to, last.text] = [last.to + node.nodeSize, last.text + text];
    else spans.push({ link, from: start + at, to: start + at + node.nodeSize, text });
  });
  return spans;
}

// Each link of the page's own in `block`, at `start`, that the change
// touched, its text read from the page an address (`addressOf`) and edited
// since, going where its text now says, over just that text: text showing
// one address while going to another is a deceptive link's shape. One
// whose text now says nowhere is text. Other links keep where they go, as
// does one with an atom in its text, which no address has.
function follow(
  tr: Transaction,
  block: Node,
  start: number,
  type: MarkType,
  changed: readonly Range[],
) {
  for (const { link, from, to, text } of ownLinks(block.content, start, type)) {
    const { href, read } = link.attrs;
    if (!changed.some((range) => range.from <= to && range.to >= from)) continue;
    if (typeof read !== 'string' || text === read || text.includes(ATOM)) continue;
    if (addressOf(read) === null) continue;
    const address = addressOf(text);
    if (address === href) continue;
    tr.removeMark(from, to, link);
    if (address !== null)
      tr.addMark(from, to, type.create({ ...link.attrs, href: address, read: text }));
  }
}

type Piece = { node: Node; at: number; link: Mark | undefined; base: readonly Mark[] };

// `items` in runs of those next to each other that are `alike`.
function runs<T>(items: readonly T[], alike: (a: T, b: T) => boolean): T[][] {
  const found: T[][] = [];
  for (const item of items) {
    const run = found.at(-1);
    const last = run?.at(-1);
    if (run && last !== undefined && alike(last, item)) run.push(item);
    else found.push([item]);
  }
  return found;
}

const textOf = (run: readonly Piece[]) => run.map(({ node }) => node.text).join('');

// The autolinks in `block`, at `start`, put where GFM reads them in each
// run of text with the same marks, which the reader reads as one text,
// each with an `id` of its own, so two going the same way stay two.
function relink(tr: Transaction, block: Node, start: number, type: MarkType) {
  const pieces: (Piece | null)[] = [];
  block.forEach((node, at) => {
    const link = type.isInSet(node.marks);
    const base = link ? link.removeFromSet(node.marks) : node.marks;
    const code = node.marks.some((mark) => mark.type.spec.code);
    pieces.push(node.isText && !code ? { node, at: start + at, link, base } : null);
  });
  // A link of the page's own isn't one, even one GFM would read so: only
  // one made of text, with the same marks throughout, is.
  const own = new Set<Piece>();
  for (const span of runs(pieces, (a, b) => !!a?.link && !!b?.link?.eq(a.link))) {
    const [first] = span;
    if (!first?.link) continue;
    const same = span.every((piece) => piece && Mark.sameSet(piece.base, first.base));
    if (!same || !first.link.attrs['auto']) for (const piece of span) if (piece) own.add(piece);
  }
  const free = pieces.map((piece) => (piece && !own.has(piece) ? piece : null));
  for (const run of runs(free, (a, b) => !!a && !!b && Mark.sameSet(a.base, b.base))) {
    const [first] = run;
    if (!first) continue;
    const pieces = run.filter((piece) => piece !== null);
    const shown = runs(pieces, (a, b) => !!a.link && !!b.link?.eq(a.link))
      .filter(([piece]) => piece?.link?.attrs['auto'])
      .map((span) => ({
        from: (span[0]?.at ?? 0) - first.at,
        to: (span[0]?.at ?? 0) - first.at + textOf(span).length,
        href: String(span[0]?.link?.attrs['href']),
      }));
    const text = textOf(pieces);
    const wanted = literalLinks(text);
    if (JSON.stringify(wanted) === JSON.stringify(shown)) continue;
    tr.removeMark(first.at, first.at + text.length, type);
    for (const { from, to, href } of wanted)
      tr.addMark(
        first.at + from,
        first.at + to,
        type.create({ href, title: null, auto: true, bare: true, id: linkId() }),
      );
  }
}

// Whether `block`'s child at `index` starts a line: first, or after a break.
function startsLine(block: Node, index: number) {
  const before = index > 0 ? block.child(index - 1) : null;
  return !before || before.type.name === 'hardbreak' || !!before.text?.endsWith('\n');
}

/**
 * HTML that Markdown reads as a block of its own, not after text on a line
 * (`<div>` and the lines below it), stays one: alone in its paragraph and
 * in no mark. So does HTML that starts a line with more after it, where it
 * would start a block taking the line (`<div>x`). Text typed or joined
 * beside it goes in a paragraph of its own, as Markdown would read it into
 * the HTML, or the HTML apart.
 */
export const htmlBlocks = $prose(
  () =>
    new Plugin({
      appendTransaction(trs, _old, state) {
        if (!trs.some((tr) => tr.docChanged)) return null;
        const { from, to } = changedRange(trs, true);
        const tr = state.tr;
        const splits: number[] = [];
        const end = Math.min(to + 1, state.doc.content.size);
        // Each text block changed, all of it: what changed may be beside the HTML.
        state.doc.nodesBetween(Math.max(0, from - 1), end, (block, start) => {
          if (!block.inlineContent) return true;
          block.forEach((node, offset, index) => {
            if (node.type.name !== 'html') return;
            const value = String(node.attrs.value);
            const more = index < block.childCount - 1;
            const starting = more && startsLine(block, index);
            if (inlineHtml(value) && (!starting || inlineHtml(value, true))) return;
            const pos = start + 1 + offset;
            if (node.marks.length > 0) tr.removeMark(pos, pos + node.nodeSize);
            if (block.type.name !== 'paragraph') return;
            if (index > 0) splits.push(pos);
            if (index < block.childCount - 1) splits.push(pos + node.nodeSize);
          });
          return false;
        });
        for (const at of splits.sort((a, b) => b - a)) if (canSplit(tr.doc, at)) tr.split(at);
        return tr.docChanged ? tr : null;
      },
    }),
);

const DEFINITION = 'footnote_definition';
const REFERENCE = 'footnote_reference';

/** A footnote's label as Markdown matches it, by Unicode case folding (`ß` is `SS`). */
const labelOf = (node: Node) => normalizeIdentifier(String(node.attrs['label']));

const has = (doc: Node, from: number, to: number, types: readonly string[]) => {
  let found = false;
  doc.nodesBetween(from, to, (node) => {
    found ||= types.includes(node.type.name);
    return !found;
  });
  return found;
};

// Whether `trs` take any of `taken` from the document, or bring any of `brought`.
const touches = (
  trs: readonly Transaction[],
  taken: readonly string[],
  brought: readonly string[],
) =>
  trs.some((tr) =>
    tr.steps.some((step, i) => {
      const before = tr.docs[i];
      const after = tr.docs[i + 1] ?? tr.doc;
      let found = false;
      step.getMap().forEach((oldStart, oldEnd, start, end) => {
        found ||= !!before && has(before, oldStart, oldEnd, taken);
        found ||= has(after, start, end, brought);
      });
      return found;
    }),
  );

/**
 * A footnote reference with no definition in the page is the text Markdown
 * reads it as (`[^1]`), as when its definition is deleted or it's pasted
 * alone. Checked only when a change takes a definition or brings a reference.
 */
export const footnotes = $prose(
  () =>
    new Plugin({
      appendTransaction(trs, _old, state) {
        if (!touches(trs, [DEFINITION], [REFERENCE])) return null;
        const defined = new Set<string>();
        const references: number[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name === DEFINITION) defined.add(labelOf(node));
          if (node.type.name === REFERENCE) references.push(pos);
        });
        const tr = state.tr;
        for (const pos of references.reverse()) {
          const node = state.doc.nodeAt(pos);
          if (node && !defined.has(labelOf(node)))
            tr.replaceWith(pos, pos + 1, state.schema.text(`[^${node.attrs.label}]`, node.marks));
        }
        return tr.docChanged ? tr : null;
      },
    }),
);

/** What a footnote definition the reader leaves out says. */
const HIDDEN_FOOTNOTE = 'Not shown to readers';

// The footnote definitions in `doc` the reader leaves out, marked so: those
// no reference names, and those after the first with their label.
function hiddenFootnotes(doc: Node): DecorationSet {
  const named = new Set<string>();
  const definitions: { node: Node; pos: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === REFERENCE) named.add(labelOf(node));
    if (node.type.name === DEFINITION) definitions.push({ node, pos });
  });
  const seen = new Set<string>();
  const hidden = definitions.filter(({ node }) => {
    const label = labelOf(node);
    const first = !seen.has(label);
    seen.add(label);
    return !first || !named.has(label);
  });
  return DecorationSet.create(
    doc,
    hidden.map(({ node, pos }) =>
      Decoration.node(pos, pos + node.nodeSize, {
        class: 'footnote-hidden',
        'data-note': HIDDEN_FOOTNOTE,
      }),
    ),
  );
}

const hiddenKey = new PluginKey<DecorationSet>('wikistow-hidden-footnotes');

/**
 * A footnote definition the reader leaves out, which no reference names or
 * whose label one before it has, shows muted, saying it's not shown.
 */
export const unshownFootnotes = $prose(
  () =>
    new Plugin<DecorationSet>({
      key: hiddenKey,
      state: {
        init: (_config, { doc }) => hiddenFootnotes(doc),
        apply(tr, set, _old, { doc }) {
          if (!tr.docChanged) return set;
          const footnote = [DEFINITION, REFERENCE];
          return touches([tr], footnote, footnote)
            ? hiddenFootnotes(doc)
            : set.map(tr.mapping, doc);
        },
      },
      props: { decorations: (state) => hiddenKey.getState(state) },
    }),
);

// `fragment` with the footnotes `renamed` names given their new labels.
function relabel(fragment: Fragment, renamed: ReadonlyMap<string, string>): Fragment {
  const nodes: Node[] = [];
  fragment.forEach((node) => {
    if (node.isText) return void nodes.push(node);
    const label = [DEFINITION, REFERENCE].includes(node.type.name)
      ? renamed.get(labelOf(node))
      : undefined;
    const attrs = label === undefined ? node.attrs : { ...node.attrs, label };
    nodes.push(node.type.create(attrs, relabel(node.content, renamed), node.marks));
  });
  return Fragment.from(nodes);
}

/**
 * `slice`, pasted into `doc`, with each footnote it defines under a label
 * the page has already given a free one, with its references: the reader
 * takes a label's first definition, so they'd name the page's.
 */
export function freshFootnotes(slice: Slice, doc: Node): Slice {
  const labels = new Set<string>();
  const add = (node: Node) => {
    if (node.type.name === DEFINITION || node.type.name === REFERENCE) labels.add(labelOf(node));
  };
  const defined = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === DEFINITION) defined.add(labelOf(node));
    add(node);
  });
  const renamed = new Map<string, string>();
  slice.content.descendants((node) => {
    add(node);
    const label = node.type.name === DEFINITION ? labelOf(node) : null;
    if (label !== null && defined.has(label)) renamed.set(label, String(node.attrs['label']));
  });
  if (renamed.size === 0) return slice;
  for (const [label, written] of renamed) {
    let n = 2;
    while (labels.has(normalizeIdentifier(`${written}-${n}`))) n++;
    renamed.set(label, `${written}-${n}`);
    labels.add(normalizeIdentifier(`${written}-${n}`));
  }
  return new Slice(relabel(slice.content, renamed), slice.openStart, slice.openEnd);
}

/**
 * A table's header row keeps a cell for each column: emptied, as by
 * deleting across it, it's given empty ones. Markdown has no table without
 * it, and `tableEditing` fills a row only with cells like its first.
 */
export const tableHeaders = $prose(
  () =>
    new Plugin({
      appendTransaction(trs, _old, state) {
        const header = state.schema.nodes['table_header'];
        if (!header || !trs.some((tr) => tr.docChanged)) return null;
        const { from, to } = changedRange(trs);
        const tr = state.tr;
        const end = Math.min(to + 1, state.doc.content.size);
        state.doc.nodesBetween(Math.max(0, from - 1), end, (table, pos) => {
          if (table.type.name !== 'table') return !table.isTextblock;
          if (table.firstChild?.childCount !== 0) return false;
          let width = 1;
          table.forEach((row) => (width = Math.max(width, row.childCount)));
          const cells = Array.from({ length: width }, () => header.createAndFill());
          tr.insert(
            tr.mapping.map(pos + 2),
            cells.filter((cell) => cell !== null),
          );
          return false;
        });
        return tr.docChanged ? tr : null;
      },
    }),
);

const CELLS = new Set(['table_cell', 'table_header']);

function inCell($pos: ResolvedPos) {
  for (let depth = $pos.depth; depth > 0; depth--)
    if (CELLS.has($pos.node(depth).type.name)) return true;
  return false;
}

/**
 * A wikilink in a table cell holds its bars escaped (`[[Plan\|x]]`), as one
 * read from a cell does: typed, pasted or moved into one, it's given that
 * source, which is how it's written there. An unescaped bar ends the cell.
 */
export const cellLinks = $prose(
  () =>
    new Plugin({
      appendTransaction(trs, _old, state) {
        if (!trs.some((tr) => tr.docChanged)) return null;
        const { from, to } = changedRange(trs, true);
        const tr = state.tr;
        state.doc.nodesBetween(from, Math.min(to, state.doc.content.size), (node, pos) => {
          if (node.type.name !== 'wikilink') return;
          const source = inTableCell(String(node.attrs.source));
          if (source !== node.attrs.source && inCell(state.doc.resolve(pos)))
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, source });
        });
        return tr.docChanged ? tr : null;
      },
    }),
);

// Whether text changed in `range` is part of the brackets from `start` to
// `end`: typed or pasted there, or a deletion inside them that joined them.
const wrote = (range: { from: number; to: number }, start: number, end: number) =>
  range.from === range.to
    ? start < range.from && range.from < end
    : range.from < end && range.to > start;

type Range = { from: number; to: number };

// The spans of the document `trs` changed, in its final positions; with
// `marks`, where marks were added or taken away too.
function changedRanges(trs: readonly Transaction[], marks = false): Range[] {
  let ranges: Range[] = [];
  for (const tr of trs) {
    const { mapping } = tr;
    ranges = ranges.map(({ from, to }) => ({
      from: mapping.map(from, -1),
      to: mapping.map(to, 1),
    }));
    tr.steps.forEach((step, i) => {
      const rest = mapping.slice(i + 1);
      if (marks && (step instanceof AddMarkStep || step instanceof RemoveMarkStep))
        ranges.push({ from: rest.map(step.from, -1), to: rest.map(step.to, 1) });
      step.getMap().forEach((_oldStart, _oldEnd, start, end) => {
        ranges.push({ from: rest.map(start, -1), to: rest.map(end, 1) });
      });
    });
  }
  return ranges;
}

// The span `ranges` cover, from the first to the last.
function hull(ranges: readonly Range[]): Range {
  if (ranges.length === 0) return { from: 0, to: 0 };
  return ranges.reduce((a, b) => ({ from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) }));
}

// The span of the document `trs` changed, in its final positions; with
// `marks`, where marks were added or taken away too.
const changedRange = (trs: readonly Transaction[], marks = false) =>
  hull(changedRanges(trs, marks));

/**
 * Arrow Down with nowhere further to go in the page's last block, other
 * than a paragraph, moves into a new paragraph after it: on the last line
 * of a final code block, or of a cell in a final table's last row, or with
 * a final block such as a rule selected whole, as Arrow Down onto it
 * selects it. Once there, the paragraph is the last block, so pressing
 * again adds no other. An empty paragraph writes as nothing, so the page
 * is unchanged until something is typed in it. It must come before the
 * table plugin, whose own Arrow Down keeps the cursor in the table.
 */
export const leaveLastBlock = $prose(() =>
  keymap({
    ArrowDown: (state, dispatch, view) => {
      const { selection } = state;
      const paragraph = state.schema.nodes['paragraph'];
      if (!paragraph || !view) return false;
      if (selection instanceof NodeSelection) {
        const { $from, node, to } = selection;
        if ($from.depth > 0 || to !== state.doc.content.size || node.type === paragraph)
          return false;
      } else {
        const { $head, empty } = selection;
        if (!empty || !view.endOfTextblock('down')) return false;
        if ($head.depth === 1 && $head.parent.type === paragraph) return false;
        // The last of each node it's in, the page included; cells sit side by side.
        for (let depth = $head.depth - 1; depth >= 0; depth--) {
          const node = $head.node(depth);
          if (node.type.spec.tableRole !== 'row' && $head.indexAfter(depth) !== node.childCount)
            return false;
        }
      }
      if (dispatch) {
        const tr = state.tr.insert(state.doc.content.size, paragraph.create());
        dispatch(tr.setSelection(TextSelection.atEnd(tr.doc)).scrollIntoView());
      }
      return true;
    },
  }),
);

/** The wikilink just before the cursor, or selected. */
function linkAt(view: EditorView): { node: Node; pos: number } | null {
  const { selection } = view.state;
  const selected = 'node' in selection ? (selection.node as Node) : null;
  if (selected?.type.name === 'wikilink') return { node: selected, pos: selection.from };
  if (!selection.empty) return null;
  const before = selection.$from.nodeBefore;
  if (before?.type.name === 'wikilink')
    return { node: before, pos: selection.from - before.nodeSize };
  const after = selection.$from.nodeAfter;
  return after?.type.name === 'wikilink' ? { node: after, pos: selection.from } : null;
}

/**
 * Keys for links and tasks: Alt+Enter on an ambiguous link asks which
 * page it means; Backspace just after a link opens it again as text, its
 * `]]` gone, to edit or complete; Mod+Enter ticks the task the cursor is in.
 */
export const linkKeys = (host: VisualHost) =>
  $prose(() =>
    keymap({
      'Alt-Enter': (_state, _dispatch, view) => {
        if (!view) return false;
        const at = linkAt(view);
        const link = at && parseWikilink(String(at.node.attrs.source));
        const ambiguous = link && ambiguity(link, host);
        if (!ambiguous) return false;
        host.links().choose({ key: ambiguous.key, target: ambiguous.target });
        return true;
      },
      Backspace: (state, dispatch) => {
        const { selection } = state;
        const before = selection.empty ? selection.$from.nodeBefore : null;
        if (before?.type.name !== 'wikilink') return false;
        const source = String(before.attrs.source);
        dispatch?.(
          state.tr.replaceWith(
            selection.from - before.nodeSize,
            selection.from,
            state.schema.text(source.slice(0, -2)),
          ),
        );
        return true;
      },
      'Mod-Enter': (state, dispatch) => {
        const { $from } = state.selection;
        for (let depth = $from.depth; depth > 0; depth--) {
          const node = $from.node(depth);
          if (node.type.name !== 'list_item') continue;
          if (typeof node.attrs.checked !== 'boolean') return false;
          dispatch?.(
            state.tr.setNodeMarkup($from.before(depth), undefined, {
              ...node.attrs,
              checked: !node.attrs.checked,
            }),
          );
          return true;
        }
        return false;
      },
    }),
  );
