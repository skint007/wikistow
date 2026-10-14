import type { AttachmentRef } from '@wikistow/client';
import type { Mark, Node } from '@milkdown/kit/prose/model';
import type { Command, EditorState } from '@milkdown/kit/prose/state';
import { ATTACHMENT_SCHEME } from '../../attachments';
import { addressOf } from './literals';
import { linkId } from './schema';

// The toolbar's link control, as plain ProseMirror commands: a link put on
// the selected text, inserted at the cursor, sent somewhere else, or taken
// off; and its attachment picker's, one of the page's attachments put in
// at the cursor. Each link made here is one of the page's own (`autoLink`):
// it keeps where it goes however its text is edited, and is written
// `[text](href)`.

/** A link in the text: its mark and the span it covers. */
export type LinkSpan = { mark: Mark; from: number; to: number };

/**
 * The link all of the selection is in; a cursor at either end of one is in
 * it too, the one before it first.
 */
export function linkAround(state: EditorState): LinkSpan | null {
  const type = state.schema.marks['link'];
  const { $from, $to } = state.selection;
  if (!type || !$from.sameParent($to) || !$from.parent.inlineContent) return null;
  const spans: LinkSpan[] = [];
  $from.parent.forEach((child, offset) => {
    const mark = type.isInSet(child.marks);
    if (!mark) return;
    const from = $from.start() + offset;
    const last = spans.at(-1);
    if (last?.to === from && last.mark.eq(mark)) last.to = from + child.nodeSize;
    else spans.push({ mark, from, to: from + child.nodeSize });
  });
  return spans.find(({ from, to }) => from <= $from.pos && $to.pos <= to) ?? null;
}

// What can't go in a link made here, as Markdown would read it otherwise:
// a wikilink's brackets in the link's, HTML or a footnote's `[^…]`.
const UNLINKABLE = new Set(['wikilink', 'html', 'footnote_reference']);

/**
 * Whether the control applies: in a link, or in one block that takes
 * links, at a cursor out of inline code, which a link inserted there would
 * split, or over text with nothing in it a link can't hold.
 */
export function linkable(state: EditorState): boolean {
  if (linkAround(state)) return true;
  const type = state.schema.marks['link'];
  const { $from, $to, from, to, empty } = state.selection;
  if (!type || !$from.sameParent($to) || !$from.parent.type.allowsMarkType(type)) return false;
  if (empty && $from.marks().some((mark) => mark.type.spec.code)) return false;
  let holds = true;
  state.doc.nodesBetween(from, to, (node: Node) => {
    if (UNLINKABLE.has(node.type.name)) holds = false;
  });
  return holds;
}

/**
 * Where a typed destination goes: as it's written with a scheme, or as a
 * path or anchor; a bare address as the reader takes one (`www.…` to
 * `http://www.…`, an email to `mailto:`), and a bare domain to the web.
 */
export function destination(typed: string): string {
  const text = typed.trim();
  if (/^(?:[a-z][a-z\d+-]*:|[/#?.])/i.test(text)) return text;
  const address = addressOf(text);
  if (address !== null) return address;
  return /^[^\s/@]+\.[a-z]{2,}(?:[/?#:]|$)/i.test(text) ? `https://${text}` : text;
}

/**
 * The link the selection is in sent to `href`, or else the selected text
 * made a link to it. A link already going there is left as it's written.
 */
export const setLink =
  (href: string): Command =>
  (state, dispatch) => {
    const type = state.schema.marks['link'];
    if (!type || !href || !linkable(state)) return false;
    const around = linkAround(state);
    if (around) {
      if (around.mark.attrs['href'] === href) return true;
      // One of the page's own now, which no longer follows its text.
      const mark = type.create({
        ...around.mark.attrs,
        href,
        auto: false,
        bare: false,
        read: null,
      });
      dispatch?.(
        state.tr.removeMark(around.from, around.to, type).addMark(around.from, around.to, mark),
      );
      return true;
    }
    const { from, to, empty } = state.selection;
    if (empty) return false;
    dispatch?.(state.tr.addMark(from, to, type.create({ href, id: linkId() })).scrollIntoView());
    return true;
  };

/** `text` as a link to `href` at the cursor, in place of any selection, with the marks typed there. */
export const insertLink =
  (text: string, href: string): Command =>
  (state, dispatch) => {
    const type = state.schema.marks['link'];
    if (!type || !text || !href || linkAround(state) || !linkable(state)) return false;
    const marks = type.removeFromSet(state.storedMarks ?? state.selection.$from.marks());
    const link = type.create({ href, id: linkId() });
    dispatch?.(
      state.tr
        .replaceSelectionWith(state.schema.text(text, link.addToSet(marks)), false)
        .scrollIntoView(),
    );
    return true;
  };

/**
 * The link the selection is in taken off, its text kept. Not one whose
 * text the reader links anyway, as an address (`autolinks` links it
 * again as the change goes in).
 */
export const removeLink: Command = (state, dispatch) => {
  const around = linkAround(state);
  if (!around) return false;
  const tr = state.tr.removeMark(around.from, around.to, around.mark);
  if (state.apply(tr).doc.rangeHasMark(around.from, around.to, around.mark.type)) return false;
  dispatch?.(tr);
  return true;
};

/**
 * Whether an attachment can go in at the selection: in one block of text,
 * not code, and neither in a link nor over any of one, which an image
 * would split and which can't hold another.
 */
export function attachable(state: EditorState): boolean {
  const type = state.schema.marks['link'];
  const { $from, $to, from, to } = state.selection;
  const { parent } = $from;
  if (!type || !$from.sameParent($to) || !parent.inlineContent || parent.type.spec.code)
    return false;
  if ($from.marks().some((mark) => mark.type === type || mark.type.spec.code)) return false;
  return !state.doc.rangeHasMark(from, to, type);
}

/**
 * One of the page's attachments in place of the selection, as uploading it
 * writes it (`attachmentLink`): an image shown inline, any other file a
 * link to download it, with the marks typed there.
 */
export const insertAttachment =
  (ref: AttachmentRef): Command =>
  (state, dispatch) => {
    const image = state.schema.nodes['image'];
    const type = state.schema.marks['link'];
    if (!image || !type || !attachable(state)) return false;
    const href = `${ATTACHMENT_SCHEME}${ref.id}`;
    const marks = state.storedMarks ?? state.selection.$from.marks();
    const node = ref.mediaType.startsWith('image/')
      ? image.create({ src: href, alt: ref.name })
      : state.schema.text(ref.name, type.create({ href, id: linkId() }).addToSet(marks));
    dispatch?.(state.tr.replaceSelectionWith(node, false).scrollIntoView());
    return true;
  };
