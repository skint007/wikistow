import {
  foldPropertyName,
  isPropertyName,
  readProperties,
  splitFrontmatter,
  type PropertyData,
} from '@wikistow/client';
import { PluginError, type PropertyValue } from '@wikistow/plugin-sdk';

// A page's properties as a plugin block sees and sets them (#212): its
// frontmatter's keys as written, with their values (`BlockProps`), and
// `setProperty`, which the reader queues and the visual editor makes as the
// person's edit. A view is drawn again as the properties change, but not
// for a change it made itself, as for its own `setSource`: drawn afresh, a
// form would lose the field being typed in.

/** A block's view of the page's properties. */
export type BlockProperties = Readonly<Record<string, PropertyValue>> | null;

/** `properties`, as read from the frontmatter, as a block's view gets them; null where they don't read. */
export function blockProperties(properties: readonly PropertyData[] | null): BlockProperties {
  if (!properties) return null;
  const record: Record<string, PropertyValue> = {};
  // The first of two keys alike wins, as references find them.
  for (const { key, value } of properties) if (!Object.hasOwn(record, key)) record[key] = value;
  return record;
}

/** A page's properties as a block on it sees them, from its whole Markdown, as the previews read them. */
export function pageBlockProperties(markdown: string): BlockProperties {
  const read = readProperties(splitFrontmatter(markdown).frontmatter);
  return blockProperties(read.ok ? read.properties : null);
}

/** The value of the first key of `properties` whose name matches `name`, as `` `=name` `` finds it. */
export function propertyNamed(
  properties: BlockProperties,
  name: string,
): PropertyValue | undefined {
  if (!properties) return undefined;
  if (Object.hasOwn(properties, name)) return properties[name];
  const folded = foldPropertyName(name);
  const key = Object.keys(properties).find((other) => foldPropertyName(other) === folded);
  return key === undefined ? undefined : properties[key];
}

const isScalar = (value: unknown) =>
  value === null || ['string', 'boolean'].includes(typeof value) || Number.isFinite(value);

/**
 * `key` and `value` as a block gave them to `setProperty`, checked: a
 * property's name, and a value a property can hold. Anything else is
 * refused as `invalid`, as a plugin's arguments are.
 */
export function checkedProperty(
  key: unknown,
  value: unknown,
): { key: string; value: PropertyValue } {
  if (typeof key !== 'string' || !isPropertyName(key))
    throw new PluginError(
      'invalid',
      'A property is named by a letter or digit, then letters, digits, spaces, _ and -',
    );
  const fits =
    isScalar(value) ||
    (Array.isArray(value) &&
      value.every((item) => isScalar(item) || (Array.isArray(item) && item.every(isScalar))));
  if (!fits)
    throw new PluginError(
      'invalid',
      'A property holds text, a number, true or false, or a list of them',
    );
  // Copied, so a list the plugin changes later isn't the one set.
  return { key, value: structuredClone(value as PropertyValue) };
}

/**
 * Note that the view drawn with `drawn` set `key` to `value`, then `set`
 * it; if that fails, the view's last value for the key stands again, as
 * the page still has it.
 */
export function setOwn(drawn: DrawnProperties, key: string, value: PropertyValue, set: () => void) {
  const folded = foldPropertyName(key);
  const had = drawn.own.has(folded);
  const before = drawn.own.get(folded);
  drawn.own.set(folded, value);
  try {
    set();
  } catch (error) {
    if (had) drawn.own.set(folded, before as PropertyValue);
    else drawn.own.delete(folded);
    throw error;
  }
}

/** The properties a view was drawn with, and the values it set itself since, by folded name. */
export type DrawnProperties = { shown: BlockProperties; own: Map<string, PropertyValue> };

const same = (a: PropertyValue | undefined, b: PropertyValue | undefined) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether a view drawn with `drawn` stands for the page's properties
 * `now`. A key the view set itself must have the value it set, whatever
 * the view was drawn with: set back, or gone, the view is drawn again.
 * Every other key must be as it was drawn. The very properties it was
 * drawn with stand for themselves, as a change it just made hasn't come
 * back yet.
 */
export function stillShown(drawn: DrawnProperties, now: BlockProperties): boolean {
  if (drawn.shown === now) return true;
  if (drawn.shown === null || now === null) return false;
  const keys = new Set([...Object.keys(drawn.shown), ...Object.keys(now)]);
  const found = new Set<string>();
  for (const key of keys) {
    const folded = foldPropertyName(key);
    if (drawn.own.has(folded)) {
      if (!Object.hasOwn(now, key) || !same(drawn.own.get(folded), now[key])) return false;
      found.add(folded);
    } else if (!same(drawn.shown[key], now[key])) return false;
  }
  for (const folded of drawn.own.keys()) if (!found.has(folded)) return false;
  return true;
}
