import { accountRoutes } from '@wikistow/contracts';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { plainText } from './name';

/** Up to two initials from a name, or `?` for none. */
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('') || '?';

/**
 * A person's round avatar: their uploaded image, or their initials when they
 * have none or it fails to load. Size and text size come from `className`.
 * The image is only ever an `<img>`, so an SVG avatar can't run scripts or
 * load anything. Decoration only: the server chooses it, so nothing names
 * or picks a person by it.
 *
 *   <Avatar name={me.account.name} avatar={me.account.avatar} className="size-9 text-xs" />
 */
export function Avatar({
  name,
  avatar,
  preview,
  letters = 2,
  className,
}: {
  name: string;
  /** The avatar's ID, or null for initials. */
  avatar: accountRoutes.AvatarId | null;
  /** A local image to show instead, such as a chosen file not yet uploaded. */
  preview?: string | undefined;
  letters?: 1 | 2;
  className?: string;
}) {
  // The image that failed to load, so a replaced one gets its own try.
  const [failed, setFailed] = useState<string | null>(null);
  const src = preview ?? (avatar === null ? null : accountRoutes.avatarUrl(avatar));
  const image = src !== null && src !== failed;
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden rounded-full bg-strong font-extrabold text-strong-foreground',
        className,
      )}
    >
      {image ? (
        <img src={src} alt="" className="size-full object-cover" onError={() => setFailed(src)} />
      ) : (
        initials(plainText(name)).slice(0, letters)
      )}
    </span>
  );
}
