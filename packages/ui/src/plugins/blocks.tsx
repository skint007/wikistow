import { foldPropertyName } from '@wikistow/client';
import type { BlockProps, PageRef, PropertyValue } from '@wikistow/plugin-sdk';
import type { Element, ElementContent } from 'hast';
import { use, useMemo, useRef } from 'react';
import { PageProperties } from '../page/body-context';
import { ReadingChanges } from '../page/reading-changes';
import {
  blockProperties,
  checkedProperty,
  stillShown,
  type DrawnProperties,
} from './block-properties';
import { usePlugins, type PluginBlock } from './runtime';
import { PluginView } from './views';

/** A fence's text from the reader's tree: its code, without the final line break the tree adds. */
export function textOf(code: Element): string {
  const text = (node: ElementContent): string =>
    node.type === 'text'
      ? node.value
      : node.type === 'element'
        ? node.children.map(text).join('')
        : '';
  return code.children.map(text).join('').replace(/\n$/, '');
}

/**
 * A plugin block in the reader: the plugin's view of the fence's text, and
 * of the page's properties as shown. Where the page can change while it's
 * read (`ReadingChanges`), `setProperty` queues a property's change, as a
 * tick is; elsewhere it is null, and values entered stay in the view. The
 * view is drawn again as the properties change, but not for its own
 * change (`stillShown`).
 */
export function ReaderBlock({
  block,
  source,
  page,
}: {
  block: PluginBlock;
  source: string;
  page: PageRef;
}) {
  const { plugins } = usePlugins();
  const name = plugins.find(({ plugin }) => plugin.manifest.id === block.pluginId)?.plugin.manifest
    .name;
  const { spaceId, pageId } = page;
  const read = use(PageProperties);
  const properties = useMemo(() => blockProperties(read), [read]);
  const reading = use(ReadingChanges);
  const change = reading?.rights.allowed ? reading.change : null;
  // The props the view was drawn with, kept while they still stand for
  // the page: the same for the same text, page and rights, and properties
  // changed by none but the view. The same every render that keeps them.
  const drawn = useRef<{
    props: BlockProps;
    properties: DrawnProperties;
    with: readonly unknown[];
  } | null>(null);
  const made = [source, spaceId, pageId, change];
  const kept = drawn.current;
  if (
    !kept ||
    kept.with.some((part, i) => part !== made[i]) ||
    !stillShown(kept.properties, properties)
  ) {
    const shown: DrawnProperties = { shown: properties, own: new Map() };
    const setProperty = change
      ? (key: string, value: PropertyValue) => {
          const checked = checkedProperty(key, value);
          // A view drawn over since changes nothing.
          if (drawn.current?.properties !== shown) return;
          shown.own.set(foldPropertyName(checked.key), checked.value);
          change({ kind: 'property', ...checked });
        }
      : null;
    drawn.current = {
      props: { source, page: { spaceId, pageId }, setSource: null, properties, setProperty },
      properties: shown,
      with: made,
    };
  }
  const props = drawn.current?.props;
  return (
    <div className="plugin-block" data-plugin-block={block.type}>
      {props && (
        <PluginView
          pluginId={block.pluginId}
          name={name ?? block.pluginId}
          view={block.view}
          props={props}
        />
      )}
    </div>
  );
}
