import { findProperty, propertyText, type PropertyData } from '@wikistow/client';
import { use } from 'react';
import { InLink, PageBody, PageProperties } from './body-context';
import { bodyLinkScope, WikilinkChip } from './property-value';

// A reference to one of the page's values in its body, `` `=servings` ``
// (ADR 0006, decision 4), as the reader shows it: the value, as text or a
// link chip, never HTML made from it.

/** The hint a value shown in the page gives: which property it is. */
export const referenceHint = (property: PropertyData) => `${property.key} · property`;

const UNKNOWN = 'No property has this name';

/**
 * A reference in a page body, written `source`, naming `name`: the page's
 * value, with a dotted underline and a hint naming the property. A list
 * shows comma-separated, a date in the reader's locale, a page link as a
 * chip (as text in a link's text, which can't hold another). A name no
 * property has shows as written: dashed, with a hint, for editors, and as
 * inert code for readers.
 */
export function PropertyReferenceView({ name, source }: { name: string; source: string }) {
  const properties = use(PageProperties);
  const body = use(PageBody);
  const inLink = use(InLink);
  const property = properties ? findProperty(properties, name) : undefined;
  if (!property) {
    return body?.editing ? (
      <code
        data-hint={UNKNOWN}
        aria-description={UNKNOWN}
        className="text-muted-foreground underline decoration-border decoration-dashed underline-offset-4"
      >
        {source}
      </code>
    ) : (
      <code className="text-muted-foreground">{source}</code>
    );
  }
  const hint = referenceHint(property);
  const text = propertyText(property);
  return (
    <span
      data-hint={hint}
      aria-description={hint}
      className="underline decoration-primary decoration-dotted decoration-[1.5px] underline-offset-4"
    >
      {property.type === 'wikilink' && body && !inLink ? (
        <WikilinkChip value={String(property.value)} scope={bodyLinkScope(body)} />
      ) : text === '' ? (
        <span className="text-muted-foreground">–</span>
      ) : (
        text
      )}
    </span>
  );
}
