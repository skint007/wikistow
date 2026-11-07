import { readProperties } from '@wikistow/client';
import { PluginError, type BlockProps, type PropertyValue } from '@wikistow/plugin-sdk';
import type { BlockSpec } from '@wikistow/plugin-sdk/protocol';
import { act } from 'react';
import { userEvent } from 'vite-plus/test/browser/context';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { formView } from '../src/plugins/block-form.tsx';
import {
  drawBlock,
  type BlockDrawing,
  type BlockInputs,
  type BlockRuntime,
} from '../src/plugins/block-drawing.ts';
import { blockProperties } from '../src/plugins/block-properties.ts';
import type { PluginBlock } from '../src/plugins/runtime.ts';

// How a plugin block is drawn in the reader and the visual editor alike
// (#285): when its view keeps its props and when it is drawn again, its
// setters, and how it fails. Each place's own wiring is tested beside it
// (reader-block, block-editor).

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** A block's view of the properties a page with `yaml` as its frontmatter has. */
const props = (yaml: string) => {
  const read = readProperties(`---\n${yaml}\n---\n`);
  return blockProperties(read.ok ? read.properties : null);
};

/** A runtime that notes the views that failed and the plugins disabled. */
function runtime() {
  const failed: string[] = [];
  const disabled: string[] = [];
  const fake: BlockRuntime = {
    get: () => ({ plugins: [] }),
    viewFailed: (pluginId) => void failed.push(pluginId),
    disable: async (pluginId) => void disabled.push(pluginId),
  };
  return { fake, failed, disabled };
}

const drawings: BlockDrawing[] = [];
afterEach(async () => {
  for (const drawing of drawings.splice(0)) drawing.destroy();
  await act(async () => {});
  document.body.replaceChildren();
});

/**
 * A block drawn with `view`, for a page whose properties are `servings: 4`
 * and whose setters note what they're given; `sets` answers a property.
 */
function draw(view: PluginBlock['view'], given: Partial<BlockInputs> = {}) {
  const element = document.createElement('div');
  document.body.append(element);
  const sources: string[] = [];
  const set: [string, PropertyValue][] = [];
  const { fake, failed, disabled } = runtime();
  const inputs: BlockInputs = {
    runtime: fake,
    source: 'a',
    page: { spaceId: 's', pageId: 'p' },
    properties: props('servings: 4'),
    setSource: (text) => void sources.push(text),
    setProperty: (key, value) => {
      set.push([key, value]);
      return { ok: true };
    },
    ...given,
  };
  const drawing = drawBlock(element, { pluginId: 'test', type: 'servings', view }, inputs);
  drawings.push(drawing);
  return { element, drawing, inputs, sources, set, failed, disabled };
}

/** A view that notes each time it's drawn, and each time it's undone. */
function recorder() {
  const drawn: BlockProps[] = [];
  let undone = 0;
  const view = (element: HTMLElement, props: BlockProps) => {
    drawn.push(props);
    element.textContent = `Serves ${JSON.stringify(props.properties?.['servings'])}`;
    return () => void undone++;
  };
  return { view, drawn, undone: () => undone };
}

