/*
 * The app's theme tokens: the CSS variables a theme sets on `:root,
 * [data-theme]` and a plugin's views style themselves with. Their values
 * are in packages/ui/src/styles/theme.css, the one place they are set;
 * packages/ui/test/theme-tokens.test.ts checks this list against it.
 */

/** Colours, shadows and the palette's own banner gradient. */
export const PALETTE_TOKENS = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--border',
  '--input',
  '--ring',
  '--muted',
  '--muted-foreground',
  '--subtle-foreground',
  '--secondary',
  '--secondary-foreground',
  '--accent',
  '--accent-foreground',
  '--primary',
  '--primary-2',
  '--primary-foreground',
  '--primary-soft',
  '--primary-ink',
  '--strong',
  '--strong-foreground',
  '--destructive',
  '--destructive-foreground',
  '--destructive-badge-foreground',
  '--status-published',
  '--status-published-foreground',
  '--status-draft',
  '--status-draft-foreground',
  '--draft-dot',
  '--update-dot',
  '--diff-added',
  '--diff-added-foreground',
  '--diff-removed',
  '--diff-removed-foreground',
  '--note',
  '--note-foreground',
  '--table',
  '--table-head',
  '--tree-guide',
  '--glass',
  '--glass-foreground',
  '--card-shadow',
  '--badge-shadow',
  '--slider-shadow',
  '--shade',
  '--shade-strong',
  '--backdrop',
  '--folder-green',
  '--folder-orange',
  '--folder-blue',
  '--folder-pink',
  '--folder-purple',
  '--cover',
] as const;

/**
 * A page's GitHub alerts (`> [!NOTE]` and the rest), each type's label and
 * edge, highlighted code's colours, and the page's highlights and the
 * theme's colours for its text and highlights (`data-color`).
 */
export const CONTENT_TOKENS = [
  '--alert-note',
  '--alert-tip',
  '--alert-important',
  '--alert-warning',
  '--alert-caution',
  '--code-comment',
  '--code-keyword',
  '--code-string',
  '--code-number',
  '--code-title',
  '--code-deletion',
  '--highlight',
  '--highlight-red',
  '--highlight-orange',
  '--highlight-yellow',
  '--highlight-green',
  '--highlight-blue',
  '--highlight-purple',
  '--text-red',
  '--text-orange',
  '--text-yellow',
  '--text-green',
  '--text-blue',
  '--text-purple',
] as const;

/** The banner presets a page can choose, the same in every palette. */
export const BANNER_TOKENS = [
  '--banner-sunrise',
  '--banner-ocean',
  '--banner-meadow',
  '--banner-lavender',
  '--banner-dusk',
  '--banner-stone',
] as const;

/**
 * Type, corner radii, Tailwind's spacing unit, which every gap and padding
 * is a multiple of, and the space's sidebar width.
 */
export const SHAPE_TOKENS = [
  '--font-sans',
  '--font-mono',
  '--radius-card',
  '--radius-tile',
  '--radius-control',
  '--radius-row',
  '--radius-folder',
  '--spacing',
  '--sidebar-width',
] as const;

export type ThemeToken =
  | (typeof PALETTE_TOKENS)[number]
  | (typeof CONTENT_TOKENS)[number]
  | (typeof BANNER_TOKENS)[number]
  | (typeof SHAPE_TOKENS)[number];
