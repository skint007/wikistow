import { BlockField } from '@wikistow/plugin-sdk/protocol';
import { declaredField } from '@wikistow/plugin-sdk/src/script.ts';
import { describe, expect, it } from 'vite-plus/test';

// A script's field declarations as its worker sends them to the app: only
// the keys that are set, so an app older than a key, which checks fields
// strictly, still takes a field that doesn't use it.

/** The field checks of an app from before fields could name a property. */
const [numberField, textField] = BlockField.options;
const older = [numberField.omit({ property: true }), textField.omit({ property: true })] as const;

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
    expect(BlockField.safeParse(field).success).toBe(true);
  });
});
