import type { Node } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { alertMarker, type AlertType } from '../../alerts';

/**
 * The alert `quote`, a block quote, is (`alertMarker`), by the plain text
 * its first paragraph starts with, as the reader reads it: not code or
 * emphasis. With what follows that text in its paragraph, if anything.
 */
export function alertIn(
  quote: Node,
): { type: AlertType; length: number; next: Node | null } | null {
  const paragraph = quote.firstChild;
  const text = paragraph?.type.name === 'paragraph' ? paragraph.firstChild : null;
  if (!paragraph || !text?.isText || text.marks.length > 0) return null;
  const next = paragraph.childCount > 1 ? paragraph.child(1) : null;
  const goesOn = !!next && next.type.name !== 'hardbreak';
  const alert = alertMarker(text.text ?? '', goesOn);
  return alert && { ...alert, next };
}

/** Each block quote in `doc` that's an alert (`alertIn`), as decorations. */
function decorations(doc: Node): DecorationSet {
  const found: Decoration[] = [];
  doc.descendants((quote, pos) => {
    if (quote.type.name !== 'blockquote') return !quote.isTextblock;
    const alert = alertIn(quote);
    if (!alert) return true;
    const start = pos + 2;
    found.push(
      Decoration.node(pos, pos + quote.nodeSize, {
        class: `markdown-alert markdown-alert-${alert.type}`,
      }),
      Decoration.inline(start, start + alert.length, { class: 'markdown-alert-marker' }),
    );
    // The line break after the marker ends its line, as the reader shows it.
    if (alert.next)
      found.push(
        Decoration.node(start + alert.length, start + alert.length + 1, {
          class: 'markdown-alert-break',
        }),
      );
    return true;
  });
  return DecorationSet.create(doc, found);
}

const key = new PluginKey<DecorationSet>('alerts');

/**
 * GitHub's alerts shown as the reader shows them: the quote in its type's
 * colour, under its label, which is the quote's type picker (`quoteView`).
 * The marker stays text, as written, dimmed.
 */
export const alerts = $prose(
  () =>
    new Plugin<DecorationSet>({
      key,
      state: {
        init: (_, { doc }) => decorations(doc),
        apply: (tr, set) => (tr.docChanged ? decorations(tr.doc) : set),
      },
      props: { decorations: (state) => key.getState(state) },
    }),
);
