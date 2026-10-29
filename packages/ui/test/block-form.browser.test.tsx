import { readProperties } from '@wikistow/client';
import { PluginError, type BlockProps, type PropertyValue } from '@wikistow/plugin-sdk';
import type { BlockSpec } from '@wikistow/plugin-sdk/protocol';
import { act } from 'react';
import { userEvent } from 'vite-plus/test/browser/context';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { formView, readFields } from '../src/plugins/block-form.tsx';
import { blockProperties } from '../src/plugins/block-properties.ts';

// A script's block form with a field bound to a page property (#212): it
// shows the page's value, and sets it once a valid value is committed,
// never as it's typed, and never in its fence line.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SPEC: BlockSpec = {
  type: 'recipe',
  fields: {
    servings: { type: 'number', label: 'Servings', default: 2, min: 1, property: 'servings' },
    base: { type: 'number', label: 'Recipe serves', default: 4 },
    flour: { type: 'number', label: 'Flour', default: 500 },
  },
  outputs: { scaled: { label: 'Flour needed' } },
};

const read = (frontmatter: string | null) => {
  const result = readProperties(frontmatter);
  return blockProperties(result.ok ? result.properties : null);
};

const undos: (() => void)[] = [];
afterEach(async () => {
  for (const undo of undos.splice(0)) undo();
  await act(async () => {});
  document.body.replaceChildren();
});

/** The form drawn with `props`, its calculation the scaled flour; what it set, by call. */
async function draw(props: Partial<BlockProps>) {
  const sources: string[] = [];
  const set: [string, PropertyValue][] = [];
  const element = document.createElement('div');
  document.body.append(element);
  const view = formView(SPEC, async (_page, values) => {
    const { servings, base, flour } = values as Record<string, number>;
    return { scaled: { value: ((flour ?? 0) * (servings ?? 0)) / (base ?? 1) } };
  });
  await act(async () => {
    const undo = view(element, {
      source: 'base: 4\nflour: 500',
      page: { spaceId: 's', pageId: 'p' },
      setSource: (source) => sources.push(source),
      properties: read('---\nservings: 6\n---\n'),
      setProperty: (key, value) => {
        set.push([key, value]);
      },
      ...props,
    });
    if (undo) undos.push(undo);
  });
  const field = (label: string) => {
    const input = [...element.querySelectorAll('label')]
      .find((found) => found.textContent?.startsWith(label))
      ?.querySelector('input');
    if (!input) throw new Error(`No field ${label}`);
    return input;
  };
  const output = () => element.querySelector('output[data-output="scaled"]')?.textContent;
  return { element, field, output, sources, set };
}

describe('a form field bound to a property', () => {
  it('shows the page’s value, and sets it on blur or Enter, as a number, never as it’s typed', async () => {
    const form = await draw({});
    expect(form.field('Servings').value).toBe('6');
    await expect.poll(form.output).toBe('750');
    await userEvent.clear(form.field('Servings'));
    await userEvent.type(form.field('Servings'), '12');
    expect(form.set).toEqual([]);
    await expect.poll(form.output).toBe('1,500');
    await userEvent.keyboard('{Enter}');
    expect(form.set).toEqual([['servings', 12]]);
    // Committed again unchanged, nothing more is set; changed, on blur.
    await userEvent.keyboard('{Enter}');
    await userEvent.type(form.field('Servings'), '0');
    await act(async () => form.field('Servings').blur());
    expect(form.set).toEqual([
      ['servings', 12],
      ['servings', 120],
    ]);
    // Its fence line is never written; the others' are, as they change.
    expect(form.sources).toEqual([]);
    await userEvent.type(form.field('Flour'), '0');
    expect(form.sources.at(-1)).toBe('base: 4\nflour: 5000');
  });

  it('commits no value that isn’t valid', async () => {
    const form = await draw({});
    await userEvent.clear(form.field('Servings'));
    await userEvent.type(form.field('Servings'), '0');
    await act(async () => form.field('Servings').blur());
    await userEvent.clear(form.field('Servings'));
    await userEvent.type(form.field('Servings'), 'lots{Enter}');
    expect(form.set).toEqual([]);
    expect(form.element.textContent).toContain('Not a number');
  });

  it('says why the page refused a value', async () => {
    const form = await draw({
      setProperty: () => {
        throw new PluginError('invalid', 'servings can’t be changed here');
      },
    });
    await userEvent.type(form.field('Servings'), '1{Enter}');
    expect(form.element.textContent).toContain('servings can’t be changed here');
    expect(form.field('Servings').getAttribute('aria-invalid')).toBe('true');
  });

  it('keeps a value entered in the form where the page can’t change, and takes its line or default without a value', async () => {
    const form = await draw({ setProperty: null, setSource: null, properties: read(null) });
    expect(form.field('Servings').value).toBe('2');
    await userEvent.clear(form.field('Servings'));
    await userEvent.type(form.field('Servings'), '3{Enter}');
    await act(async () => form.field('Servings').blur());
    expect(form.field('Servings').value).toBe('3');
    await expect.poll(form.output).toBe('375');
  });
});

describe('a script block’s fields as read', () => {
  it('take the page’s value for a bound field where it has one, else the line or default', () => {
    const spec: BlockSpec = {
      type: 'recipe',
      fields: {
        servings: { type: 'number', label: 'Servings', default: 2, property: 'servings' },
        cook: { type: 'text', label: 'Cook', property: 'cook_time' },
        base: { type: 'number', label: 'Serves', default: 4 },
        tags: { type: 'text', label: 'Tags', property: 'tags' },
      },
      outputs: {},
    };
    const properties = read('---\nservings: 4\nCook Time: 20\ntags: [soup]\n---\n');
    expect(readFields(spec, 'servings: 9\ntags: own\nbase: 3', properties)).toEqual({
      servings: { text: '4', value: 4, problem: null },
      cook: { text: '20', value: '20', problem: null },
      base: { text: '3', value: 3, problem: null },
      // A list isn't a field's value: the fence's line stands.
      tags: { text: 'own', value: 'own', problem: null },
    });
    expect(readFields(spec, 'servings: 9', {}).servings).toEqual({
      text: '9',
      value: 9,
      problem: null,
    });
  });
});
