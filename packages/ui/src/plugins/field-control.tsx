import { isPropertyDate } from '@wikistow/client';
import type { BlockField, FieldValue, PropertyValue } from '@wikistow/plugin-sdk';
import { onStep } from '@wikistow/plugin-sdk/protocol';
import { Input } from '@/components/ui/input';
import { Picker } from '@/components/ui/picker';
import { Switch } from '@/components/ui/switch';
import { useRef } from 'react';
import { cn } from '@/lib/utils';
import { typedValue } from '../page/property-model';

/*
 * One field a script declares (#260, #402), as the app draws it: its value
 * read from text, as a fence line or a property holds it, the control the
 * person changes it with, and what it sets on a property it's bound to.
 * A block's form lays several out under their labels (`block-form.tsx`);
 * the control alone, named by `label`, can stand in a line of text.
 */

/** A field's value as read from its text, or what's wrong with it. */
export type Checked = { value: FieldValue; problem: null } | { value: null; problem: string };

/** `field`'s value in `text`, as the fence is read again: trimmed. */
export function checkField(field: BlockField, text: string): Checked {
  const trimmed = text.trim();
  switch (field.type) {
    case 'text':
      return { value: trimmed, problem: null };
    case 'boolean': {
      // Nothing written is off, as an empty Checkbox property is.
      const word = trimmed.toLowerCase();
      if (word === '' || word === 'false') return { value: false, problem: null };
      if (word === 'true') return { value: true, problem: null };
      return { value: null, problem: 'Not true or false' };
    }
    case 'choice':
      if (trimmed === '') return { value: null, problem: 'Choose one' };
      return field.options.some(({ value }) => value === trimmed)
        ? { value: trimmed, problem: null }
        : { value: null, problem: 'Not one of its choices' };
    case 'date':
      if (trimmed === '') return { value: null, problem: 'Enter a date' };
      return isPropertyDate(trimmed)
        ? { value: trimmed.slice(0, 10), problem: null }
        : { value: null, problem: 'Not a date' };
    case 'number': {
      if (trimmed === '') return { value: null, problem: 'Enter a number' };
      const value = Number(trimmed);
      if (!Number.isFinite(value)) return { value: null, problem: 'Not a number' };
      if (field.min !== undefined && value < field.min)
        return { value: null, problem: `At least ${field.min}` };
      if (field.max !== undefined && value > field.max)
        return { value: null, problem: `At most ${field.max}` };
      // Between two steps, a slider's thumb would rest on another value than the one used.
      const step = field.step ?? 1;
      if (field.slider && !onStep(value, field.min ?? 0, step))
        return { value: null, problem: `In steps of ${step} from ${field.min ?? 0}` };
      return { value, problem: null };
    }
  }
}

/**
 * What a text field bound to a property sets for `text`: in the type of
 * the value it replaces when the text reads as one, as the Properties rows
 * type it (`typedValue`): a number for a number, `true` or `false` for
 * either, so `rating: 4` stays a number; for an empty value (`note:`),
 * whatever the text reads as, nothing staying empty, and so for a key the
 * page hasn't, as the rows type a key they add; else the text. Emptied, the
 * field sets an empty value (`note:`), unless the value was empty text (`""`).
 */
export function boundValue(text: string, was: PropertyValue | undefined): PropertyValue {
  // Emptied, it's an empty value, as in the rows, unless it was empty text.
  if (text === '') return was === '' ? '' : null;
  if (typeof was === 'number' || was === null || was === undefined)
    return typedValue(text, was ?? null);
  if (typeof was === 'boolean' && /^(?:true|false)$/.test(text)) return text === 'true';
  return text;
}

/**
 * What a field bound to a property sets, for its valid `value` read from
 * `text`, in place of `was`: a number field's number, a toggle's `true` or
 * `false`, a choice's value as text (a number or boolean where it replaces one),
 * a date's text (with the time it kept,
 * if it had one), and a text field's text typed as `boundValue` types it.
 */
export function boundSet(
  field: BlockField,
  text: string,
  value: FieldValue,
  was: PropertyValue | undefined,
): PropertyValue {
  switch (field.type) {
    case 'text':
      return boundValue(String(value), was);
    case 'date':
      return text.trim();
    case 'choice':
      // Text, but a number or boolean stays one, so `rating: 4` becomes 5, not '5'.
      if (typeof was !== 'number' && typeof was !== 'boolean') return value;
      // Only where it reads back as the same option: `+2` stays text.
      const typed = boundValue(String(value), was);
      return String(typed) === value ? typed : value;
    default:
      return value;
  }
}

/** The time after a date's day in `text`, such as `T09:30`, if it is a date with one. */
const timeOf = (text: string) => {
  const trimmed = text.trim();
  return isPropertyDate(trimmed) ? trimmed.slice(10) : '';
};