describe('a plugin block drawn', () => {
  it('keeps its props while the inputs stand for the page, and is drawn again when they don’t', () => {
    const r = recorder();
    const m = draw(r.view);
    expect(r.drawn).toHaveLength(1);
    // The same values again, new objects as each render makes them.
    m.drawing.update({ ...m.inputs, page: { spaceId: 's', pageId: 'p' }, setSource: () => {} });
    m.drawing.update({ ...m.inputs, properties: props('servings: 4') });
    expect(r.drawn).toHaveLength(1);
    m.drawing.destroy();
    expect(r.undone()).toBe(1);
    expect(m.element.childNodes).toHaveLength(0);
    // Each of these on its own draws it again, with what it changed.
    const changes: Partial<BlockInputs>[] = [
      { source: 'b' },
      { page: { spaceId: 's', pageId: 'q' } },
      { properties: props('servings: 5') },
      { setProperty: null },
      { runtime: runtime().fake },
    ];
    for (const change of changes) {
      const again = recorder();
      const drawn = draw(again.view);
      drawn.drawing.update({ ...drawn.inputs, ...change });
      expect([change, again.drawn.length, again.undone()]).toEqual([change, 2, 1]);
      const { runtime: _runtime, setProperty, ...given } = change;
      expect(again.drawn[1]).toMatchObject(given);
      if (setProperty === null) expect(again.drawn[1]?.setProperty).toBeNull();
    }
  });

  it('isn’t drawn again for its own setSource, even given back at once', () => {
    const r = recorder();
    let drawing: BlockDrawing | null = null;
    const m = draw(r.view, {
      // As the visual editor's node view is updated as the text changes.
      setSource: (text) => drawing?.update({ ...m.inputs, source: text }),
    });
    drawing = m.drawing;
    r.drawn[0]?.setSource?.('b');
    expect(r.drawn).toHaveLength(1);
    // Another text, not its own, draws it again.
    m.drawing.update({ ...m.inputs, source: 'c' });
    expect(r.drawn).toHaveLength(2);
    expect(r.drawn[1]?.source).toBe('c');
  });

  it('sets a property checked, not drawn again for it, but drawn again when the page shows otherwise', () => {
    const r = recorder();
    const m = draw(r.view);
    r.drawn[0]?.setProperty?.('servings', 6);
    expect(m.set).toEqual([['servings', 6]]);
    m.drawing.update({ ...m.inputs, properties: props('servings: 6') });
    expect(r.drawn).toHaveLength(1);
    // Set back by someone else: the view's 6 no longer stands.
    m.drawing.update({ ...m.inputs, properties: props('servings: 4') });
    expect(r.drawn).toHaveLength(2);
    expect(() => r.drawn[1]?.setProperty?.('a.b', 1)).toThrow(PluginError);
    expect(m.set).toHaveLength(1);
  });

  it('refuses a property the place refuses, its earlier value standing', () => {
    const r = recorder();
    const m = draw(r.view, {
      setProperty: (key) =>
        key === 'notes' ? { ok: false, reason: 'notes couldn’t be changed' } : { ok: true },
    });
    const set = r.drawn[0]?.setProperty;
    expect(() => set?.('notes', 'Stale.')).toThrow(/notes couldn’t be changed/);
    // The page as it was still stands for the view.
    m.drawing.update({ ...m.inputs, properties: props('servings: 4') });
    expect(r.drawn).toHaveLength(1);
  });

  it('drawn over, its old setters do nothing', () => {
    const r = recorder();
    const m = draw(r.view);
    const [first] = r.drawn;
    m.drawing.update({ ...m.inputs, source: 'b' });
    first?.setSource?.('x');
    first?.setProperty?.('servings', 9);
    expect(m.sources).toEqual([]);
    expect(m.set).toEqual([]);
  });

  it('that throws shows its note, tells the runtime, offers Disable, and is tried again as it’s drawn again', async () => {
    let throws = true;
    const m = draw((element) => {
      element.textContent = 'half drawn';
      if (throws) throw new Error('No');
    });
    await act(async () => {});
    expect(m.failed).toEqual(['test']);
    expect(m.element.textContent).toContain('test failed here.');
    expect(m.element.textContent).not.toContain('half drawn');
    await userEvent.click(m.element.querySelector('button') ?? m.element);
    expect(m.disabled).toEqual(['test']);
    throws = false;
    await act(async () => m.drawing.update({ ...m.inputs, source: 'b' }));
    expect(m.element.textContent).toBe('half drawn');
    expect(m.failed).toEqual(['test']);
  });
});

describe('a script block’s form drawn', () => {
  it('takes new properties in place, keeping the field being typed in', async () => {
    const spec: BlockSpec = {
      type: 'recipe',
      fields: {
        servings: { type: 'number', label: 'Servings', property: 'servings' },
        quantity: { type: 'number', label: 'Quantity', default: 1 },
      },
      outputs: {},
    };
    let m: ReturnType<typeof draw> | undefined;
    await act(async () => {
      m = draw(
        formView(spec, async () => ({})),
        { setSource: null },
      );
    });
    if (!m) throw new Error('Not drawn');
    const { element, drawing, inputs } = m;
    const field = (label: string) => {
      const input = [...element.querySelectorAll('label')]
        .find((found) => found.textContent?.startsWith(label))
        ?.querySelector('input');
      if (!input) throw new Error(`No field ${label}`);
      return input;
    };
    const quantity = field('Quantity');
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '3');
    expect(field('Servings').value).toBe('4');
    await act(async () => drawing.update({ ...inputs, properties: props('servings: 8') }));
    expect(field('Quantity')).toBe(quantity);
    expect(quantity.value).toBe('3');
    expect(field('Servings').value).toBe('8');
  });
});
