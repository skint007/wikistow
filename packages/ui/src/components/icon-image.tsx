import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A folder's or page's image icon, filling the box it's in and cropped to
 * it, or `fallback`, its emoji, when there is no image or it fails to load.
 * Only ever an `<img>` of a `blob:` URL, decorative like the emoji it stands
 * for.
 *
 *   <span className={tileClass(tint)}><IconImage src={url} fallback={emoji} /></span>
 */
export function IconImage({
  src,
  fallback,
  className,
}: {
  src: string | null;
  fallback: ReactNode;
  className?: string;
}) {
  // The image that failed to load, so a replaced one gets its own try.
  const [failed, setFailed] = useState<string | null>(null);
  if (src === null || src === failed) return fallback;
  return (
    <img
      src={src}
      alt=""
      className={cn('size-full object-cover', className)}
      onError={() => setFailed(src)}
    />
  );
}
