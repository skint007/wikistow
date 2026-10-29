import {
  PluginError,
  type BlockField,
  type BlockProps,
  type OutputValue,
  type PageRef,
  type View,
} from '@wikistow/plugin-sdk';
import type { BlockSpec, OutputResult } from '@wikistow/plugin-sdk/protocol';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Input } from '@/components/ui/input';
import type { PropertyValue } from '@wikistow/plugin-sdk';
import { typedValue } from '../page/property-model';
import { propertyNamed, type BlockProperties } from './block-properties';

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
 * saved. Where the page can't change, it stays here too.
 */

export type Calculate = (
  page: PageRef,
  values: Record<string, OutputValue>,
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

type Checked = { value: OutputValue; problem: null } | { value: null; problem: string };

function check(field: BlockField, text: string): Checked {
  if (field.type === 'text') return { value: text.trim(), problem: null };
  // As the fence is read again: its values are trimmed.
  if (text.trim() === '') return { value: null, problem: 'Enter a number' };
  const value = Number(text.trim());
  if (!Number.isFinite(value)) return { value: null, problem: 'Not a number' };
  if (field.min !== undefined && value < field.min)
    return { value: null, problem: `At least ${field.min}` };
  if (field.max !== undefined && value > field.max)
    return { value: null, problem: `At most ${field.max}` };
  return { value, problem: null };
}

/** A field as the form reads it from a fence: its text, and its value or what's wrong with it. */
export type ReadField = { text: string } & Checked;

/**
 * What a text field bound to a property sets for `text`: in the type of
 * the value it replaces when the text reads as one, a number for a number
 * (`typedValue`, as the Properties rows type it) and `true` or `false` for
 * either, so `rating: 4` stays a number; else the text.
 */
export function boundValue(text: string, was: PropertyValue | undefined): PropertyValue {
  if (typeof was === 'number') return typedValue(text, was);
  if (typeof was === 'boolean' && /^(?:true|false)$/.test(text)) return text === 'true';
  return text;
}

/** The text a field bound to a property shows for the page's value: a scalar's, if it has one. */
function boundText(field: BlockField, properties: BlockProperties): string | undefined {
  if (field.property === undefined) return undefined;
  const value = propertyNamed(properties, field.property);
  if (value === undefined || Array.isArray(value)) return undefined;
  return value === null ? '' : String(value);
}

/**
 * Each declared field of `spec` as read from `source`, and for a field
 * bound to a property the page has, from `properties`; a missing line
 * takes its default.
 */
export function readFields(
  spec: BlockSpec,
  source: string,
  properties: BlockProperties = null,
): Record<string, ReadField> {
  const written = fieldTexts(source);
  return Object.fromEntries(
    Object.entries(spec.fields).map(([field, declared]) => {
      const text =
        boundText(declared, properties) ??
        written.get(field) ??
        (declared.default === undefined ? '' : String(declared.default));
      return [field, { text, ...check(declared, text) }];
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
function useCalculation(calculate: Calculate, page: PageRef, values: Record<string, OutputValue>) {
  const [results, setResults] = useState<Results | null>(null);
  const queue = useRef<{ busy: boolean; next: Record<string, OutputValue> | null }>({
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

function BlockForm({
  spec,
  calculate,
  source,
  page,
  setSource,
  // Missing in props from an app older than them, as a view of ours never is.
  properties = null,
  setProperty = null,
}: BlockProps & { spec: BlockSpec; calculate: Calculate }) {
  const id = useId();
  const [first] = useState(() => readFields(spec, source, properties));
  const [texts, setTexts] = useState(() =>
    Object.fromEntries(Object.entries(first).map(([field, { text }]) => [field, text])),
  );
  // Why the page refused a bound field's value, if it did.
  const [refused, setRefused] = useState<Record<string, string>>({});
  // Each bound field's value on the page, as drawn or as it last set it,
  // undefined while the page has none: a commit of the value the page has
  // sets nothing, and any valid one sets a missing key, the default shown
  // included.
  const onPage = useRef(
    Object.fromEntries(
      Object.entries(spec.fields).map(([field, { property }]) => [
        field,
        property === undefined ? undefined : propertyNamed(properties, property),
      ]),
    ),
  );
  // The fence as this form last wrote it: the editor doesn't draw it again for that.
  const written = useRef(source);
  const checked = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(spec.fields).map(([field, declared]) => [
          field,
          check(declared, texts[field] ?? ''),
        ]),
      ),
    [spec, texts],
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
  const results = useCalculation(calculate, page, values);

  const change = (field: string, text: string) => {
    setTexts((now) => ({ ...now, [field]: text }));
    setRefused(({ [field]: _gone, ...others }) => others);
    // A bound field writes no line: its value goes to the page as it's committed.
    if (!setSource || spec.fields[field]?.property !== undefined) return;
    written.current = withField(written.current, field, text);
    setSource(written.current);
  };

  /** A bound field's valid value, set on the page as it's committed. */
  const commit = (field: string) => {
    const key = spec.fields[field]?.property;
    const { value } = checked[field] ?? { value: null };
    if (key === undefined || !setProperty || value === null) return;
    const was = onPage.current[field];
    const set = spec.fields[field]?.type === 'text' ? boundValue(String(value), was) : value;
    if (was !== undefined && JSON.stringify(was) === JSON.stringify(set)) return;
    try {
      setProperty(key, set);
      onPage.current[field] = set;
    } catch (error) {
      const reason = error instanceof PluginError ? error.message : 'It couldn’t be set';
      setRefused((now) => ({ ...now, [field]: reason }));
    }
  };

  return (
    <div className="flex flex-wrap items-start gap-3 rounded-control border bg-background p-3">
      {Object.entries(spec.fields).map(([field, declared]) => {
        const problem = (checked[field]?.problem ?? null) || (refused[field] ?? null);
        return (
          <label key={field} className="grid w-36 gap-1 text-sm text-muted-foreground">
            {declared.label}
            <Input
              inputMode={declared.type === 'number' ? 'decimal' : 'text'}
              value={texts[field] ?? ''}
              aria-invalid={problem !== null}
              aria-describedby={problem ? `${id}-${field}` : undefined}
              onChange={(event) => change(field, event.target.value)}
              onBlur={() => commit(field)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commit(field);
              }}
              className="h-8 bg-background text-foreground"
            />
            {problem && (
              <span id={`${id}-${field}`} className="text-xs text-destructive">
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

/** The view of a script's block: its form, in a React root of its own. */
export const formView =
  (spec: BlockSpec, calculate: Calculate): View<BlockProps> =>
  (element, props) => {
    const box = document.createElement('div');
    element.append(box);
    const root = createRoot(box);
    root.render(<BlockForm spec={spec} calculate={calculate} {...props} />);
    // Not while the host is rendering, which may be what removes the view.
    return () => queueMicrotask(() => root.unmount());
  };
