import type { Banner } from '@wikistow/client';
import type { CSSProperties } from 'react';

declare module 'react' {
  interface CSSProperties {
    '--cover'?: string;
    '--cover-focal'?: string;
    '--cover-height'?: number;
    '--cover-fade'?: string;
  }
}

/**
 * The band's override of `--cover`, which `bg-cover-band` paints: set
 * through React's style prop, so through the CSSOM, which the CSP allows
 * where a style attribute in markup would not be. An image shows only once
 * decrypted to a local `blob:` URL; until then, the theme gradient, at the
 * image's height and fade so the page doesn't move when it shows.
 */
export function coverStyle(banner: Banner, url: string | undefined): CSSProperties | undefined {
  switch (banner.kind) {
    case 'preset':
      return { '--cover': `var(--banner-${banner.name})` };
    case 'image':
      return {
        ...(url && { '--cover': `url("${url}")`, '--cover-focal': `${banner.focal}%` }),
        '--cover-height': banner.height ?? 0,
        '--cover-fade': `${banner.fade ?? 0}%`,
      };
    default:
      return undefined;
  }
}
