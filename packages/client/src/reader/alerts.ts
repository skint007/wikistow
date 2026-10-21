// GitHub's alerts: a block quote whose first line is `[!NOTE]`, `[!TIP]`,
// `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` alone, in any case. The
// reader shows it as an alert (`remarkAlerts`), the visual editor too, its
// marker kept as text (`packages/ui/src/page/editor/visual/alerts.ts`). No
// React here: the reader's worker loads this.
import { markdownNodes } from '../markdown/index.ts';
import type { Blockquote, Root, Text } from 'mdast';

/** Each alert's type, as its class names it (`markdown-alert-note`), and the label it shows. */
export const ALERTS = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
} as const;

export type AlertType = keyof typeof ALERTS;

const MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*/i;
// In LF or CRLF, as a page may be written.
const LINE_BREAK = /^\r?\n/;

/**
 * The alert a block quote is, by the text its first paragraph starts with,
 * and how much of that text is the marker; null if it's an ordinary quote.
 * `goesOn` says whether more than a line break follows that text in its
 * paragraph, which then puts more on the marker's line.
 */
export function alertMarker(
  text: string,
  goesOn: boolean,
): { type: AlertType; length: number } | null {
  const match = MARKER.exec(text);
  if (!match?.[1]) return null;
  const rest = text.slice(match[0].length);
  if (rest === '' ? goesOn : !LINE_BREAK.test(rest)) return null;
  return { type: match[1].toLowerCase() as AlertType, length: match[0].length };
}

/**
 * The alert `quote` is (`alertMarker`), with the text holding its marker;
 * null if none. The visual editor's trees leave an empty node's children out.
 */
export function alertOf(quote: Blockquote): { type: AlertType; length: number; text: Text } | null {
  const [first] = (quote.children as Blockquote['children'] | undefined) ?? [];
  if (first?.type !== 'paragraph') return null;
  const [text, next] = (first.children as typeof first.children | undefined) ?? [];
  if (text?.type !== 'text') return null;
  // A line break may be a node of its own, or text, as the visual editor writes one.
  const goesOn =
    !!next && next.type !== 'break' && !(next.type === 'text' && LINE_BREAK.test(next.value));
  const marker = alertMarker(text.value, goesOn);
  return marker && { ...marker, text };
}

/**
 * A remark plugin: each alert as a `div` of classes `markdown-alert` and
 * `markdown-alert-<type>`, its marker left out, which the reader gives a
 * label (`packages/ui/src/page/markdown.tsx`).
 */
export function remarkAlerts() {
  return (tree: Root) => {
    const alerts: [Blockquote, NonNullable<ReturnType<typeof alertOf>>][] = [];
    for (const node of markdownNodes(tree)) {
      const alert = node.type === 'blockquote' && alertOf(node);
      if (alert) alerts.push([node, alert]);
    }
    for (const [quote, { type, length, text }] of alerts) {
      const [first] = quote.children;
      if (first?.type !== 'paragraph') continue;
      text.value = text.value.slice(length).replace(LINE_BREAK, '');
      // The marker's text, then its line break if that's a node.
      if (!text.value) first.children.splice(0, first.children[1]?.type === 'break' ? 2 : 1);
      if (first.children.length === 0) quote.children.shift();
      quote.data = {
        ...quote.data,
        hName: 'div',
        hProperties: { className: ['markdown-alert', `markdown-alert-${type}`] },
      };
    }
  };
}
