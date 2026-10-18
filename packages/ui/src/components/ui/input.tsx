import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Tells browsers and password managers to leave a field alone. Most managers
 * ignore `autocomplete="off"`, so each gets its own hint too: 1Password,
 * LastPass, Bitwarden and Dashlane. Spread it on raw `<input>`s that aren't
 * credentials; `Input` adds it by itself.
 */
export const notCredential = {
  autoComplete: 'off',
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-bwignore': '',
  'data-form-type': 'other',
} as const;

/**
 * A text field. Password managers stay out unless it is a password or has a
 * real `autoComplete` (`email`, `current-password`, `one-time-code`…), which is
 * how credential fields opt in.
 */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  const credential =
    type === 'password' || (props.autoComplete !== undefined && props.autoComplete !== 'off');
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...(credential ? {} : notCredential)}
      {...props}
    />
  );
}

export { Input };
