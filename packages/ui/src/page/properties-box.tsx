import {
  readProperties,
  removeProperty,
  renameProperty,
  setProperty,
  type Property,
  type PropertyEdit,
  type PropertyValue,
} from '@wikistow/client';
import { Plus } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { propertiesText, withProperties } from './properties';
import { propertyLabel, referable } from './property-model';
import { composing, PropertyRow, type RowFocus } from './property-rows';
import { PropertyKey, PropertyValueView, ROW, type LinkScope } from './property-value';

// A page's frontmatter as rows (ADR 0006), between its status pills and its
// body: one row per property, its key in sentence case and its value as the
// type it reads as. A block that doesn't read as properties is its text.

/** How many rows the reader shows before **Show N more**. */
export const SHOWN_ROWS = 6;

const PANEL = '@container grid gap-1 rounded-control bg-muted px-3 py-2 text-sm';
// Each row's line: a line of text read, a field's height edited.
const READ = '[--row:1.5rem]';
const EDITED = '[--row:2rem]';
const MONO = 'font-mono text-[13px] leading-relaxed';

/** Why a block shows as its text: one line. */
const Why = ({ reason }: { reason: string }) => (
  <p className="text-xs text-muted-foreground">Shown as text: {reason}</p>
);

/**
 * A page's properties, read-only: a row for each, the first six and then
 * **Show N more**. A block that doesn't read as properties shows as its
 * text, with a line saying why. A block with no properties shows nothing.
 * It sits in the body, not among the `pagePanels`, which open from the
 * toolbar.
 */
export function PropertiesBox({ frontmatter, scope }: { frontmatter: string; scope: LinkScope }) {
  const [all, setAll] = useState(false);
  const read = useMemo(() => readProperties(frontmatter), [frontmatter]);
  if (!read.ok) {
    return (
      <section aria-label="Properties" className={PANEL}>
        <pre className={cn(MONO, 'overflow-x-auto')}>{propertiesText(frontmatter)}</pre>
        <Why reason={read.reason} />
      </section>
    );
  }
  const { properties } = read;
  if (properties.length === 0) return null;
  const more = properties.length - SHOWN_ROWS;
  const shown = all || more <= 0 ? properties : properties.slice(0, SHOWN_ROWS);
  return (
    <section aria-label="Properties" className={cn(PANEL, READ)}>
      <dl className="grid">
        {shown.map((property) => (
          <div key={property.key} className={ROW}>
            <PropertyKey property={property} />
            <dd className="min-w-0">
              <PropertyValueView property={property} scope={scope} />
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
    </section>
  );
}

/**
 * The draft's frontmatter as rows, each value edited in place, which
 * changes only that value's characters in the block (`setProperty`), and
 * each row's menu renames, retypes, removes or puts a reference to it in
 * the page. **Add property** adds a key at the block's end, and **Edit as
 * text** shows the text between the delimiters to edit as it is, as a
 * block that doesn't read as properties always shows.
 */
export function PropertiesEditor({
  frontmatter,
  scope,
  adding: addingFirst = false,
  onChange,
  onRemove,
  onInsert,
}: {
  frontmatter: string;
  scope: LinkScope;
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
  const [error, setError] = useState<string | null>(null);
  // The row whose value is being typed, by key.
  const [opened, setOpened] = useState<string | null>(null);
  // Where the focus goes back to once a row is drawn, by key.
  const [focusing, setFocusing] = useState<{ key: string; at: RowFocus } | null>(null);
  const read = useMemo(() => readProperties(frontmatter), [frontmatter]);
  if (!read.ok && asText === null) setAsText('unread');
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
    );
  }
  const { properties } = read;
  const label = (property: Property) => propertyLabel(property.key);
  const focusFor = (key: string) => (at: RowFocus | null) => setFocusing(at ? { key, at } : null);
  return (
    <section aria-label="Properties" className={cn(PANEL, EDITED)}>
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
      {adding && (
        <NewProperty
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
    </section>
  );
}

// Why `property` can't be changed where it is, as `setProperty` says: it is
// asked for a value it can't have, so the block it gives is never taken.
function lockOf(frontmatter: string, property: Property): string {
  const edit = setProperty(frontmatter, property.key, [[], []]);
  return edit.ok ? '' : edit.reason;
}

/** The name of a property being added, typed in a row of its own. */
function NewProperty({ onAdd, onCancel }: { onAdd: (key: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const add = () => {
    const key = name.trim();
    if (key === '') onCancel();
    else onAdd(key);
  };
  return (
    <div className={ROW}>
      <Input
        autoFocus
        aria-label="New property’s name"
        placeholder="Name"
        value={name}
        spellCheck={false}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (composing(event)) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            add();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          if (name.trim() === '') onCancel();
        }}
        className="h-8 bg-background"
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
    <section aria-label="Properties" className={PANEL}>
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
    </section>
  );
}
