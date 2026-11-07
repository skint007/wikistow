import {
  findProperty,
  readProperties,
  removeProperty,
  renameProperty,
  setProperty,
  tagProperties,
  type Property,
  type PropertyEdit,
  type PropertyValue,
} from '@wikistow/client';
import { ChevronRight, Plus } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { cn } from '@/lib/utils';
import { propertiesText, withProperties } from './properties';
import { propertyLabel, referable } from './property-model';
import { composing, PropertyRow, type RowFocus } from './property-rows';
import { usePropertiesShown } from './properties-shown';
import { PropertyKey, PropertyValueView, ROW, type LinkScope } from './property-value';

// A page's frontmatter as rows (ADR 0006), between its status pills and its
// body: one row per property, its key in sentence case and its value as the
// type it reads as. A block that doesn't read as properties is its text.
// The box collapses to one line, as it starts unless the person opened it
// on this page or turned on Show properties (`usePropertiesShown`).

/** The page whose properties are shown, for which their box's open state is kept. */
type ShownPage = Parameters<typeof usePropertiesShown>[0];

/** The keys pages near this one use, loaded once asked for: undefined until then. */
export type PropertyKeys = { keys: readonly string[] | undefined; load: () => void };

/** How many rows the reader shows before **Show N more**. */
export const SHOWN_ROWS = 6;

const PANEL = '@container grid gap-1 rounded-control bg-muted px-3 py-2 text-sm';
// Each row's line: a line of text read, a field's height edited.
const READ = '[--row:1.5rem]';
const EDITED = '[--row:2rem]';
const MONO = 'font-mono text-[13px] leading-relaxed';

/**
 * The Properties region: its first line, `summary`, opens and closes it,
 * and `children` show under it while it's open.
 */
function Collapsible({
  summary,
  shown,
  onShown,
  className,
  children,
}: {
  summary: string;
  shown: boolean;
  onShown: (shown: boolean) => void;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-label="Properties" className={cn(PANEL, className)}>
      <button
        type="button"
        aria-expanded={shown}
        aria-controls={shown ? id : undefined}
        onClick={() => onShown(!shown)}
        className="-mx-1 flex items-center gap-1 rounded-row px-1 text-left font-bold text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden
          className={cn('size-4 shrink-0 transition-transform', shown && 'rotate-90')}
          strokeWidth={1.75}
        />
        {summary}
      </button>
      {shown && (
        <div id={id} className="grid gap-1">
          {children}
        </div>
      )}
    </section>
  );
}

const count = (properties: readonly Property[]) => `Properties · ${properties.length}`;
const AS_TEXT = 'Properties (as text)';

/** Why a block shows as its text: one line. */
const Why = ({ reason }: { reason: string }) => (
  <p className="text-xs text-muted-foreground">Shown as text: {reason}</p>
);

/**
 * A page's properties, read-only: a row for each, the first six and then
 * **Show N more**. A block that doesn't read as properties shows as its
 * text, with a line saying why. A block with no properties shows nothing.
 * It sits in the body, not among the page's panels, which open from the
 * toolbar.
 */
