import { isPropertyName, readProperties } from '@wikistow/client';
import { PluginError } from '@wikistow/plugin-sdk';
import { BlockField, PROPERTY_NAME } from '@wikistow/plugin-sdk/protocol';
import { describe, expect, it } from 'vite-plus/test';
import {
  blockProperties,
  checkedProperty,
  pageBlockProperties,
  setOwn,
  propertyNamed,
  stillShown,
} from '../src/plugins/block-properties.ts';

const PAGE = '---\nservings: 4\nCook Time: 20\ntags: [soup, bread]\nnested:\n  a: 1\n---\n';

const read = (frontmatter: string | null) => {
  const result = readProperties(frontmatter);
  return result.ok ? result.properties : null;
};

describe('a block’s view of the page’s properties', () => {
  it('is each key as written with its value, empty without frontmatter, null where it doesn’t read', () => {
    expect(blockProperties(read(PAGE))).toEqual({
      servings: 4,
      'Cook Time': 20,
      tags: ['soup', 'bread'],
      nested: 'a: 1',
    });
    expect(blockProperties(read(null))).toEqual({});
    expect(blockProperties(read('---\n- a list\n---\n'))).toBeNull();
  });

  it('is read from a page’s whole Markdown as the previews read it', () => {
    expect(pageBlockProperties(`${PAGE}Body with \`=servings\`.\n`)).toEqual(
      blockProperties(read(PAGE)),
    );
    expect(pageBlockProperties('No frontmatter.\n')).toEqual({});
    expect(pageBlockProperties('---\n- a list\n---\n')).toBeNull();
  });

  it('finds a value by its name as a reference does', () => {
    const properties = blockProperties(read(PAGE));
    expect(propertyNamed(properties, 'servings')).toBe(4);
    expect(propertyNamed(properties, 'cook_time')).toBe(20);
    expect(propertyNamed(properties, 'missing')).toBeUndefined();
    expect(propertyNamed(null, 'servings')).toBeUndefined();
  });
});

describe('a property a block sets', () => {
  it('is a property name and a value a property holds, copied', () => {
    const list = ['a', ['b', 1]];
    const checked = checkedProperty('cook time', list);
    expect(checked).toEqual({ key: 'cook time', value: ['a', ['b', 1]] });
    expect(checked.value).not.toBe(list);
    expect(checkedProperty('servings', null)).toEqual({ key: 'servings', value: null });
  });

  it('is refused as invalid otherwise', () => {
    for (const [key, value] of [
      ['', 1],
      ['=servings', 1],
      [' servings', 1],
      [3, 1],
      ['servings', { a: 1 }],
      ['servings', Number.NaN],
      ['servings', [[['deep']]]],
      ['servings', undefined],
    ] as const) {
      expect(() => checkedProperty(key, value)).toThrow(PluginError);
    }
  });
});

describe('a view drawn with the page’s properties', () => {
  const shown = blockProperties(read(PAGE));
  const changed = (over: Record<string, unknown>) => ({ ...shown, ...over }) as typeof shown;

  it('still stands for them after a change it made itself, by any name for the key', () => {
    expect(stillShown({ shown, own: new Map() }, shown)).toBe(true);
    expect(stillShown({ shown, own: new Map([['servings', 6]]) }, changed({ servings: 6 }))).toBe(
      true,
    );
    expect(
      stillShown({ shown, own: new Map([['cook time', 25]]) }, changed({ 'Cook Time': 25 })),
    ).toBe(true);
  });

  it('is drawn again when a key it set is set back to what it was drawn with', () => {
    // Drawn at 4, the view set 6, and Properties or another block set 4 again.
    expect(stillShown({ shown, own: new Map([['servings', 6]]) }, changed({ servings: 4 }))).toBe(
      false,
    );
  });

  it('is drawn again when a key it set, or added, is removed', () => {
    const { servings: _gone, ...without } = shown ?? {};
    expect(stillShown({ shown, own: new Map([['servings', 6]]) }, without)).toBe(false);
    // Added by the view, then removed: in neither the drawn properties nor these.
    expect(stillShown({ shown, own: new Map([['rating', 5]]) }, changed({}))).toBe(false);
    expect(stillShown({ shown, own: new Map([['rating', 5]]) }, changed({ rating: 5 }))).toBe(true);
  });

  it('follows another block on the same key, and stands for the one that set it last', () => {
    const first = { shown, own: new Map([['servings', 6]]) };
    const second = { shown, own: new Map([['servings', 7]]) };
    const page = changed({ servings: 7 });
    expect(stillShown(first, page)).toBe(false);
    expect(stillShown(second, page)).toBe(true);
  });

  it('is drawn again for any other change', () => {
    expect(stillShown({ shown, own: new Map() }, changed({ servings: 6 }))).toBe(false);
    expect(stillShown({ shown, own: new Map([['servings', 6]]) }, changed({ servings: 8 }))).toBe(
      false,
    );
    expect(stillShown({ shown, own: new Map([['servings', 6]]) }, changed({ tags: [] }))).toBe(
      false,
    );
    expect(stillShown({ shown, own: new Map() }, null)).toBe(false);
  });
});

describe('a change a view makes itself', () => {
  it('is noted, and a refused one leaves the value it set before', () => {
    const drawn = { shown: blockProperties(read(PAGE)), own: new Map() };
    setOwn(drawn, 'servings', 5, () => {});
    expect(drawn.own.get('servings')).toBe(5);
    const refused = () => {
      throw new PluginError('invalid', 'servings can’t be changed here');
    };
    expect(() => setOwn(drawn, 'Servings', 'a', refused)).toThrow(PluginError);
    expect(drawn.own.get('servings')).toBe(5);
    // A key it never set is forgotten again.
    expect(() => setOwn(drawn, 'rating', 3, refused)).toThrow(PluginError);
    expect(drawn.own.has('rating')).toBe(false);
  });
});

describe('a script field bound to a property', () => {
  it('is named by the rule the app’s references follow', () => {
    for (const name of ['servings', 'Cook time', 'cook_time', 'größe', 'नमस्ते', '2nd-go', 'a b']) {
      expect([name, PROPERTY_NAME.test(name)]).toEqual([name, isPropertyName(name)]);
      expect(isPropertyName(name)).toBe(true);
    }
    for (const name of ['', ' a', '_a', '-a', 'a.b', 'a:b', '=a', 'a\nb']) {
      expect([name, PROPERTY_NAME.test(name)]).toEqual([name, isPropertyName(name)]);
      expect(isPropertyName(name)).toBe(false);
    }
    const field = { type: 'number', label: 'Servings', property: 'servings' };
    expect(BlockField.safeParse(field).success).toBe(true);
    expect(BlockField.safeParse({ ...field, property: 'a.b' }).success).toBe(false);
    expect(BlockField.safeParse({ ...field, property: 'x'.repeat(101) }).success).toBe(false);
  });
});
