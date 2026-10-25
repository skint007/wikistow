import {
  formatPropertyDate,
  type Property,
  type PropertyScalar,
  type PropertyValue,
} from '@wikistow/client';
import { MoreHorizontal, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { SearchLink } from '../shell/search-link';
import {
  convertValue,
  fieldText,
  PROPERTY_TYPES,
  propertyLabel,
  sameValue,
  typedItem,
  typedValue,
} from './property-model';
import {
  PropertyKey,
  PropertyPill,
  PropertyValueView,
  ROW,
  tagHint,
  tagQuery,
  TagPill,
  WikilinkChip,
  type LinkScope,
} from './property-value';

// One property's row on the draft view: its value edited in place, as the
// type it reads as, and its menu. Each change is handed up as the value it
// makes, and only when it is a change: setting a value to the text it is
// already can write it otherwise (`.inf` comes back quoted).

const FIELD = 'h-8 bg-background';
const BROKEN = 'It has a line break, which a field can’t show.';
const SHOWN =
  'block min-h-(--row) w-full min-w-0 rounded-row px-2 py-1 -mx-2 text-left wrap-anywhere hover:bg-background/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

/** Where in a row the focus goes next: its ⋯ button, or its value. */
export type RowFocus = 'menu' | 'value';

export function PropertyRow({
  property,
  scope,
  opened,
  onOpened,
  focus,
  onFocus,
  lock,
  referable,
  tagSearch = false,
  onSet,
  onRename,
  onRemove,
  onInsert,
  onAsText,
}: {
  property: Property;
  scope: LinkScope;
  /** Whether its value's field is open. */
  opened: boolean;
  onOpened: (open: boolean, keyboard?: boolean) => void;
  /** Where the focus goes once it's drawn, as after a field the keyboard closed; then `onFocus(null)`. */
  focus: RowFocus | null;
  onFocus: (at: RowFocus | null) => void;
  /** Why its value can't be edited where it is. */
  lock: string;
  /** Whether `` `=key` `` would show it. */
  referable: boolean;
  /** Its value is the page's tags (`tagProperties`), and each opens its search. */
  tagSearch?: boolean;
  /** Each returns whether the edit was made. */
  onSet: (value: PropertyValue) => boolean;
  /** `keyboard` when Enter renamed it, so the focus goes to its menu under the new name. */
  onRename: (to: string, keyboard: boolean) => boolean;
  onRemove: () => boolean;
  onInsert: () => void;
  onAsText: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const label = propertyLabel(property.key);
  // A field is one line: a value with a line break in it (`"a\nb"`) would lose it there.
  const broken = typeof property.value === 'string' && /[\r\n]/.test(property.value);
  const menu = useRef<HTMLButtonElement>(null);
  const value = useRef<HTMLElement>(null);
  // A field the keyboard closed, or one whose value now shows otherwise (a
  // checkbox for `true` typed), leaves the focus nowhere unless put back.
  useEffect(() => {
    if (!focus || renaming || opened) return;
    if (focus === 'menu') menu.current?.focus();
    else value.current?.querySelector<HTMLElement>('button, input')?.focus();
    onFocus(null);
  });
  return (
    <div className={cn(ROW, 'group')}>
      {renaming ? (
        <dt>
          <OneLine
            initial={property.key}
            label={`New name for ${label}`}
            onDone={(to, keyboard) => {
              const key = to?.trim();
              // As it was, its own spaces included, is no change.
              const kept =
                key === undefined || to === property.key || key === '' || key === property.key;
              if (!kept && !onRename(key, keyboard)) return;
              setRenaming(false);
              if (kept && keyboard) onFocus('menu');
            }}
          />
        </dt>
      ) : (
        <PropertyKey property={property}>
          <RowMenu
            trigger={menu}
            property={property}
            label={label}
            referable={referable}
            onSet={onSet}
            onRename={() => setRenaming(true)}
            onRemove={onRemove}
            onInsert={onInsert}
            onAsText={onAsText}
          />
        </PropertyKey>
      )}
      <dd ref={value} className="min-w-0">
        {property.editable && !broken ? (
          <ValueField
            property={property}
            label={label}
            scope={scope}
            opened={opened}
            onOpened={onOpened}
            tagSearch={tagSearch}
            onSet={onSet}
          />
        ) : (
          <div className="grid gap-0.5 py-1">
            <PropertyValueView
              property={property}
              scope={{ ...scope, editor: true }}
              tagSearch={tagSearch}
            />
            <span className="text-xs text-muted-foreground">
              {property.editable ? BROKEN : lock}{' '}
              <button
                type="button"
                onClick={onAsText}
                className="font-bold text-foreground underline-offset-2 hover:underline"
              >
                Edit as text
              </button>
            </span>
          </div>
        )}
      </dd>
    </div>
  );
}

/** A row's ⋯ button and its menu, shown on hover and focus, and always on touch. */
function RowMenu({
  trigger,
  property,
  label,
  referable,
  onSet,
  onRename,
  onRemove,
  onInsert,
  onAsText,
}: {
  trigger: RefObject<HTMLButtonElement | null>;
  property: Property;
  label: string;
  referable: boolean;
  onSet: (value: PropertyValue) => boolean;
  onRename: () => void;
  onRemove: () => boolean;
  onInsert: () => void;
  onAsText: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        ref={trigger}
        aria-label={`Actions for ${label}`}
        className="ml-auto grid size-6 shrink-0 place-items-center rounded-row text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:tint focus:opacity-100 active:tint-strong pointer-coarse:opacity-100 data-[state=open]:opacity-100"
      >
        <MoreHorizontal className="size-4" strokeWidth={1.75} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={onRename}>Rename</DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={!property.editable}>Type</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <TypeItems property={property} onSet={onSet} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem disabled={!referable} onSelect={onInsert}>
          Insert in page
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onAsText}>Edit as text</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => void onRemove()}>
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The types a value can be written as, each offered only if it reads as
 * that once written so. Drawn only as the submenu opens: each is worked
 * out by writing and reading the value.
 */
function TypeItems({
  property,
  onSet,
}: {
  property: Property;
  onSet: (value: PropertyValue) => boolean;
}) {
  return (
    <DropdownMenuRadioGroup value={property.type}>
      {PROPERTY_TYPES.map(({ type, label }) => {
        const value = type === property.type ? null : convertValue(property.value, type);
        return (
          <DropdownMenuRadioItem
            key={type}
            value={type}
            disabled={type !== property.type && value === null}
            onSelect={() => {
              if (value !== null) onSet(value);
            }}
          >
            {label}
          </DropdownMenuRadioItem>
        );
      })}
    </DropdownMenuRadioGroup>
  );
}

/** An editable value, as its type is edited. */
function ValueField({
  property,
  label,
  scope,
  opened,
  onOpened,
  tagSearch,
  onSet,
}: {
  property: Property;
  label: string;
  scope: LinkScope;
  opened: boolean;
  onOpened: (open: boolean, keyboard?: boolean) => void;
  tagSearch: boolean;
  onSet: (value: PropertyValue) => boolean;
}) {
  const { type, value } = property;
  if (type === 'boolean') {
    return (
      <span className="flex min-h-(--row) items-center">
        <input
          type="checkbox"
          checked={value === true}
          aria-label={label}
          onChange={(event) => onSet(event.target.checked)}
        />
      </span>
    );
  }
  if (Array.isArray(value)) {
    return <ListField label={label} value={value} tagSearch={tagSearch} onSet={onSet} />;
  }
  return (
    <TextField
      property={property}
      label={label}
      scope={scope}
      opened={opened}
      onOpened={onOpened}
      tagSearch={tagSearch}
      onSet={onSet}
    />
  );
}

/**
 * A value shown as it reads, a field once clicked: Enter or leaving it
 * keeps what's typed, Escape doesn't. A day alone is a date field. A tag
 * alone is its pill, which opens its search, over the field's button.
 */
function TextField({
  property: { type, value },
  label,
  scope,
  opened,
  onOpened,
  tagSearch,
  onSet,
}: {
  property: Property;
  label: string;
  scope: LinkScope;
  opened: boolean;
  onOpened: (open: boolean, keyboard?: boolean) => void;
  tagSearch: boolean;
  onSet: (value: PropertyValue) => boolean;
}) {
  const text = fieldText(value);
  if (opened) {
    const day = type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(text);
    return (
      <OneLine
        initial={text}
        label={label}
        type={day ? 'date' : type === 'url' ? 'url' : 'text'}
        onDone={(typed, keyboard) => {
          const next = typed === undefined ? value : typedValue(typed, value);
          if (sameValue(next, value) || onSet(next)) onOpened(false, keyboard);
        }}
      />
    );
  }
  const scalar = value as PropertyScalar;
  const edit = `${label}: ${text || 'empty'}. Edit`;
  const query = tagSearch && (type === 'text' || type === 'number') ? tagQuery(scalar) : null;
  if (query !== null) {
    // The button first, as the focus put back finds it, and under the pill,
    // so a click beside the pill opens the field, as beside a list's pills:
    // the pill leaves it the row's end, however long the tag.
    return (
      <div className="relative flex min-h-(--row) items-center pr-8">
        <button
          type="button"
          aria-label={edit}
          onClick={() => onOpened(true)}
          className={cn(SHOWN, 'absolute inset-y-0 left-0')}
        />
        <span className="relative flex min-w-0">
          <TagPill query={query}>{text}</TagPill>
        </span>
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-label={edit}
      onClick={() => onOpened(true)}
      className={cn(SHOWN, type === 'number' && 'tabular-nums')}
    >
      {scalar === null || scalar === '' ? (
        <span className="text-muted-foreground">Empty</span>
      ) : type === 'wikilink' ? (
        <WikilinkChip value={text} scope={scope} navigable={false} />
      ) : type === 'date' ? (
        formatPropertyDate(text)
      ) : type === 'url' ? (
        <span className="text-primary underline">{text}</span>
      ) : (
        text
      )}
    </button>
  );
}

/**
 * A list's items as pills, each with a button that removes it, and a field
 * that adds one. A tag's text opens its search, and its button stays its own.
 */
function ListField({
  label,
  value,
  tagSearch,
  onSet,
}: {
  label: string;
  value: readonly (PropertyScalar | readonly PropertyScalar[])[];
  tagSearch: boolean;
  onSet: (value: PropertyValue) => boolean;
}) {
  const [text, setText] = useState('');
  const add = () => {
    if (text.trim() === '') return;
    if (onSet([...value, typedItem(text, value)])) setText('');
  };
  return (
    <div className="flex min-h-(--row) flex-wrap items-center gap-1">
      {value.map((item, i) => {
        const shown = Array.isArray(item)
          ? item.map((part) => (part === null ? '' : String(part))).join(', ')
          : item === null
            ? ''
            : String(item);
        const query = tagSearch ? tagQuery(item) : null;
        return (
          // A tag's text, its padding too, is its link.
          <PropertyPill key={i} className={cn('gap-0.5 pr-0.5', query !== null && 'py-0 pl-0')}>
            {query === null ? (
              shown
            ) : (
              <SearchLink
                query={query}
                hint={tagHint(query)}
                className="rounded-full py-0.5 pl-2 underline-offset-2 hover:underline"
              >
                {shown}
              </SearchLink>
            )}
            {/* An item's own button, after its text. */}
            <button
              type="button"
              aria-label={`Remove ${shown || 'empty item'} from ${label}`}
              onClick={() => onSet(value.filter((_, j) => j !== i))}
              className="grid size-4 place-items-center rounded-full text-muted-foreground hover:tint hover:text-foreground"
            >
              <X className="size-3" strokeWidth={2} />
            </button>
          </PropertyPill>
        );
      })}
      <input
        aria-label={`Add to ${label}`}
        placeholder="Add…"
        value={text}
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (composing(event)) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            add();
          } else if (event.key === 'Escape') {
            setText('');
          }
        }}
        onBlur={add}
        className="h-6 w-24 min-w-0 flex-1 rounded-row bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring"
      />
    </div>
  );
}

