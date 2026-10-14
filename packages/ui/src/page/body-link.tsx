import type { ReactNode } from 'react';
import { InLink } from './body-context';

/** A link out of a page body, opened apart. */
export function BodyLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline">
      <InLink value>{children}</InLink>
    </a>
  );
}
