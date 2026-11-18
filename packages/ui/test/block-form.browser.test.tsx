import { readProperties } from '@wikistow/client';
import {
  PluginError,
  type BlockField,
  type BlockProps,
  type PropertyValue,
} from '@wikistow/plugin-sdk';
import type { BlockSpec } from '@wikistow/plugin-sdk/protocol';
import { act } from 'react';
import { userEvent } from 'vite-plus/test/browser/context';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { formView, LIST_NOTE, readFields } from '../src/plugins/block-form.tsx';
import { boundSet, boundValue, checkField } from '../src/plugins/field-control.tsx';
import { blockProperties } from '../src/plugins/block-properties.ts';
import { updateInPlace } from '../src/plugins/in-place.ts';

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

  it('changes nothing when a field showing a default for a missing key is only visited', async () => {
    const form = await draw({ properties: read(null) });
    expect(form.field('Servings').value).toBe('2');
    form.field('Servings').focus();
    await userEvent.keyboard('{Enter}');
    await act(async () => form.field('Servings').blur());
    expect(form.set).toEqual([]);
  });

  it('sets the default it shows for a missing key once it’s typed', async () => {
    const form = await draw({ properties: read(null) });
    await userEvent.clear(form.field('Servings'));
    await userEvent.type(form.field('Servings'), '2{Enter}');
    expect(form.set).toEqual([['servings', 2]]);
    // Set, it's the page's value: committing it again sets nothing more.
    await userEvent.keyboard('{Enter}');
    await act(async () => form.field('Servings').blur());
    expect(form.set).toEqual([['servings', 2]]);
  });

  it('only shows a list it’s bound to, and a visit changes nothing', async () => {
    const form = await draw({ properties: read('---\nservings: [2, 4]\n---\n') });
    expect(form.field('Servings').value).toBe('2, 4');
    expect(form.field('Servings').readOnly).toBe(true);
    expect(form.element.textContent).toContain('A list: change it in the page’s properties');
    form.field('Servings').focus();
    await userEvent.keyboard('{Enter}');
    await act(async () => form.field('Servings').blur());
    expect(form.set).toEqual([]);
  });

  it('sets nothing for the value the page already has', async () => {
    const form = await draw({});
    form.field('Servings').focus();
    await userEvent.keyboard('{Enter}');
    await act(async () => form.field('Servings').blur());
    expect(form.set).toEqual([]);
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

describe('a form taking new properties in place', () => {
  it('shows the page’s value as it changes, and the fence line or default once the key is gone', async () => {
    const element = document.createElement('div');
    document.body.append(element);
    const props = (properties: ReturnType<typeof read>): BlockProps => ({
      source: 'base: 4\nflour: 500\nservings: 3',
      page: { spaceId: 's', pageId: 'p' },
      setSource: null,
      properties,
      setProperty: () => {},
    });
    await act(async () => {
      const undo = formView(SPEC, async (_page, values) => {
        const { servings, base, flour } = values as Record<string, number>;
        return { scaled: { value: ((flour ?? 0) * (servings ?? 0)) / (base ?? 1) } };
      })(element, props(read('---\nservings: 6\n---\n')));
      if (undo) undos.push(undo);
    });
    const servings = () => element.querySelector('input');
    const output = () => element.querySelector('output[data-output="scaled"]')?.textContent;
    expect(servings()?.value).toBe('6');
    await expect.poll(output).toBe('750');
    await act(async () => updateInPlace(element, props(read('---\nservings: 8\n---\n'))));
    expect(servings()?.value).toBe('8');
    await expect.poll(output).toBe('1,000');
    // Removed in Properties, or a queued change that added it dropped: the fence's line again.
    const first = servings();
    await act(async () => updateInPlace(element, props(read('---\nother: 1\n---\n'))));
    expect(servings()).toBe(first);
    expect(servings()?.value).toBe('3');
    await expect.poll(output).toBe('375');
    // Turned into a list, it only shows it; and back, it can be typed in again.
    await act(async () => updateInPlace(element, props(read('---\nservings: [4]\n---\n'))));
    expect(servings()?.readOnly).toBe(true);
    expect(element.textContent).toContain(LIST_NOTE);
    await act(async () => updateInPlace(element, props(read('---\nservings: 4\n---\n'))));
    expect(servings()?.readOnly).toBe(false);
    expect(servings()?.value).toBe('4');
    expect(element.textContent).not.toContain(LIST_NOTE);
    await expect.poll(output).toBe('500');
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
      // A list isn't a field's value: the field only shows it.
      tags: { text: 'soup', value: null, problem: LIST_NOTE },
    });
    expect(readFields(spec, 'servings: 9', {}).servings).toEqual({
      text: '9',
      value: 9,
      problem: null,
    });
  });
});

