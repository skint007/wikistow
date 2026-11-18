import { BlockField as FieldCheck, WorkerMessage } from '@wikistow/plugin-sdk/protocol';
import type {
  BlockField,
  CalculateValues,
  FieldValues,
  NumberField,
  TextField,
} from '@wikistow/plugin-sdk';
import { declaredField } from '@wikistow/plugin-sdk/src/script.ts';
import { z } from 'zod';
import { describe, expect, it } from 'vite-plus/test';
import { refusal } from '../src/plugins/script-refusal.ts';

// A script's field declarations as its worker sends them to the app: only
// the keys that are set, so an app older than a key, which checks fields
// strictly, still takes a field that doesn't use it.

/** The field checks of an app from before fields could name a property. */
const [numberField, textField] = FieldCheck.options;
const older = [
  numberField.omit({ property: true, slider: true, step: true }),
  textField.omit({ property: true }),
] as const;

/** The block checks of an app from before #402: number and text fields only. */
const released = z.strictObject({
  type: z.literal('block'),
  block: z.strictObject({
    type: z.string(),
    fields: z.record(
      z.string(),
      z.discriminatedUnion('type', [numberField.omit({ slider: true, step: true }), textField]),
    ),
    outputs: z.record(z.string(), z.strictObject({ label: z.string() })),
  }),
});

describe('a field a script declares', () => {
  it('is sent without the keys it leaves unset, `property` among them', () => {
    const number = declaredField({ type: 'number', label: 'Servings', min: 1 });
    expect(number).toEqual({ type: 'number', label: 'Servings', min: 1 });
    expect(Object.keys(number)).not.toContain('property');
    expect(Object.keys(number)).not.toContain('default');
    const text = declaredField({ type: 'text', label: 'Note', default: undefined });
    expect(Object.keys(text)).toEqual(['type', 'label']);
    // As an older app checks it, once the message has been copied across.
    expect(older[0].safeParse(structuredClone(number)).success).toBe(true);
    expect(older[1].safeParse(structuredClone(text)).success).toBe(true);
  });

  it('keeps `property` when it is set, and only the keys the app knows', () => {
    const extra = { type: 'number', label: 'Servings', property: 'servings', colour: 'red' };
    const field = declaredField(extra as Parameters<typeof declaredField>[0]);
    expect(field).toEqual({ type: 'number', label: 'Servings', property: 'servings' });
    expect(FieldCheck.safeParse(field).success).toBe(true);
  });
});

