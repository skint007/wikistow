'use client';

import { useRef, type ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { ChevronDown, type LucideIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './dropdown-menu';

export type PickerOption<T extends string> = { value: T; label: string; icon?: LucideIcon };

/**
 * One of `options`, picked from a menu in the palette's colours, where a
 * native select would open a list the browser draws in its own. A button
 * named "`label`: the choice", or `placeholder` while there's none, opening
 * the options with the choice checked and focused. Not Radix's Select,
 * whose scroll lock injects a `<style>` the CSP refuses. Outlined whenever
 * it has focus, as a native select is, so a click on its `<label>`, which
 * focuses it, shows: a button gets no `:focus-visible` from a click.
 */
function Picker<T extends string>({
  label,
  value,
  options,
  onChange,
  placeholder = 'Choose',
  refocus,
  className,
  ...props
}: Omit<ComponentProps<typeof DropdownMenuTrigger>, 'value' | 'onChange'> & {
  label: string;
  value: T | null;
  options: readonly PickerOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  /**
   * Focus somewhere else than the button as the menu closes, though not
   * after a click outside it, which took focus where it clicked.
   */
  refocus?: () => void;
}) {
  const choice = options.find((option) => option.value === value);
  const shown = choice?.label;
  const Icon = choice?.icon;
  const opening = useRef(false);
  const outside = useRef(false);
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        opening.current = open;
        if (open) outside.current = false;
      }}
    >
      <DropdownMenuTrigger
        data-slot="picker"
        aria-label={`${label}: ${shown ?? placeholder}`}
        className={cn(
          'flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-control border border-input bg-background px-2 text-left text-sm outline-ring hover:tint active:tint-strong focus:outline-2 disabled:pointer-events-none disabled:opacity-50 data-[state=open]:tint',
          className,
        )}
        {...props}
      >
        {Icon && <Icon className="size-4 shrink-0" strokeWidth={1.75} />}
        <span className={cn('flex-1 truncate', shown === undefined && 'text-muted-foreground')}>
          {shown ?? placeholder}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        // Radix names it by the trigger's id, which a caller's `id` replaces.
        aria-label={label}
        align="start"
        className="min-w-(--radix-dropdown-menu-trigger-width)"
        onInteractOutside={() => (outside.current = true)}
        onCloseAutoFocus={(event) => {
          // After a click outside, Radix leaves focus be, as it should.
          if (!refocus || outside.current) return;
          event.preventDefault();
          refocus();
        }}
        // The choice focused as it opens, as a native select's is: in
        // place of the menu itself, which Radix focuses, and its first item
        // for a key. Only then, not each time the pointer leaves an item.
        onFocus={(event) => {
          if (!opening.current || event.target !== event.currentTarget) return;
          opening.current = false;
          const item = event.currentTarget.querySelector<HTMLElement>(
            '[role=menuitemradio][data-state=checked]',
          );
          if (!item) return;
          event.preventDefault();
          item.focus({ preventScroll: true });
          requestAnimationFrame(() => item.scrollIntoView({ block: 'nearest' }));
        }}
      >
        {/* None checked while there's no choice: '' may be an option. */}
        <DropdownMenuRadioGroup {...(value === null ? {} : { value })}>
          {options.map(({ icon: ItemIcon, ...option }) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              // Only for a change, as a native select's `change` event.
              onSelect={() => {
                if (option.value !== value) onChange(option.value);
              }}
            >
              {ItemIcon && <ItemIcon strokeWidth={1.75} />}
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { Picker };