describe('a text field bound to a property', () => {
  it('leaves an empty value alone when only focused and left, and types what’s entered there', async () => {
    const element = document.createElement('div');
    document.body.append(element);
    const set: [string, PropertyValue][] = [];
    const spec: BlockSpec = {
      type: 'noted',
      fields: { note: { type: 'text', label: 'Note', property: 'note' } },
      outputs: {},
    };
    await act(async () => {
      const undo = formView(spec, async () => ({}))(element, {
        source: '',
        page: { spaceId: 's', pageId: 'p' },
        setSource: null,
        properties: read('---\nnote:\n---\n'),
        setProperty: (key, value) => void set.push([key, value]),
      });
      if (undo) undos.push(undo);
    });
    const input = element.querySelector('input');
    if (!input) throw new Error('No field');
    expect(input.value).toBe('');
    input.focus();
    await act(async () => input.blur());
    await userEvent.type(input, '4{Enter}');
    expect(set).toEqual([['note', 4]]);
  });

  it('keeps the type of the value it replaces when its text reads as one', () => {
    expect(boundValue('5', 4)).toBe(5);
    expect(boundValue('five', 4)).toBe('five');
    expect(boundValue('false', true)).toBe(false);
    expect(boundValue('maybe', true)).toBe('maybe');
    expect(boundValue('5', 'four')).toBe('5');
    // A key the page hasn't is typed as the rows type a key they add.
    expect(boundValue('5', undefined)).toBe(5);
    expect(boundValue('true', undefined)).toBe(true);
    expect(boundValue('soon', undefined)).toBe('soon');
    // An empty value takes what the text reads as, as Properties types it.
    expect(boundValue('', null)).toBeNull();
    expect(boundValue('4', null)).toBe(4);
    expect(boundValue('true', null)).toBe(true);
    expect(boundValue('soon', null)).toBe('soon');
    // Emptied, as the Properties rows empty a value.
    expect(boundValue('', 'Italian')).toBeNull();
    expect(boundValue('', true)).toBeNull();
    expect(boundValue('', 4)).toBeNull();
    expect(boundValue('', '')).toBe('');
  });

  it('sets a number for a number on the page, as the form commits it', async () => {
    const element = document.createElement('div');
    document.body.append(element);
    const set: [string, PropertyValue][] = [];
    const spec: BlockSpec = {
      type: 'rated',
      fields: { rating: { type: 'text', label: 'Rating', property: 'rating' } },
      outputs: {},
    };
    await act(async () => {
      const undo = formView(spec, async () => ({}))(element, {
        source: '',
        page: { spaceId: 's', pageId: 'p' },
        setSource: null,
        properties: read('---\nrating: 4\n---\n'),
        setProperty: (key, value) => void set.push([key, value]),
      });
      if (undo) undos.push(undo);
    });
    const input = element.querySelector('input');
    if (!input) throw new Error('No field');
    expect(input.value).toBe('4');
    await userEvent.clear(input);
    await userEvent.type(input, '5{Enter}');
    await userEvent.clear(input);
    await userEvent.type(input, 'five{Enter}');
    expect(set).toEqual([
      ['rating', 5],
      ['rating', 'five'],
    ]);
  });
});

// Fields of the kinds after number and text (#402): a toggle, a choice, a
// date and a slider, each bound to a property or written to its line.
const KINDS: BlockSpec = {
  type: 'task',
  fields: {
    done: { type: 'boolean', label: 'Done', property: 'done' },
    status: {
      type: 'choice',
      label: 'Status',
      options: [
        { value: 'todo', label: 'To do' },
        { value: 'doing', label: 'Doing' },
        { value: 'done', label: 'Done' },
      ],
      default: 'todo',
      property: 'status',
    },
    due: { type: 'date', label: 'Due', property: 'due' },
    level: { type: 'number', label: 'Level', min: 0, max: 10, slider: true, property: 'level' },
    flag: { type: 'boolean', label: 'Flag' },
    size: {
      type: 'choice',
      label: 'Size',
      options: [
        { value: 's', label: 'Small' },
        { value: 'l', label: 'Large' },
      ],
    },
    when: { type: 'date', label: 'When', default: '2026-01-02' },
    amount: { type: 'number', label: 'Amount', min: 0, max: 100, step: 5, slider: true },
  },
  outputs: { seen: { label: 'Seen' } },
};