/**
 * A one-line field, focused as it opens. `onDone` gets what's typed as
 * Enter is pressed or the field is left, or undefined for Escape, and
 * whether the keyboard closed it.
 */
function OneLine({
  initial,
  label,
  type = 'text',
  onDone,
}: {
  initial: string;
  label: string;
  type?: 'text' | 'date' | 'url';
  onDone: (typed: string | undefined, keyboard: boolean) => void;
}) {
  const [text, setText] = useState(initial);
  // Set as Enter or Escape is pressed, so leaving it then does nothing more
  // until something else is typed, as after an edit that couldn't be made.
  const done = useRef(false);
  return (
    <Input
      autoFocus
      aria-label={label}
      type={type}
      value={text}
      spellCheck={false}
      onChange={(event) => {
        done.current = false;
        setText(event.target.value);
      }}
      onKeyDown={(event) => {
        // Enter that ends an IME's composition is the IME's.
        if ((event.key !== 'Enter' && event.key !== 'Escape') || composing(event)) return;
        event.preventDefault();
        // A date half typed reads as nothing: Enter waits for the rest.
        const half = event.currentTarget.validity.badInput;
        if (event.key === 'Enter' && half) return;
        done.current = true;
        onDone(event.key === 'Enter' ? text : undefined, true);
      }}
      onBlur={(event) => {
        // Left half typed, it puts back what was there.
        if (!done.current) onDone(event.currentTarget.validity.badInput ? undefined : text, false);
      }}
      className={FIELD}
    />
  );
}

/**
 * Whether a key ends an IME's composition, and so is the IME's: Safari
 * sends the Enter that does with `isComposing` false, and key code 229.
 */
export const composing = (event: KeyboardEvent<HTMLElement>) =>
  event.nativeEvent.isComposing || event.keyCode === 229;
