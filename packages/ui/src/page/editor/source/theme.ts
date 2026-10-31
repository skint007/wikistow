import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

// The source editor's look. It sits in a shadow root, where the app's
// stylesheet doesn't reach, so every rule is CodeMirror's own; the colors
// are the palette's variables, which do reach it, so it follows the theme;
// its scrollbars inherit the page's colours.
// Font, size and line height come from the host element, whose height it
// fills, scrolling within it.

const theme = EditorView.theme({
  '&': {
    color: 'var(--foreground)',
    backgroundColor: 'transparent',
    height: '100%',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit', overflow: 'auto' },
  '.cm-content': { padding: '16px', caretColor: 'var(--foreground)' },
  '.cm-content.cm-crosshair': { cursor: 'crosshair' },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '.cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--primary) 18%, transparent)',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'color-mix(in srgb, var(--primary) 28%, transparent)',
  },
  '.cm-specialChar': { color: 'var(--destructive)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-row)',
    boxShadow: 'var(--card-shadow)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-sans)',
    maxHeight: '16em',
    minWidth: '16em',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'baseline',
    gap: '12px',
    padding: '4px 10px',
    lineHeight: '1.5',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--primary-soft)',
    color: 'var(--primary-ink)',
  },
  '.cm-completionLabel': { fontWeight: '700' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > completion-section': {
    padding: '6px 10px 2px',
    borderBottom: 'none',
    fontSize: '0.8em',
    fontWeight: '700',
    color: 'var(--muted-foreground)',
    opacity: '1',
  },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--primary-ink)' },
  '.cm-completionDetail': {
    marginLeft: 'auto',
    fontStyle: 'normal',
    fontSize: '0.85em',
    color: 'var(--muted-foreground)',
  },
  '.cm-completionIcon': { display: 'none' },
  '.cm-wikilink': { color: 'var(--primary-ink)' },
  '.cm-wikilink-ambiguous': {
    textDecoration: 'underline wavy var(--draft-dot)',
    textUnderlineOffset: '3px',
  },
  '.cm-link-choose': {
    display: 'inline-grid',
    placeItems: 'center',
    width: '1.25em',
    height: '1.25em',
    margin: '0 2px',
    padding: '0',
    verticalAlign: 'text-bottom',
    border: 'none',
    borderRadius: '999px',
    cursor: 'pointer',
    font: '700 0.75em var(--font-sans)',
    backgroundColor: 'var(--status-draft)',
    color: 'var(--status-draft-foreground)',
  },
  // The glyph is drawn here, so the line's text stays the page's text.
  '.cm-link-choose::before': { content: '"?"' },
  '.cm-link-choose.cm-link-chosen': {
    backgroundColor: 'var(--muted)',
    color: 'var(--muted-foreground)',
  },
  '.cm-link-choose.cm-link-chosen::before': { content: '"✓"' },
});

const highlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: '800' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--primary-ink)' },
  { tag: t.monospace, color: 'var(--subtle-foreground)' },
  { tag: t.quote, color: 'var(--subtle-foreground)' },
  {
    tag: [t.processingInstruction, t.contentSeparator, t.labelName, t.meta, t.comment],
    color: 'var(--muted-foreground)',
  },
]);

export const sourceTheme = [theme, syntaxHighlighting(highlight)];
