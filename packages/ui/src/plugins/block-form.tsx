import {
  PluginError,
  type BlockField,
  type BlockProps,
  type FieldValue,
  type OutputValue,
  type PageRef,
  type View,
} from '@wikistow/plugin-sdk';
import type { BlockSpec, OutputResult } from '@wikistow/plugin-sdk/protocol';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { drawnByApp, updatedBy } from './in-place';
import { createRoot } from 'react-dom/client';
import { cn } from '@/lib/utils';
import { propertyNamed, type BlockProperties } from './block-properties';
import { boundSet, checkField, FieldControl, type Checked } from './field-control';

/*
 * A block a script fills in (#260): the host draws its fields from the
 * fence's `<field>: <value>` lines, and its outputs from the script's
 * calculation of the valid ones. In the visual editor a changed field
 * rewrites its own line, as the person's edit; in the reader it stays here.
 * Outputs are only shown, never written.
 *
 * A field bound to a property (`property`, #212) shows the page's value
 * instead, where it has one, and sets it, never its line, once a valid
 * value is committed: on blur or Enter, so a half-typed number is never
 * saved; a toggle or choice as it's picked, and a slider as it's let go.
 * Where the page can't change, it stays here too. Each field is drawn by
 * `FieldControl`, which says how its kind reads and sets values.
 */

export type Calculate = (
  page: PageRef,
  values: Record<string, FieldValue>,
) => Promise<Record<string, OutputResult>>;

const LINE = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*:(.*)$/;

/** Each field's text in a fence, from its first `<field>: <value>` line. */
function fieldTexts(source: string): Map<string, string> {
  const texts = new Map<string, string>();
  for (const line of source.split('\n')) {
    const match = LINE.exec(line);
    if (match?.[1] && !texts.has(match[1])) texts.set(match[1], (match[2] ?? '').trim());
  }
  return texts;
}

/** `source` with field `id`'s line saying `text`, added at the end if it had none; the rest as it was. */
function withField(source: string, id: string, text: string): string {
  const lines = source === '' ? [] : source.split('\n');
  const at = lines.findIndex((line) => LINE.exec(line)?.[1] === id);
  const line = `${id}: ${text}`;
  if (at === -1) lines.push(line);
  else lines[at] = line;
  return lines.join('\n');
}

/** A field as the form reads it from a fence: its text, and its value or what's wrong with it. */
export type ReadField = { text: string } & Checked;

/** What a field bound to a list shows under it: it can't stand for one, so it only shows it. */
export const LIST_NOTE = 'A list: change it in the page’s properties';

/**
 * What a field bound to a property shows for the page's value, if it has
 * one: a scalar's text, or a list's items, which the field can't change.
 */
function boundText(
  field: BlockField,
  properties: BlockProperties,
): { text: string; list: boolean } | undefined {
  if (field.property === undefined) return undefined;
  const value = propertyNamed(properties, field.property);
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return { text: value.flat().map(String).join(', '), list: true };
  return { text: value === null ? '' : String(value), list: false };
}

/**
 * Each declared field of `spec` as read from `source`, and for a field
 * bound to a property the page has, from `properties`; a missing line
 * takes its default. A field bound to a list shows its items, with no
 * value, as it can't be one.
 */
export function readFields(
  spec: Pick<BlockSpec, 'fields'>,
  source: string,
  properties: BlockProperties = null,
): Record<string, ReadField> {
  const written = fieldTexts(source);
  return Object.fromEntries(
    Object.entries(spec.fields).map(([field, declared]) => {
      const bound = boundText(declared, properties);
      if (bound?.list) return [field, { text: bound.text, value: null, problem: LIST_NOTE }];
      const text =
        bound?.text ??
        written.get(field) ??
        (declared.default === undefined ? '' : String(declared.default));
      return [field, { text, ...checkField(declared, text) }];
    }),
  );
}

const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 10 });
const show = (value: OutputValue) => (typeof value === 'number' ? NUMBER.format(value) : value);

type Results = { outputs: Record<string, OutputResult> } | { error: string };

/**
 * Calculate the latest values, one calculation at a time: values entered
 * while one runs replace each other, and only the last is calculated next.
 */
