/*
 * The app's theme tokens: the CSS variables a theme sets on `:root,
 * [data-theme]` and a plugin's views style themselves with. The values are
 * each built-in palette's, in packages/ui/src/styles/theme.css; keep this
 * list in step with it.
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
  '--status-published',
  '--status-published-foreground',
  '--status-draft',
  '--status-draft-foreground',
  '--draft-dot',
  '--note',
  '--note-foreground',
  '--table',
  '--table-head',
  '--tree-guide',
  '--glass',
  '--glass-foreground',
  '--card-shadow',
  '--folder-green',
  '--folder-orange',
  '--folder-blue',
  '--folder-pink',
  '--folder-purple',
  '--cover',
] as const;

/** Type, corner radii and Tailwind's spacing unit, which every gap and padding is a multiple of. */
export const SHAPE_TOKENS = [
  '--font-sans',
  '--font-mono',
  '--radius-card',
  '--radius-tile',
  '--radius-control',
  '--radius-row',
  '--radius-folder',
  '--spacing',
] as const;

export type ThemeToken = (typeof PALETTE_TOKENS)[number] | (typeof SHAPE_TOKENS)[number];