/**
 * The control for `field`, showing `text`. Each change is `onChange`'s; a
 * value is committed (`onCommit`) on blur or Enter, as soon as it's picked
 * for a toggle or choice, and as a slider is let go. Read-only, it shows
 * its text, such as a list's items, whatever its kind. `inline`, it is
 * sized to sit in a line of text, as a script's span draws it.
 */
export function FieldControl({
  field,
  text,
  invalid,
  readOnly,
  label,
  describedBy,
  inline = false,
  onChange,
  onCommit,
}: {
  field: BlockField;
  text: string;
  invalid: boolean;
  readOnly: boolean;
  /** Its name, where no `<label>` around it gives one. */
  label?: string | undefined;
  describedBy?: string | undefined;
  /** Drawn in a line of text, as a script's span is, not in a form's column. */
  inline?: boolean;
  onChange: (text: string) => void;
  onCommit: (text: string) => void;
}) {
  // A date's time, kept while its input is emptied on the way to another
  // day, as clearing a segment empties it: the next day takes it back. Only
  // the next: emptied another way, such as in Properties, it has none.
  const time = useRef('');
  const common = {
    'aria-label': label,
    'aria-invalid': invalid && !readOnly,
    'aria-describedby': describedBy,
  };
  const day = checkField(field, text).value;
  const typed = (kind: 'text' | 'date' | 'number') => (
    <Input
      {...common}
      type={kind === 'date' && !readOnly ? 'date' : 'text'}
      inputMode={kind === 'number' ? 'decimal' : undefined}
      // A date input holds only a day: a time after it is kept in the text.
      value={kind === 'date' && !readOnly ? (typeof day === 'string' ? day : '') : text}
      readOnly={readOnly}
      onChange={(event) => {
        const next = event.target.value;
        if (kind !== 'date') return onChange(next);
        // Its own time while it shows a day; else the one it had as it was emptied, once.
        const kept = text.trim() === '' ? time.current : timeOf(text);
        time.current = next === '' ? kept : '';
        onChange(next === '' ? '' : `${next}${kept}`);
      }}
      onBlur={() => onCommit(text)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onCommit(text);
      }}
      className={cn(
        'bg-background text-foreground',
        inline
          ? cn(
              'inline-block h-6 px-1.5 py-0 align-middle text-sm md:text-sm',
              kind === 'number' ? 'w-16' : kind === 'date' && !readOnly ? 'w-36' : 'w-40',
            )
          : 'h-8',
      )}
    />
  );
  if (readOnly) return typed('text');
  switch (field.type) {
    case 'text':
      return typed('text');
    case 'date':
      return typed('date');
    case 'boolean': {
      const { value } = checkField(field, text);
      return (
        <Switch
          {...common}
          checked={value === true}
          onCheckedChange={(on) => {
            onChange(String(on));
            onCommit(String(on));
          }}
          className={inline ? 'align-middle' : 'my-2'}
        />
      );
    }
    case 'choice': {
      const { value } = checkField(field, text);
      return (
        <Picker
          aria-invalid={common['aria-invalid']}
          aria-describedby={describedBy}
          label={label ?? field.label}
          value={typeof value === 'string' ? value : null}
          options={field.options}
          onChange={(chosen) => {
            onChange(chosen);
            onCommit(chosen);
          }}
          className={cn(
            'text-foreground',
            inline ? 'inline-flex h-6 w-auto max-w-48 align-middle' : 'h-8',
          )}
        />
      );
    }
    case 'number': {
      if (!field.slider) return typed('number');
      // A slider needs both ends, which the field's check makes sure of.
      const min = field.min ?? 0;
      const max = field.max ?? 100;
      const { value } = checkField(field, text);
      return (
        <span
          className={cn(
            'min-w-0 items-center',
            inline ? 'inline-flex h-6 w-36 gap-1.5 align-middle' : 'flex h-8 gap-2',
          )}
        >
          <input
            {...common}
            type="range"
            min={min}
            max={max}
            step={field.step ?? 1}
            value={typeof value === 'number' ? value : min}
            onChange={(event) => onChange(event.target.value)}
            // Let go, by pointer or key, the value it rests on is committed.
            onPointerUp={(event) => onCommit(event.currentTarget.value)}
            onKeyUp={(event) => onCommit(event.currentTarget.value)}
            onBlur={(event) => onCommit(event.currentTarget.value)}
            // No width of its own, which would hold its column open past the label's.
            className="w-0 min-w-0 flex-1 accent-primary"
          />
          <span
            className={cn(
              'text-foreground tabular-nums',
              // In a line, against the words after it; in a form, under the others' ends.
              inline ? 'min-w-4' : 'min-w-6 text-right',
            )}
          >
            {text}
          </span>
        </span>
      );
    }
  }
}
