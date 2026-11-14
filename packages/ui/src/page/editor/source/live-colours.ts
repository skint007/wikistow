// Each person's colour in a live session, for their initials in the toolbar
// and their caret in the source editor (ADR 0015 decision 7).

/** Each person's colour, taken from their identity: also the toolbar's. */
export const CARET_COLOURS = [
  '#d9480f',
  '#1971c2',
  '#2f9e44',
  '#9c36b5',
  '#c2255c',
  '#0c8599',
  '#e67700',
  '#5f3dc4',
] as const;

/** The colour number of `id`, the same in every app. */
export function colourOf(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % CARET_COLOURS.length;
}
