import type { ReactNode } from 'react';
import { linkHint } from '../desktop';
import { InLink } from './body-context';

/**
 * A link out of a page body, opened apart. In the desktop app its hint says
 * where it goes, except for a place in this page (a footnote's `#…`).
 */
export function BodyLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-hint={href.startsWith('#') ? undefined : linkHint(href)}
      className="text-primary underline"
    >
      <InLink value>{children}</InLink>
    </a>
  );
}
