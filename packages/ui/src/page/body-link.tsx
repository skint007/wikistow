import type { ReactNode } from 'react';
import { linkHint } from '../desktop';
import { InLink } from './body-context';

/** A link out of a page body, opened apart. */
export function BodyLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-hint={linkHint(href)}
      className="text-primary underline"
    >
      <InLink value>{children}</InLink>
    </a>
  );
}
