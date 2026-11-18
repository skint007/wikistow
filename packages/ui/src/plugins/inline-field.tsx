import { isPropertyName } from '@wikistow/client';
import type { BlockField, BlockProps, View } from '@wikistow/plugin-sdk';
import { useId, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { useFields } from './block-form';
import { FieldControl } from './field-control';
import { drawnByApp, updatedBy } from './in-place';

/*
 * A claimed span a script declares (#402, `ScriptInline`): one field the
 * app draws in the line of text, bound to a page property, so a widget
 * such as Meta Bind's needs no app code. The span's text names the
 * property; a span with no text is bound to the field's own `property`.
 * It shows and sets the property as a block's bound field does
 * (`useFields`), and its text never changes: there is nothing in it to
 * write but the name.
 */

/** The one field's ID in the form `useFields` keeps. */
const FIELD = 'value';

/**
 * The property a span holding `text` is bound to: the one its text names,
 * else, with no text, the field's own; undefined for text that isn't a
 * property's name, or for none where the field names none either.
 */
export function spanProperty(field: BlockField, text: string): string | undefined {
  const named = text.trim();
  if (named === '') return field.property;
  return isPropertyName(named) ? named : undefined;
}

function InlineField({
  field,
  source,
  properties,
  setProperty,
}: BlockProps & { field: BlockField }) {
  const id = useId();
  const named = source.trim();
  const property = spanProperty(field, source);
  const bound = useMemo(() => ({ ...field, property }), [field, property]);
  const spec = useMemo(() => ({ fields: { [FIELD]: bound } }), [bound]);
  // A span holds no lines to write: only the property changes.
  const { texts, checked, refused, list, change, commit } = useFields({
    spec,
    source: '',
    setSource: null,
    properties,
    setProperty,
  });
  if (property === undefined) {
    const problem = named === '' ? 'Names no property' : 'Not a property’s name';
    return (
      <code className="text-destructive" title={problem}>
        {named || field.label}
        <span className="sr-only">: {problem}</span>
      </code>
    );
  }
  const problem = (checked[FIELD]?.problem ?? null) || (refused[FIELD] ?? null);
  return (
    <span className="inline-flex max-w-full align-middle" title={problem ?? undefined}>
      <FieldControl
        field={bound}
        text={texts[FIELD] ?? ''}
        invalid={problem !== null}
        readOnly={list(FIELD)}
        // Named for its property where the span's text gives it, else by its label.
        label={named === '' ? field.label : named}
        describedBy={problem ? `${id}-problem` : undefined}
        inline
        onChange={(text) => change(FIELD, text)}
        onCommit={(text) => commit(FIELD, text)}
      />
      {problem && (
        <span id={`${id}-problem`} className="sr-only">
          {problem}
        </span>
      )}
    </span>
  );
}

/**
 * The view of a script's span: its field, in a React root of its own. The
 * app draws it, so it takes new props in place (`drawnByApp`), drawn again
 * only for new text or another page.
 */
export const inlineFieldView = (field: BlockField): View<BlockProps> =>
  drawnByApp((element: HTMLElement, props: BlockProps) => {
    const box = document.createElement('span');
    element.append(box);
    const root = createRoot(box);
    const draw = (next: BlockProps) => root.render(<InlineField field={field} {...next} />);
    draw(props);
    const ends = updatedBy(element, draw);
    // Not while the host is rendering, which may be what removes the view.
    return () => {
      ends();
      queueMicrotask(() => root.unmount());
    };
  });
