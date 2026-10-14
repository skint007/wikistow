import type { Banner } from '@wikistow/client';
import type { CSSProperties } from 'react';

declare module 'react' {
  interface CSSProperties {
    '--cover'?: string;
    '--cover-focal'?: string;
  }
}

/**
 * The band's override of `--cover`, which `bg-cover-band` paints: set
 * through React's style prop, so through the CSSOM, which the CSP allows
 * where a style attribute in markup would not be. An image shows only once
 * decrypted to a local `blob:` URL; until then, the theme gradient.
 */
export function coverStyle(banner: Banner, url: string | undefined): CSSProperties | undefined {
  switch (banner.kind) {
    case 'preset':
      return { '--cover': `var(--banner-${banner.name})` };
    case 'image':
      return url ? { '--cover': `url("${url}")`, '--cover-focal': `${banner.focal}%` } : undefined;
    default:
      return undefined;
  }
}