function useCalculation(calculate: Calculate, page: PageRef, values: Record<string, FieldValue>) {
  const [results, setResults] = useState<Results | null>(null);
  const queue = useRef<{ busy: boolean; next: Record<string, FieldValue> | null }>({
    busy: false,
    next: null,
  });
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    const state = queue.current;
    state.next = values;
    if (state.busy) return;
    state.busy = true;
    void (async () => {
      for (let next = state.next; next; next = state.next) {
        state.next = null;
        let result: Results;
        try {
          result = { outputs: await calculate(page, next) };
        } catch (error) {
          result = {
            error: error instanceof PluginError ? error.message : 'Its calculation failed',
          };
        }
        if (live.current) setResults(result);
      }
      state.busy = false;
    })();
  }, [calculate, page, values]);
  return results;
}

/** What `useFields` is given: a block's props, as its form takes them. */
type FieldsProps = Pick<BlockProps, 'source' | 'setSource' | 'properties' | 'setProperty'> & {
  spec: Pick<BlockSpec, 'fields'>;
};

/**
 * The fields of `spec` as the person sees and changes them: each one's
 * text, read from the fence and the page's properties, and its value or
 * what's wrong with it; `change` for each change, which rewrites an
 * unbound field's line where the text can change, and `commit`, which
 * sets a bound field's property. A script's block form lays them out, and
 * a script's span draws its one (`inline-field.tsx`).
 */
export function useFields({
  spec,
  source,
  setSource,
  // Missing in props from an app older than them, as a view of ours never is.
  properties = null,
  setProperty = null,
}: FieldsProps) {
  const [first] = useState(() => readFields(spec, source, properties));
  const [texts, setTexts] = useState(() =>
    Object.fromEntries(Object.entries(first).map(([field, { text }]) => [field, text])),
  );
  // Why the page refused a bound field's value, if it did.
  const [refused, setRefused] = useState<Record<string, string>>({});
  // Each bound field's value on the page, as drawn or as it last set it,
  // undefined while the page has none; and the fields typed in since they
  // were drawn or last set. Only a field typed in is set as it's committed,
  // and only to a value the page hasn't, a missing key counting as one:
  // visiting a field never changes the page, the default it shows included.
  const onPage = useRef(
    Object.fromEntries(
      Object.entries(spec.fields).map(([field, { property }]) => [
        field,
        property === undefined ? undefined : propertyNamed(properties, property),
      ]),
    ),
  );
  const typed = useRef(new Set<string>());
  // New properties come in place (`updateInPlace`): a bound field not typed
  // in shows what it reads now (`readFields`), the page's value, or its
  // fence line or default where the page no longer has the key; one typed
  // in keeps its text; and each commits against the value the page has now.
  const [drawnWith] = useState(properties);
  useEffect(() => {
    if (properties === drawnWith) return;
    const read = readFields(spec, source, properties);
    const now: Record<string, string> = {};
    for (const [field, { property }] of Object.entries(spec.fields)) {
      if (property === undefined) continue;
      onPage.current[field] = propertyNamed(properties, property);
      const shown = read[field];
      if (!typed.current.has(field) && shown) now[field] = shown.text;
    }
    // Unchanged, the form keeps its texts, and its outputs aren't worked out again.
    setTexts((before) =>
      Object.entries(now).every(([field, text]) => before[field] === text)
        ? before
        : { ...before, ...now },
    );
  }, [properties, drawnWith, spec, source]);
  // The fence as this form last wrote it: the editor doesn't draw it again for that.
  const written = useRef(source);
  // A field bound to a list only shows it, as read: told by the properties
  // drawn, so a value turning into a list, or back, shows at once.
  const lists = useMemo(
    () =>
      new Set(
        Object.entries(spec.fields).flatMap(([field, { property }]) =>
          property !== undefined && Array.isArray(propertyNamed(properties, property))
            ? [field]
            : [],
        ),
      ),
    [spec, properties],
  );
  const list = (field: string) => lists.has(field);
  const checked = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(spec.fields).map(([field, declared]) => [
          field,
          lists.has(field)
            ? { value: null, problem: LIST_NOTE }
            : checkField(declared, texts[field] ?? ''),
        ]),
      ),
    [spec, texts, lists],
  );
  const values = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(checked).flatMap(([field, { value }]) =>
          value === null ? [] : [[field, value]],
        ),
      ),
    [checked],
  );
  const change = (field: string, text: string) => {
    typed.current.add(field);
    setTexts((now) => ({ ...now, [field]: text }));
    setRefused(({ [field]: _gone, ...others }) => others);
    // A bound field writes no line: its value goes to the page as it's committed.
    if (!setSource || spec.fields[field]?.property !== undefined) return;
    written.current = withField(written.current, field, text);
    setSource(written.current);
  };

  /** A bound field's valid value in `text`, set on the page as it's committed. */
  const commit = (field: string, text = texts[field] ?? '') => {
    const declared = spec.fields[field];
    const key = declared?.property;
    if (!declared || key === undefined || !setProperty || list(field)) return;
    const { value } = checkField(declared, text);
    if (value === null || !typed.current.has(field)) return;
    const was = onPage.current[field];
    const set = boundSet(declared, text, value, was);
    if (was !== undefined && JSON.stringify(was) === JSON.stringify(set)) {
      typed.current.delete(field);
      return;
    }
    try {
      setProperty(key, set);
      onPage.current[field] = set;
      typed.current.delete(field);
    } catch (error) {
      const reason = error instanceof PluginError ? error.message : 'It couldn’t be set';
      setRefused((now) => ({ ...now, [field]: reason }));
    }
  };

  return { texts, checked, values, refused, list, change, commit };
}