/** The kinds' form drawn with `props`; what it set and wrote, and the values last calculated. */
async function drawKinds(props: Partial<BlockProps>) {
  const sources: string[] = [];
  const set: [string, PropertyValue][] = [];
  const calculated: Record<string, unknown>[] = [];
  const element = document.createElement('div');
  document.body.append(element);
  await act(async () => {
    const undo = formView(KINDS, async (_page, values) => {
      calculated.push(values);
      return { seen: { value: Object.keys(values).length } };
    })(element, {
      source: 'flag: false\nsize: s\namount: 20',
      page: { spaceId: 's', pageId: 'p' },
      setSource: (source) => sources.push(source),
      properties: read('---\ndone: false\nstatus: doing\ndue: 2026-11-18T09:30\nlevel: 3\n---\n'),
      setProperty: (key, value) => void set.push([key, value]),
      ...props,
    });
    if (undo) undos.push(undo);
  });
  const field = <E extends HTMLElement>(label: string, selector: string) => {
    const found = [...element.querySelectorAll('label')]
      .find((each) => each.textContent?.startsWith(label))
      ?.querySelector<E>(selector);
    if (!found) throw new Error(`No field ${label}`);
    return found;
  };
  const toggle = (label: string) => field<HTMLButtonElement>(label, '[role="switch"]');
  const date = (label: string) => field<HTMLInputElement>(label, 'input[type="date"]');
  const slider = (label: string) => field<HTMLInputElement>(label, 'input[type="range"]');
  const choose = async (label: string, option: string) => {
    await act(async () => {
      field(label, '[data-slot="picker"]').dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      );
    });
    await act(async () => {
      [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
        .find((each) => each.textContent === option)
        ?.click();
    });
  };
  return { element, field, toggle, date, slider, choose, sources, set, calculated };
}

