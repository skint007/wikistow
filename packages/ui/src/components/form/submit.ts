import type { FormEvent } from 'react';

/**
 * A form's `onSubmit` that hands its data to `handle` and leaves what was
 * typed in place. A function given as `<form action>` instead has React
 * clear the form once it finishes, a moment after the refusal it shows, so
 * a person mending one field loses the others and what they just typed.
 */
export const submitData =
  (handle: (form: FormData) => Promise<unknown>) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void handle(new FormData(event.currentTarget));
  };