function BlockForm({
  spec,
  calculate,
  source,
  page,
  setSource,
  properties,
  setProperty,
}: BlockProps & { spec: BlockSpec; calculate: Calculate }) {
  const id = useId();
  const { texts, checked, values, refused, list, change, commit } = useFields({
    spec,
    source,
    setSource,
    properties,
    setProperty,
  });
  const results = useCalculation(calculate, page, values);

  return (
    <div className="flex flex-wrap items-start gap-3 rounded-control border bg-background p-3">
      {Object.entries(spec.fields).map(([field, declared]) => {
        const problem = (checked[field]?.problem ?? null) || (refused[field] ?? null);
        return (
          <label key={field} className="grid w-36 gap-1 text-sm text-muted-foreground">
            {declared.label}
            <FieldControl
              field={declared}
              text={texts[field] ?? ''}
              invalid={problem !== null}
              readOnly={list(field)}
              describedBy={problem ? `${id}-${field}` : undefined}
              onChange={(text) => change(field, text)}
              onCommit={(text) => commit(field, text)}
            />
            {problem && (
              <span
                id={`${id}-${field}`}
                className={cn(
                  'text-xs',
                  list(field) ? 'text-muted-foreground' : 'text-destructive',
                )}
              >
                {problem}
              </span>
            )}
          </label>
        );
      })}
      {Object.entries(spec.outputs).map(([output, { label }]) => {
        const result = results && 'outputs' in results ? results.outputs[output] : undefined;
        return (
          <div key={output} className="grid min-w-24 gap-1 text-sm">
            <span className="text-muted-foreground">{label}</span>
            <output
              data-output={output}
              className={
                result && 'error' in result
                  ? 'text-xs text-destructive'
                  : 'py-1 text-base font-semibold'
              }
            >
              {result
                ? 'error' in result
                  ? result.error
                  : show(result.value)
                : // Calculating, or none: the whole calculation failed, as said below.
                  results
                  ? '—'
                  : '…'}
            </output>
          </div>
        );
      })}
      {results && 'error' in results && (
        <p role="alert" className="basis-full text-sm text-destructive">
          {results.error}
        </p>
      )}
    </div>
  );
}

/**
 * The view of a script's block: its form, in a React root of its own. The
 * app draws it, so it takes new props in place (`drawnByApp`), drawn
 * again only for new text or another page.
 */
export const formView = (spec: BlockSpec, calculate: Calculate): View<BlockProps> =>
  drawnByApp((element: HTMLElement, props: BlockProps) => {
    const box = document.createElement('div');
    element.append(box);
    const root = createRoot(box);
    const draw = (next: BlockProps) =>
      root.render(<BlockForm spec={spec} calculate={calculate} {...next} />);
    draw(props);
    const ends = updatedBy(element, draw);
    // Not while the host is rendering, which may be what removes the view.
    return () => {
      ends();
      queueMicrotask(() => root.unmount());
    };
  });