describe('fields of the kinds after number and text (#402)', () => {
  it('are sent with only the keys they set, and a number field that isn’t a slider without `slider`', () => {
    expect(declaredField({ type: 'boolean', label: 'Done', default: undefined })).toEqual({
      type: 'boolean',
      label: 'Done',
    });
    const choice = declaredField({
      type: 'choice',
      label: 'Status',
      options: [{ value: 'todo', label: 'To do', extra: 1 } as { value: string; label: string }],
      default: 'todo',
    });
    expect(choice).toEqual({
      type: 'choice',
      label: 'Status',
      options: [{ value: 'todo', label: 'To do' }],
      default: 'todo',
    });
    expect(declaredField({ type: 'date', label: 'Due', property: 'due' })).toEqual({
      type: 'date',
      label: 'Due',
      property: 'due',
    });
    const plain = declaredField({ type: 'number', label: 'N', slider: false });
    expect(plain).toEqual({ type: 'number', label: 'N' });
    // So an app from before sliders still takes it.
    expect(older[0].safeParse(structuredClone(plain)).success).toBe(true);
    const slider = declaredField({
      type: 'number',
      label: 'N',
      min: 0,
      max: 5,
      slider: true,
      step: 0.5,
    });
    expect(slider).toEqual({ type: 'number', label: 'N', min: 0, max: 5, slider: true, step: 0.5 });
    expect(FieldCheck.safeParse(slider).success).toBe(true);
  });

  it('are checked as the host takes them', () => {
    const ok = (field: unknown) => FieldCheck.safeParse(field).success;
    expect(ok({ type: 'number', label: 'N', step: 1 })).toBe(false);
    expect(ok({ type: 'number', label: 'N', slider: true, min: 0 })).toBe(false);
    expect(ok({ type: 'number', label: 'N', slider: true, min: 5, max: 5 })).toBe(false);
    expect(ok({ type: 'number', label: 'N', slider: true, min: 0, max: 5, step: 0 })).toBe(false);
    const option = (value: string) => ({ value, label: value });
    expect(ok({ type: 'choice', label: 'C', options: [] })).toBe(false);
    expect(ok({ type: 'choice', label: 'C', options: [option('a'), option('a')] })).toBe(false);
    expect(ok({ type: 'choice', label: 'C', options: [option(' a')] })).toBe(false);
    expect(ok({ type: 'choice', label: 'C', options: [option('a\nb')] })).toBe(false);
    expect(ok({ type: 'choice', label: 'C', options: [option('a')], default: 'b' })).toBe(false);
    expect(ok({ type: 'choice', label: 'C', options: [option('a')], default: 'a' })).toBe(true);
    expect(ok({ type: 'date', label: 'D', default: '2026-02-30' })).toBe(false);
    expect(ok({ type: 'date', label: 'D', default: '2026-11-18T09:30' })).toBe(false);
    expect(ok({ type: 'date', label: 'D', default: '2026-11-18' })).toBe(true);
    expect(ok({ type: 'boolean', label: 'B', default: 'yes' })).toBe(false);
    expect(ok({ type: 'choice', label: 'C', options: [option('a\u2028b')] })).toBe(false);
    expect(ok({ type: 'choice', label: 'C', options: [option('a\u0000b')] })).toBe(false);
    expect(
      ok({ type: 'number', label: 'N', slider: true, min: 0, max: 1e7, step: 2e6, default: 1 }),
    ).toBe(false);
    expect(ok({ type: 'number', label: 'N', slider: true, min: 0, max: 0.5 })).toBe(false);
    expect(ok({ type: 'number', label: 'N', slider: true, min: 0, max: 0.5, step: 0.1 })).toBe(
      true,
    );
    expect(
      ok({ type: 'number', label: 'N', slider: true, min: 0, max: 10, step: 5, default: 4 }),
    ).toBe(false);
    expect(
      ok({ type: 'number', label: 'N', slider: true, min: 0, max: 1, step: 0.1, default: 0.3 }),
    ).toBe(true);
    expect(ok({ type: 'number', label: 'N', slider: true, min: 0.1, max: 0.3, step: 0.2 })).toBe(
      true,
    );
    expect(
      ok({ type: 'number', label: 'N', slider: true, min: 0, max: 10, step: 5, default: 15 }),
    ).toBe(false);
  });

  it('are refused by a released app, naming the field, and by this one say it may need a newer app', () => {
    const message = {
      type: 'block',
      block: { type: 'task', fields: { done: { type: 'boolean', label: 'Done' } }, outputs: {} },
    };
    const before = released.safeParse(message);
    expect(before.success).toBe(false);
    expect(before.error?.issues[0]?.path).toEqual(['block', 'fields', 'done', 'type']);
    // A kind this app doesn't know, as from a newer SDK.
    const later = {
      ...message,
      block: { ...message.block, fields: { done: { type: 'rating', label: 'R' } } },
    };
    const parsed = WorkerMessage.safeParse(later);
    expect(parsed.success).toBe(false);
    expect(refusal(later, parsed.error?.issues ?? [])).toBe(
      'Its script’s block “task” has a field, “done”, this app can’t draw: it may need a newer WikiStow.',
    );
    const keyed = {
      ...message,
      block: { ...message.block, fields: { n: { type: 'number', label: 'N', wobble: 1 } } },
    };
    expect(refusal(keyed, WorkerMessage.safeParse(keyed).error?.issues ?? [])).toContain(
      '“n”, this app can’t draw',
    );
    // Anything else says what was wrong, as before.
    const stepped = {
      ...message,
      block: { ...message.block, fields: { n: { type: 'number', label: 'N', step: 1 } } },
    };
    expect(refusal(stepped, WorkerMessage.safeParse(stepped).error?.issues ?? [])).toBe(
      'Its script sent a message the app doesn’t accept (block: fields: n: Only a slider has a step).',
    );
  });
});

// Outputs read beside the fields: booleans among them only where a field is one.
type Reads<F extends Record<string, BlockField>> = CalculateValues<F>[string];
// @ts-expect-error A block without a toggle reads no booleans.
const numbersOnly: Reads<{ n: { type: 'number'; label: 'N' } }> = true;
const withToggle: Reads<{ b: { type: 'boolean'; label: 'B' } }> = true;
// A field of either of two kinds, neither a toggle, isn't one either.
type Either = { v: NumberField | TextField };
// @ts-expect-error
const eitherKind: FieldValues<Either>['v'] = true;
void [numbersOnly, withToggle, eitherKind];
