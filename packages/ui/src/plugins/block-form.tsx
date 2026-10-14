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

/*
 * A block a script fills in (#260): the host draws its fields from the
 * fence's `<field>: <value>` lines, and its outputs from the script's
 * calculation of the valid ones. In the visual editor a changed field
 * rewrites its own line, as the person's edit; in the reader it stays here.
 * Outputs are only shown, never written.
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

/** Each declared field of `spec` as read from `source`, a missing line taking its default. */
export function readFields(spec: BlockSpec, source: string): Record<string, ReadField> {
  const written = fieldTexts(source);
  return Object.fromEntries(
    Object.entries(spec.fields).map(([field, declared]) => {
      const text =
        written.get(field) ?? (declared.default === undefined ? '' : String(declared.default));
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
}: BlockProps & { spec: BlockSpec; calculate: Calculate }) {
  const id = useId();
  const [texts, setTexts] = useState(() =>
    Object.fromEntries(
      Object.entries(readFields(spec, source)).map(([field, { text }]) => [field, text]),
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
    if (!setSource) return;
    written.current = withField(written.current, field, text);
    setSource(written.current);
  };

  return (
    <div className="flex flex-wrap items-start gap-3 rounded-control border bg-background p-3">
      {Object.entries(spec.fields).map(([field, declared]) => {
        const { problem } = checked[field] ?? { problem: null };
        return (
          <label key={field} className="grid w-36 gap-1 text-sm text-muted-foreground">
            {declared.label}
            <Input
              inputMode={declared.type === 'number' ? 'decimal' : 'text'}
              value={texts[field] ?? ''}
              aria-invalid={problem !== null}
              aria-describedby={problem ? `${id}-${field}` : undefined}
              onChange={(event) => change(field, event.target.value)}
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
