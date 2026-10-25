import { useEffect, useId, useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Input } from './input';

export type ComboboxOption = { value: string; label: string | null };

/** The most options drawn at once; typing narrows the rest. */
const SHOWN = 100;

/**
 * A text field with a list of `options` under it, as the search dialog's
 * (not Radix's, whose scroll lock injects a `<style>` the CSP refuses).
 * It is always a plain text field too: any text can be typed, listed or
 * not. Typing filters the list by value and label, ignoring case and
 * matching anywhere, and it draws only the first 100 matches. Up and down
 * move through it, and Enter picks the option they reach; otherwise Enter
 * is the form's, with the text as typed. Escape closes it, keeping the text.
 * `status` shows under the field, such as why the list couldn't be had.
 * `onPick` hears of an option picked, after `onChange`; `field` goes on the
 * text field, its key and blur handlers after the list's own.
 */
export function Combobox({
  id,
  value,
  onChange,
  options,
  status,
  onFocus,
  placeholder,
  noun = 'options',
  onPick,
  field,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Undefined while there is no list. */
  options: readonly ComboboxOption[] | undefined;
  status?: ReactNode;
  onFocus?: () => void;
  placeholder?: string;
  /** What the options are, for the count: "12 of 340 models". */
  noun?: string;
  onPick?: (value: string) => void;
  field?: Omit<
    ComponentProps<'input'>,
    'id' | 'value' | 'onChange' | 'onFocus' | 'placeholder' | 'role'
  >;
}) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  // What was typed since the list opened; the field's own value doesn't filter.
  const [filter, setFilter] = useState('');
  // None until an arrow key picks one, so Enter keeps what was typed.
  const [active, setActive] = useState(-1);
  const matches = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!options || !query) return options ?? [];
    return options.filter(
      (option) =>
        option.value.toLowerCase().includes(query) || option.label?.toLowerCase().includes(query),
    );
  }, [options, filter]);
  const shown = matches.slice(0, SHOWN);
  const listed = open && shown.length > 0;
  useEffect(() => setActive(-1), [matches]);
  const optionId = (i: number) => `${ids}-${i}`;
  useEffect(() => {
    if (listed && active >= 0) {
      document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
    }
  });

  function pick(option: ComboboxOption) {
    onChange(option.value);
    setOpen(false);
    onPick?.(option.value);
  }

  return (
    <div className="relative grid gap-2">
      <Input
        {...field}
        id={id}
        role="combobox"
        aria-expanded={listed}
        aria-controls={`${ids}-list`}
        aria-activedescendant={listed && active >= 0 ? optionId(active) : undefined}
        aria-autocomplete="list"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onFocus={() => {
          setFilter('');
          setOpen(true);
          onFocus?.();
        }}
        onClick={() => setOpen(true)}
        onBlur={(event) => {
          setOpen(false);
          field?.onBlur?.(event);
        }}
        onChange={(event) => {
          onChange(event.target.value);
          setFilter(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) return setOpen(true);
            const step = event.key === 'ArrowDown' ? 1 : -1;
            setActive((at) => Math.min(Math.max(at + step, 0), shown.length - 1));
          } else if (event.key === 'Enter' && listed) {
            const option = shown[active];
            if (option) {
              event.preventDefault();
              pick(option);
            }
          } else if (event.key === 'Escape' && open && options) {
            event.preventDefault();
            setOpen(false);
          }
          if (!event.defaultPrevented) field?.onKeyDown?.(event);
        }}
      />
      {open && options && (
        <div className="absolute top-10 right-0 left-0 z-20 grid gap-1 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          <p role="status" className="px-2 pt-1 text-xs text-muted-foreground">
            {filter.trim()
              ? `${matches.length.toLocaleString()} of ${options.length.toLocaleString()} ${noun}`
              : `${options.length.toLocaleString()} ${noun}`}
            {matches.length > SHOWN && `, showing the first ${SHOWN}. Type to narrow them.`}
          </p>
          {shown.length > 0 && (
            <ul id={`${ids}-list`} role="listbox" className="max-h-64 overflow-y-auto">
              {shown.map((option, i) => (
                <li
                  key={option.value}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  // Keeps focus in the field, so the list stays open until the click lands.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(option)}
                  onMouseMove={() => setActive(i)}
                  className={cn(
                    'flex cursor-pointer items-baseline gap-2 rounded-row px-2 py-1.5 text-sm',
                    i === active && 'bg-primary-soft text-primary-ink',
                  )}
                >
                  <span className="min-w-0 truncate font-mono">{option.value}</span>
                  {option.label && option.label !== option.value && (
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {option.label}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {status}
    </div>
  );
}