describe('form fields of other kinds', () => {
  it('read their values from the page and the fence, and hand them to the calculation typed', async () => {
    const form = await drawKinds({});
    expect(form.toggle('Done').getAttribute('aria-checked')).toBe('false');
    expect(form.field('Status', '[data-slot="picker"]').textContent).toBe('Doing');
    // A date with a time shows its day.
    expect(form.date('Due').value).toBe('2026-11-18');
    expect(form.slider('Level').value).toBe('3');
    expect(form.slider('Amount').step).toBe('5');
    await expect
      .poll(() => form.calculated.at(-1))
      .toEqual({
        done: false,
        status: 'doing',
        due: '2026-11-18',
        level: 3,
        flag: false,
        size: 's',
        when: '2026-01-02',
        amount: 20,
      });
    expect(form.set).toEqual([]);
    expect(form.sources).toEqual([]);
  });

  it('set a bound property as a toggle or choice is picked: true or false, and text', async () => {
    const form = await drawKinds({});
    await userEvent.click(form.toggle('Done'));
    expect(form.set).toEqual([['done', true]]);
    await form.choose('Status', 'Done');
    expect(form.set).toEqual([
      ['done', true],
      ['status', 'done'],
    ]);
    expect(form.sources).toEqual([]);
  });

  it('write an unbound field’s line as it changes', async () => {
    const form = await drawKinds({});
    await userEvent.click(form.toggle('Flag'));
    expect(form.sources.at(-1)).toBe('flag: true\nsize: s\namount: 20');
    await form.choose('Size', 'Large');
    expect(form.sources.at(-1)).toBe('flag: true\nsize: l\namount: 20');
    await userEvent.fill(form.date('When'), '2026-03-04');
    expect(form.sources.at(-1)).toBe('flag: true\nsize: l\namount: 20\nwhen: 2026-03-04');
    form.slider('Amount').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(form.sources.at(-1)).toBe('flag: true\nsize: l\namount: 25\nwhen: 2026-03-04');
    expect(form.set).toEqual([]);
  });

  it('set a bound date on blur, keeping its time, and a slider as it’s let go', async () => {
    const form = await drawKinds({});
    await userEvent.fill(form.date('Due'), '2026-12-01');
    expect(form.set).toEqual([]);
    await act(async () => form.date('Due').blur());
    expect(form.set).toEqual([['due', '2026-12-01T09:30']]);
    form.slider('Level').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(form.set).toEqual([
      ['due', '2026-12-01T09:30'],
      ['level', 4],
    ]);
    // Let go again where it is, nothing more is set.
    await act(async () => form.slider('Level').blur());
    expect(form.set).toHaveLength(2);
  });

  it('keep a bound date’s time when its input is emptied on the way to another day', async () => {
    const form = await drawKinds({});
    await userEvent.clear(form.date('Due'));
    await userEvent.fill(form.date('Due'), '2026-11-19');
    await act(async () => form.date('Due').blur());
    expect(form.set).toEqual([['due', '2026-11-19T09:30']]);
  });

  it('take no time back once the page’s date is emptied elsewhere', async () => {
    const element = document.createElement('div');
    document.body.append(element);
    const set: [string, PropertyValue][] = [];
    const spec: BlockSpec = {
      type: 'due',
      fields: { due: { type: 'date', label: 'Due', property: 'due' } },
      outputs: {},
    };
    const props = (properties: ReturnType<typeof read>): BlockProps => ({
      source: '',
      page: { spaceId: 's', pageId: 'p' },
      setSource: null,
      properties,
      setProperty: (key, value) => void set.push([key, value]),
    });
    await act(async () => {
      const undo = formView(spec, async () => ({}))(
        element,
        props(read('---\ndue: 2026-11-18T09:30\n---\n')),
      );
      if (undo) undos.push(undo);
    });
    const input = () => element.querySelector<HTMLInputElement>('input[type="date"]')!;
    await userEvent.clear(input());
    await userEvent.fill(input(), '2026-11-19');
    await act(async () => input().blur());
    await act(async () => updateInPlace(element, props(read('---\ndue:\n---\n'))));
    await userEvent.fill(input(), '2026-12-01');
    await act(async () => input().blur());
    expect(set).toEqual([
      ['due', '2026-11-19T09:30'],
      ['due', '2026-12-01'],
    ]);
  });

  it('keep a number or boolean a choice replaces one, and set text otherwise', () => {
    const rating: BlockField = {
      type: 'choice',
      label: 'Rating',
      options: [{ value: '5', label: 'Five' }],
      property: 'rating',
    };
    expect(boundSet(rating, '5', '5', 4)).toBe(5);
    expect(boundSet(rating, '5', '5', 'four')).toBe('5');
    expect(boundSet(rating, '5', '5', undefined)).toBe('5');
    const yes: BlockField = { ...rating, options: [{ value: 'true', label: 'Yes' }] };
    expect(boundSet(yes, 'true', 'true', false)).toBe(true);
    // Not where it would read back as another option.
    const signed: BlockField = { ...rating, options: [{ value: '+2', label: 'Plus two' }] };
    expect(boundSet(signed, '+2', '+2', 1)).toBe('+2');
  });

  it('show a slider’s value between its steps as invalid', () => {
    expect(readFields(KINDS, 'amount: 22').amount).toEqual({
      text: '22',
      value: null,
      problem: 'In steps of 5 from 0',
    });
    const tenths: BlockField = {
      type: 'number',
      label: 'T',
      min: 0,
      max: 1,
      step: 0.1,
      slider: true,
    };
    expect(checkField(tenths, '0.3')).toEqual({ value: 0.3, problem: null });
    const fine: BlockField = { ...tenths, min: 1_000_000, max: 1_000_001, step: 0.01 };
    expect(checkField(fine, '1000000.02')).toEqual({ value: 1000000.02, problem: null });
  });

  it('set a bound date’s day where the page has none', async () => {
    const form = await drawKinds({ properties: read(null) });
    expect(form.date('Due').value).toBe('');
    expect(form.element.textContent).toContain('Enter a date');
    await userEvent.fill(form.date('Due'), '2026-12-01');
    await act(async () => form.date('Due').blur());
    expect(form.set).toEqual([['due', '2026-12-01']]);
  });

  it('show a value that isn’t one they take as invalid', () => {
    const read = readFields(
      KINDS,
      'flag: yes\nsize: medium\nwhen: soon\namount: 200',
      blockProperties([]),
    );
    expect(read.flag).toEqual({ text: 'yes', value: null, problem: 'Not true or false' });
    expect(read.size).toEqual({ text: 'medium', value: null, problem: 'Not one of its choices' });
    expect(read.when).toEqual({ text: 'soon', value: null, problem: 'Not a date' });
    expect(read.amount).toEqual({ text: '200', value: null, problem: 'At most 100' });
    // Nothing written: a toggle is off, a choice takes its default.
    expect(read.done).toEqual({ text: '', value: false, problem: null });
    expect(read.status).toEqual({ text: 'todo', value: 'todo', problem: null });
    expect(readFields(KINDS, 'flag: TRUE').flag).toEqual({
      text: 'TRUE',
      value: true,
      problem: null,
    });
    expect(readFields(KINDS, 'when: 2026-02-30').when?.problem).toBe('Not a date');
  });

  it('only show a list they’re bound to', async () => {
    const form = await drawKinds({ properties: read('---\ndone: [a, b]\n---\n') });
    const shown = form.field<HTMLInputElement>('Done', 'input');
    expect(shown.value).toBe('a, b');
    expect(shown.readOnly).toBe(true);
    expect(form.element.textContent).toContain(LIST_NOTE);
  });
});
