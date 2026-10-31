import type { AttachmentRef, Banner } from '@wikistow/client';
import type { ReactNode } from 'react';
import { IconImage } from '@/components/icon-image';
import { SymbolIcon, symbolWords } from '@/components/symbol-icon';
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
      // 120px (104px on phones), up to three times that at `--cover-height: 100`.
      className="bg-cover-band relative h-[calc(120px+2.4px*var(--cover-height,0))] shrink-0 rounded-t-card max-[899px]:h-[calc(104px+2.08px*var(--cover-height,0))]"
      style={coverStyle(banner, url)}
    >
      {children}
    </div>
  );
}

/** The 72px badge (56px on phones) overlapping the bottom of the band, clipping whatever the emoji, icon or image draws. */
export const badgeClass =
  'absolute -bottom-[26px] left-11 grid size-[72px] place-items-center overflow-hidden rounded-card bg-card text-5xl leading-none shadow-[0_4px_14px_rgba(0,0,0,.18)] max-[899px]:-bottom-5 max-[899px]:left-[18px] max-[899px]:size-14 max-[899px]:text-[36px]';

/** The published view's badge, named for what it shows. */
export function PageBadge({
  emoji,
  symbol,
  image,
}: {
  emoji: string | null;
  symbol: string | null;
  image: string | null;
}) {
  const named = emoji && (
    <span role="img" aria-label={`Page emoji ${emoji}`}>
      {emoji}
    </span>
  );
  return (
    <span className={badgeClass}>
      <IconImage
        src={image}
        alt="Page image"
        fallback={
          symbol ? (
            <SymbolIcon name={symbol} label={`Page icon ${symbolWords(symbol)}`} fallback={named} />
          ) : (
            named
          )
        }
      />
    </span>
  );
}

/** Top padding for the page body, which clears the badge when there is one. */
export const bodyTop = (badge: boolean) =>
  badge ? 'pt-[70px] max-[899px]:pt-14' : 'pt-10 max-[899px]:pt-8';
