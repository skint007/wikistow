import { findProperty, propertyText, type Wikilink } from '@wikistow/client';
import { use } from 'react';
import { InLink, OtherPagesContext, PageBody, PageProperties } from './body-context';
import { referenceHint } from './other-pages';
import { bodyLinkScope, WikilinkChip } from './property-value';

// A reference to a value in a page body, `` `=servings` `` or
// `` `=[[Garlic bread]].cook_time` `` (ADR 0006, decisions 4 and 5), as the
// reader shows it: the value, as text or a link chip, never HTML made from it.

const UNKNOWN = 'No property has this name';
const NO_PAGE = 'No page has this title';

/**
 * A reference in a page body, written `source`, naming `name` of this page,
 * or of the page `page` links to: the value, with a dotted underline and a
 * hint naming the property, and the page for another's. A list shows
 * comma-separated, a date in the reader's locale, a page link as a chip
 * (as text in a link's text, which can't hold another).
 *
 * A reference that shows no value shows as written. For readers it is inert
 * code, the same whether the name is unknown, or the page is missing,
 * unpublished or not theirs to open, so it never says which. Editors see it
 * dashed, with a hint saying whether the page or the name is missing, as
 * their own tree and index have it.
 */
export function PropertyReferenceView({
  name,
  page,
  source,
}: {
  name: string;
  page?: Wikilink | undefined;
  source: string;
}) {
  const own = use(PageProperties);
  const others = use(OtherPagesContext);
  const body = use(PageBody);
  const inLink = use(InLink);
  const other = page ? others?.(page) : undefined;
  const properties = page ? (other?.kind === 'page' ? other.properties : null) : own;
  const property = properties ? findProperty(properties, name) : undefined;
  // On a link's text, the hint goes above it, as a link's does (`linkHint`).
  const side = inLink ? { 'data-hint-side': 'top' } : {};
  if (!property) {
    // Another page's, still being looked up: as readers see it, with no hint yet.
    const hint = page && other === undefined ? null : other?.kind === 'none' ? NO_PAGE : UNKNOWN;
    return body?.editing && hint ? (
      <code
        data-hint={hint}
        {...side}
        aria-description={hint}
        className="text-muted-foreground underline decoration-border decoration-dashed underline-offset-4"
      >
        {source}
      </code>
    ) : (
      <code className="text-muted-foreground">{source}</code>
    );
  }
  const hint = referenceHint(property, other?.kind === 'page' ? other : undefined);
  const text = propertyText(property);
  // Another page's link resolves by title, as that page's table isn't this one's.
  const scope = body && { ...bodyLinkScope(body), ...(page ? { links: new Map() } : {}) };
  const chip = property.type === 'wikilink' && scope && !inLink;
  return (
    <span
      data-hint={hint}
      // A link chip's text is a link's too, where it has no hint of its own.
      {...(chip ? { 'data-hint-side': 'top' } : side)}
      aria-description={hint}
      className="underline decoration-primary decoration-dotted decoration-[1.5px] underline-offset-4"
    >
      {chip ? (
        <WikilinkChip value={String(property.value)} scope={scope} />
      ) : text === '' ? (
        <span className="text-muted-foreground">–</span>
      ) : (
        text
      )}
    </span>
  );
}
