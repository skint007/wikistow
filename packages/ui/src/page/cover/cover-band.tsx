import type { AttachmentRef, Banner } from '@wikistow/client';
import type { ReactNode } from 'react';
import { IconImage } from '@/components/icon-image';
import { useDecrypted, type AttachmentContext } from '../attachments';
import { coverStyle } from './cover-style';

/** The page's cover band: its banner, the toolbar and the emoji badge inside it. */
export function CoverBand({
  banner,
  attachments,
  children,
}: {
  banner: Banner;
  /** The version's attachments, one of which an image banner shows. */
  attachments: AttachmentContext;
  children: ReactNode;
}) {
  const ref: AttachmentRef | undefined =
    banner.kind === 'image'
      ? attachments.attachments.find((a) => a.id === banner.attachmentId)
      : undefined;
  const { data: url } = useDecrypted(attachments, ref);
  return (
    <div
      data-region="page.cover"
      data-banner={banner.kind === 'preset' ? banner.name : banner.kind}
      className="bg-cover-band relative h-[120px] shrink-0 rounded-t-card max-[899px]:h-[104px]"
      style={coverStyle(banner, url)}
    >
      {children}
    </div>
  );
}

/** The 72px badge (56px on phones) overlapping the bottom of the band, clipping whatever the emoji or image draws. */
export const badgeClass =
  'absolute -bottom-[26px] left-11 grid size-[72px] place-items-center overflow-hidden rounded-card bg-card text-5xl leading-none shadow-[0_4px_14px_rgba(0,0,0,.18)] max-[899px]:-bottom-5 max-[899px]:left-[18px] max-[899px]:size-14 max-[899px]:text-[36px]';

/**
 * What the badge shows: the page's image filling it, or its emoji, which
 * also shows while the image loads or if it fails to.
 */
export const BadgeIcon = ({ emoji, image }: { emoji: string | null; image: string | null }) => (
  <IconImage src={image} fallback={emoji} />
);

export function PageBadge({ emoji, image }: { emoji: string | null; image: string | null }) {
  return (
    <span
      role="img"
      aria-label={image ? 'Page image' : `Page emoji ${emoji}`}
      className={badgeClass}
    >
      <BadgeIcon emoji={emoji} image={image} />
    </span>
  );
}

/** Top padding for the page body, which clears the badge when there is one. */
export const bodyTop = (badge: boolean) =>
  badge ? 'pt-[70px] max-[899px]:pt-14' : 'pt-10 max-[899px]:pt-8';