export function PropertiesBox({
  frontmatter,
  scope,
  page,
}: {
  frontmatter: string;
  scope: LinkScope;
  page: ShownPage;
}) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = usePropertiesShown(page);
  const read = useMemo(() => readProperties(frontmatter), [frontmatter]);
  if (!read.ok) {
    return (
      <Collapsible summary={AS_TEXT} shown={open} onShown={setOpen}>
        <pre className={cn(MONO, 'overflow-x-auto')}>{propertiesText(frontmatter)}</pre>
        <Why reason={read.reason} />
      </Collapsible>
    );
  }
  const { properties } = read;
  if (properties.length === 0) return null;
  const more = properties.length - SHOWN_ROWS;
  const shown = all || more <= 0 ? properties : properties.slice(0, SHOWN_ROWS);
  const tags = tagProperties(properties);
  return (
    <Collapsible summary={count(properties)} shown={open} onShown={setOpen} className={READ}>
      <dl className="grid">
        {shown.map((property) => (
          <div key={property.key} className={ROW}>
            <PropertyKey property={property} />
            <dd className="min-w-0">
              <PropertyValueView
                property={property}
                scope={scope}
                tagSearch={tags.includes(property)}
              />
            </dd>
          </div>
        ))}
      </dl>
      {more > 0 && (
        <div>
          <Button size="sm" variant="ghost" className="-ml-2" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show ${more} more`}
          </Button>
        </div>
      )}
    </Collapsible>
  );
}

/**
 * The draft's frontmatter as rows, each value edited in place, which
 * changes only that value's characters in the block (`setProperty`), and
 * each row's menu renames, retypes, removes or puts a reference to it in
 * the page. **Add property** adds a key at the block's end, and **Edit as
 * text** shows the text between the delimiters to edit as it is, as a
 * block that doesn't read as properties always shows. The box opens on its
 * own for something to do, a property being added or a block to fix, which
 * leaves what's kept for the page as it was.
 */
export function PropertiesEditor({
  frontmatter,
  scope,
  page,
  adding: addingFirst = false,
  onChange,
  onRemove,
  onInsert,
  propertyKeys,
}: {
  frontmatter: string;
  scope: LinkScope;
  page: ShownPage;
  /** The keys pages in the same folder use, which Add property suggests. */
  propertyKeys?: PropertyKeys | undefined;
  /** Open with a new property's name being typed, as when the block was just added. */
  adding?: boolean;
  onChange: (frontmatter: string) => void;
  onRemove: () => void;
  /** Put a reference to a property, `` `=key` ``, where the page's cursor is. */
  onInsert: (code: string) => void;
}) {
  // Shown as text: as the person chose, or as a block that didn't read,
  // which stays text until they go back to rows, not as soon as it reads.
  const [asText, setAsText] = useState<'chosen' | 'unread' | null>(null);
  const [adding, setAdding] = useState(addingFirst);
  const [kept, keep] = usePropertiesShown(page);
  // Opened on its own, until the person closes it.
  const [itself, setItself] = useState(addingFirst);
  const open = kept || itself;
  const setOpen = (next: boolean) => {
    setItself(false);
    if (next !== kept) keep(next);
  };
  // The keys to suggest are loaded only once a property is being added.
  const load = propertyKeys?.load;
  useEffect(() => {
    if (adding) load?.();
  }, [adding, load]);
  const [error, setError] = useState<string | null>(null);
  // The row whose value is being typed, by key.
  const [opened, setOpened] = useState<string | null>(null);
  // Where the focus goes back to once a row is drawn, by key.
  const [focusing, setFocusing] = useState<{ key: string; at: RowFocus } | null>(null);
  const read = useMemo(() => readProperties(frontmatter), [frontmatter]);
  if (!read.ok && asText === null) {
    setAsText('unread');
    setItself(true);
  }
  // Why each value that can't change in place can't.
  const locks = useMemo(
    () =>
      new Map(
        (read.ok ? read.properties : [])
          .filter((property) => !property.editable)
          .map((property) => [property.key, lockOf(frontmatter, property)]),
      ),
    [frontmatter, read],
  );
  const addButton = useRef<HTMLButtonElement>(null);

  /** Take `edit`, of the property `label`, or say why it can't be made. */
  const apply = (edit: PropertyEdit, label: string): boolean => {
    if (!edit.ok) {
      setError(`Couldn’t change ${label}. ${edit.reason}`);
      return false;
    }
    setError(null);
    if (edit.frontmatter !== frontmatter) onChange(edit.frontmatter);
    return true;
  };

  if (!read.ok || asText) {
    return (
      <Collapsible summary={AS_TEXT} shown={open} onShown={setOpen}>
        <PropertiesText
          frontmatter={frontmatter}
          focus={asText === 'chosen'}
          reason={read.ok ? null : read.reason}
          onChange={onChange}
          onRemove={onRemove}
          onRows={
            read.ok
              ? () => {
                  setError(null);
                  setAsText(null);
                }
              : null
          }
        />
      </Collapsible>
    );
  }
  const { properties } = read;
  const label = (property: Property) => propertyLabel(property.key);
  const tags = tagProperties(properties);
  const focusFor = (key: string) => (at: RowFocus | null) => setFocusing(at ? { key, at } : null);
  return (
    <Collapsible summary={count(properties)} shown={open} onShown={setOpen} className={EDITED}>
      {properties.length > 0 && (
        <dl className="grid">
          {properties.map((property) => (
            <PropertyRow
              key={property.key}
              property={property}
              scope={scope}
              opened={opened === property.key}
              onOpened={(open, keyboard) => {
                setOpened(open ? property.key : null);
                if (!open && keyboard) setFocusing({ key: property.key, at: 'value' });
              }}
              focus={focusing?.key === property.key ? focusing.at : null}
              onFocus={focusFor(property.key)}
              lock={locks.get(property.key) ?? ''}
              referable={referable(property, properties)}
              tagSearch={tags.includes(property)}
              onSet={(value: PropertyValue) =>
                apply(setProperty(frontmatter, property.key, value), label(property))
              }
              onRename={(to, keyboard) => {
                const renamed = apply(
                  renameProperty(frontmatter, property.key, to),
                  label(property),
                );
                if (renamed && keyboard) setFocusing({ key: to, at: 'menu' });
                return renamed;
              }}
              onRemove={() => {
                const removed = apply(removeProperty(frontmatter, property.key), label(property));
                // Its row and menu have gone: the focus goes on from the rows' end.
                if (removed) requestAnimationFrame(() => addButton.current?.focus());
                return removed;
              }}
              onInsert={() => onInsert(`=${property.key.trim()}`)}
              onAsText={() => setAsText('chosen')}
            />
          ))}
        </dl>
      )}
      <div className="flex flex-wrap gap-1">
        <Button
          ref={addButton}
          size="sm"
          variant="ghost"
          className="-ml-2"
          onClick={() => {
            setError(null);
            setAdding(true);
          }}
        >
          <Plus className="size-4" strokeWidth={1.75} />
          Add property
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAsText('chosen')}>
          Edit as text
        </Button>
      </div>
      {/* Under the buttons, so that leaving it empty, which closes it, moves none of them. */}
      {adding && (
        <NewProperty
          suggested={propertyKeys?.keys?.filter((key) => !findProperty(properties, key))}
          onCancel={() => setAdding(false)}
          onAdd={(key) => {
            if (properties.some((property) => property.key === key)) {
              setError(`There is already a property ${key}.`);
              return;
            }
            if (!apply(setProperty(frontmatter, key, null), key)) return;
            setAdding(false);
            setOpened(key);
          }}
        />
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </Collapsible>
  );
}

// Why `property` can't be changed where it is, as `setProperty` says: it is
// asked for a value it can't have, so the block it gives is never taken.
function lockOf(frontmatter: string, property: Property): string {
  const edit = setProperty(frontmatter, property.key, [[], []]);
  return edit.ok ? '' : edit.reason;
}

/**
 * The name of a property being added, typed in a row of its own, with the
 * keys pages in the same folder use offered under it once they're known.
 * Picking one adds it.
 */
function NewProperty({
  suggested,
  onAdd,
  onCancel,
}: {
  suggested: readonly string[] | undefined;
  onAdd: (key: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [name, setName] = useState('');
  const add = (typed: string) => {
    const key = typed.trim();
    if (key === '') onCancel();
    else onAdd(key);
  };
  return (
    <div className="max-w-xs py-0.5">
      <Combobox
        id={id}
        value={name}
        onChange={setName}
        options={
          suggested && suggested.length > 0
            ? suggested.map((key) => ({ value: key, label: null }))
            : undefined
        }
        noun="keys used in this folder"
        placeholder="Name"
        onPick={add}
        field={{
          autoFocus: true,
          'aria-label': 'New property’s name',
          className: 'h-8 bg-background',
          onKeyDown: (event) => {
            if (composing(event)) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              add(name);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            }
          },
          onBlur: () => {
            if (name.trim() === '') onCancel();
          },
        }}
      />
    </div>
  );
}

/**
 * The block's text between its delimiters, editable as plain text: what's
 * typed goes between the delimiters, and the rest of the block stays as
 * written. A block that doesn't read as properties says why, and can't go
 * back to rows (`onRows`) until it does.
 */
function PropertiesText({
  frontmatter,
  focus,
  reason,
  onChange,
  onRemove,
  onRows,
}: {
  frontmatter: string;
  /** Focus the text as it opens, as when the person asked for it. */
  focus: boolean;
  reason: string | null;
  onChange: (frontmatter: string) => void;
  onRemove: () => void;
  onRows: (() => void) | null;
}) {
  const text = propertiesText(frontmatter);
  const ends = text.split('\n').some((line) => /^(?:---|\.\.\.)\r?$/.test(line));
  return (
    <>
      <textarea
        autoFocus={focus}
        aria-label="Properties as text"
        value={text}
        rows={Math.max(3, text.split('\n').length + 1)}
        spellCheck={false}
        onChange={(event) => onChange(withProperties(frontmatter, event.target.value))}
        className={cn(
          MONO,
          'w-full resize-y rounded-control border border-input bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      />
      {reason && <Why reason={reason} />}
      {ends && (
        <p className="text-xs text-muted-foreground">
          A line of only --- or ... ends the properties. What follows it is part of the page.
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        {onRows && (
          <Button size="sm" variant="ghost" className="-ml-2" onClick={onRows}>
            Show as rows
          </Button>
        )}
        <Button size="sm" variant="ghost" className={cn(!onRows && '-ml-2')} onClick={onRemove}>
          Remove properties
        </Button>
      </div>
    </>
  );
}
