import type { FormEvent } from 'react';

/**
 * A form's `onSubmit` that hands its data, with the name and value of the
 * button that sent it, to `handle` and leaves what was typed in place. A function given as `<form action>` instead has React
 * clear the form once it finishes, a moment after the refusal it shows, so
 * a person mending one field loses the others and what they just typed.
 */
export const submitData =
  (handle: (form: FormData) => Promise<unknown>) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { nativeEvent } = event;
    const submitter = nativeEvent instanceof SubmitEvent ? nativeEvent.submitter : null;
    void handle(new FormData(event.currentTarget, submitter));
  };
