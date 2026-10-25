import {
  formatPropertyDate,
  PageId,
  SpaceId,
  parseWikilink,
  propertyText,
  type LinkablePage,
  type Property,
  type PropertyData,
  type PropertyScalar,
  type PropertyType,
  type PropertyValue,
} from '@wikistow/client';
import { Link } from '@tanstack/react-router';
import {
  AlignLeft,
  Calendar,
  FileText,
  Globe,
  Hash,
  List,
  SquareCheck,
  Tags,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { linkHint } from '../desktop';
import { filterQuery, SearchLink } from '../shell/search-link';
import type { PageBodyContext } from './body-context';
import { propertyLabel } from './property-model';
import { wikilinkView } from './wikilink-model';

// A property's value as the rows show it (ADR 0006): each type its own way,
// and only ever text or a link, never HTML made from the value.

/** The icon a row's key shows for its value's type. */
export function propertyIcon(type: PropertyType, key: string): LucideIcon {
  if (type === 'list') return key.trim().toLowerCase() === 'tags' ? Tags : List;
  return ICONS[type];
}

const ICONS = {
  text: AlignLeft,
  number: Hash,
  boolean: SquareCheck,
  date: Calendar,
  url: Globe,
  wikilink: FileText,
} satisfies Record<Exclude<PropertyType, 'list'>, LucideIcon>;

/**
 * A row: its key in a column of its own, narrower where the page is, and
 * its value, each line `--row` high (set by the rows around it), so a key
 * sits level with its value's first line.
 */
export const ROW =
  'grid min-w-0 grid-cols-[7.5rem_minmax(0,1fr)] items-start gap-x-3 py-0.5 leading-6 @min-[28rem]:grid-cols-[150px_minmax(0,1fr)]';

/** A row's key: its type's icon, then the key in sentence case, the key as written in its hint. */
export function PropertyKey({ property, children }: { property: Property; children?: ReactNode }) {
  const Icon = propertyIcon(property.type, property.key);
  const label = propertyLabel(property.key);
  return (
    <dt className="flex min-h-(--row) min-w-0 items-center gap-1.5 text-[13px] font-semibold text-subtle-foreground">
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
      <span
        className="min-w-0 truncate"
        {...(label === property.key ? {} : { 'data-hint': property.key })}
      >
        {label}
      </span>
      {children}
    </dt>
  );
}

/** What a page link in a value resolves against: the viewer's pages, and whether they edit this page. */
export type LinkScope = {
  spaceId: string;
  selfId: string;
  /** The pages the viewer can open in the space; null until loaded. */
  pages: readonly LinkablePage[] | null;
  /** The version's link table, key → page ID. */
  links: ReadonlyMap<string, string>;
  /** The viewer edits the page, and so sees links that don't resolve as such. */
  editor: boolean;
};

/** The link scope of a page body (`PageBody`). */
export const bodyLinkScope = ({
  attachments,
  pages,
  links,
  editing,
}: PageBodyContext): LinkScope => ({
  spaceId: attachments.page.spaceId,
  selfId: attachments.page.pageId,
  pages,
  links,
  editor: editing !== null,
});

const CHIP = 'inline rounded-row bg-primary-soft px-1.5 py-px font-bold text-primary-ink';
const UNRESOLVED = 'text-muted-foreground underline decoration-dashed underline-offset-2';

/**
 * A value that is one wikilink (`"[[Tomato soup]]"`), as a chip that opens
 * its page, resolved as a body's wikilinks are. A reader who can't open the
 * page sees its text, the same whether it's missing or not theirs; an
 * editor sees one that doesn't resolve dashed. Unless `navigable`, the chip
 * opens nothing, as where a click edits the value.
 */
export function WikilinkChip({
  value,
  scope,
  navigable = true,
}: {
  value: string;
  scope: LinkScope;
  navigable?: boolean;
}) {
  const link = parseWikilink(value);
  if (!link) return value;
  const view = wikilinkView(link, {
    pages: scope.pages,
    links: scope.links,
    selfId: scope.selfId,
    attachments: [],
    editor: scope.editor,
  });
  switch (view.kind) {
    case 'page':
      if (!navigable) return <span className={CHIP}>{view.text}</span>;
      return (
        <Link
          to="/s/$spaceId/p/$pageId"
          params={{ spaceId: SpaceId.parse(scope.spaceId), pageId: PageId.parse(view.pageId) }}
          {...(view.hash ? { hash: view.hash } : {})}
          {...linkHint(view.name)}
          className={cn(CHIP, 'hover:underline')}
        >
          {view.text}
        </Link>
      );
    case 'missing':
    case 'ambiguous': {
      const hint =
        view.kind === 'missing' ? 'No page has this title' : 'More than one page has this title';
      return (
        <span data-hint={hint} aria-description={hint} className={UNRESOLVED}>
          {view.text}
        </span>
      );
    }
    default:
      return view.text;
  }
}

/** A list item's text: a list in it comma-separated. */
const itemText = (item: PropertyValue) =>
  Array.isArray(item)
    ? item.map((part) => (part === null ? '' : String(part))).join(', ')
    : item === null
      ? ''
      : String(item as PropertyScalar);

const PILL =
  'inline-flex max-w-full min-w-0 items-center rounded-full bg-folder-blue px-2 py-0.5 text-xs font-semibold wrap-anywhere text-foreground';

/** A pill, as a list's items show. */
export function PropertyPill({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn(PILL, className)}>{children}</span>;
}

/**
 * The search for a tag a value's item is, as `tag:` search reads it
 * (`filterQuery`), or null for an item that isn't one: nothing, a list, or
 * no more than a `#`.
 */
export function tagQuery(item: PropertyValue): string | null {
  if (item === null || Array.isArray(item)) return null;
  return filterQuery('tag', String(item as PropertyScalar)) || null;
}

/** What a tag's link opens, as its hint says: `Search tag:soup`. */
export const tagHint = (query: string) => `Search ${query}`;

/** A pill that opens its tag's search over the page (`SearchLink`), underlined on hover. */
export function TagPill({ query, children }: { query: string; children: ReactNode }) {
  return (
    <SearchLink
      query={query}
      hint={tagHint(query)}
      className={cn(PILL, 'underline-offset-2 hover:underline')}
    >
      {children}
    </SearchLink>
  );
}

const EMPTY = <span className="text-muted-foreground">Empty</span>;

/**
 * A property's value as the reader's rows show it: a list as pills, a
 * checkbox, a date in the reader's locale, a web address as a link, a page
 * link as a chip (`WikilinkChip`), a number or text as it reads. With
 * `tagSearch`, each tag opens its search (`TagPill`), one alone a pill too.
 */
export function PropertyValueView({
  property: { key, type, value },
  scope,
  tagSearch = false,
}: {
  property: PropertyData;
  scope: LinkScope;
  /** The value is the page's tags (`tagProperties`), and each links to its search. */
  tagSearch?: boolean;
}) {
  if (Array.isArray(value)) {
    if (value.length === 0) return EMPTY;
    return (
      <span className="flex min-h-(--row) flex-wrap items-center gap-1">
        {value.map((item: PropertyValue, i) => {
          const query = tagSearch ? tagQuery(item) : null;
          return query === null ? (
            <PropertyPill key={i}>{itemText(item)}</PropertyPill>
          ) : (
            <TagPill key={i} query={query}>
              {itemText(item)}
            </TagPill>
          );
        })}
      </span>
    );
  }
  if (value === null || value === '') return EMPTY;
  // A tag alone, unless it shows as its type: a date, say, or a checkbox.
  const query = tagSearch && (type === 'text' || type === 'number') ? tagQuery(value) : null;
  if (query !== null) {
    return (
      <span className="flex min-h-(--row) items-center">
        <TagPill query={query}>{String(value)}</TagPill>
      </span>
    );
  }
  switch (type) {
    case 'boolean':
      return (
        <span className="flex min-h-(--row) items-center">
          <input
            type="checkbox"
            checked={value === true}
            disabled
            aria-label={propertyLabel(key)}
          />
        </span>
      );
    case 'date':
      return <time dateTime={String(value)}>{formatPropertyDate(String(value))}</time>;
    case 'url':
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noopener noreferrer"
          {...linkHint(String(value))}
          className="text-primary underline wrap-anywhere"
        >
          {String(value)}
        </a>
      );
    case 'wikilink':
      return <WikilinkChip value={String(value)} scope={scope} />;
    case 'number':
      return <span className="tabular-nums">{String(value)}</span>;
    default:
      return (
        <span className="whitespace-pre-wrap wrap-anywhere">{propertyText({ type, value })}</span>
      );
  }
}
