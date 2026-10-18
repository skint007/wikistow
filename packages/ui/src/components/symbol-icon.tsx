import { lazy, Suspense, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { IconImage } from './icon-image';

// A set that fails to load, as after an update replaced this build's files, shows the emoji.
const DrawnSymbol = lazy(() =>
  import('./symbol-set').catch(() => ({
    default: ({ fallback }: { fallback: ReactNode }) => fallback,
  })),
);

/** An icon set name as words, for labels: `square terminal`. */
export const symbolWords = (name: string) => name.replaceAll('-', ' ');

/**
 * A folder's, space's or page's icon from the icon set, Lucide, by name:
 * drawn in the text colour at 1.2 times the font size, where its emoji
 * would be, or `fallback`, its emoji, when this app's set has no such
 * icon. The set loads on first use; until then an empty box of the icon's
 * size holds its place, so nothing flashes. Decorative, like the emoji,
 * unless given `label`.
 */
export function SymbolIcon({
  name,
  fallback,
  label,
  className,
}: {
  name: string;
  fallback: ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <Suspense
      fallback={<span aria-hidden className={cn('block size-[1.2em] shrink-0', className)} />}
    >
      <DrawnSymbol name={name} fallback={fallback} label={label} className={className} />
    </Suspense>
  );
}

/**
 * What fills a folder's or space's tile, or a page's badge: its image
 * filling it (`IconImage`), else its icon, else `emoji`, which shows while
 * either loads or if it fails to.
 */
export function Picture({
  image,
  symbol,
  emoji,
}: {
  image: string | null;
  symbol: string | null;
  emoji: ReactNode;
}) {
  return (
    <IconImage
      src={image}
      fallback={symbol ? <SymbolIcon name={symbol} fallback={emoji} /> : emoji}
    />
  );
}
