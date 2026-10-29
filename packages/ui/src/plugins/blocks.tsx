import {
  PluginError,
  type BlockProps,
  type PageRef,
  type PropertyValue,
} from '@wikistow/plugin-sdk';
import type { Element, ElementContent } from 'hast';
import { use, useMemo, useRef } from 'react';
import { PageProperties } from '../page/body-context';
import { ReadingChanges } from '../page/reading-changes';
import { applyChange, type ReadingChange } from '../page/reading-changes-model';
import {
  blockProperties,
  checkedProperty,
  setOwn,
  stillShown,
  type DrawnProperties,
} from './block-properties';
import { takesPropsInPlace } from './in-place';
import { usePluginRuntime, usePlugins, type PluginBlock } from './runtime';
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
 * tick is, once it is known to apply to the page as shown; one that can't
 * is refused as the visual editor refuses it, and nothing is queued.
 * Elsewhere it is null, and values entered stay in the view. A view the
 * app draws, a script's form, takes new properties in place; a plugin's
 * own is drawn again as they change, but not for its own change
 * (`stillShown`). Drawn again for another view or runtime, it gets the
 * properties as they are then.
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
  // The page as shown when a change comes, which it must apply to.
  const shownNow = useRef(reading?.markdown ?? '');
  shownNow.current = reading?.markdown ?? '';
  const runtime = usePluginRuntime();
  const inPlace = takesPropsInPlace(block.view);
  // The props the view was drawn with, kept while they still stand for
  // the page: the same for the same text, page, rights, view and runtime,
  // and properties changed by none but the view, or any for one that
  // takes them in place. The same every render that keeps them.
  const drawn = useRef<{
    props: BlockProps;
    properties: DrawnProperties;
    with: readonly unknown[];
  } | null>(null);
  const made = [source, spaceId, pageId, change, block.view, runtime];
  const kept = drawn.current;
  if (
    !kept ||
    kept.with.some((part, i) => part !== made[i]) ||
    (!inPlace && !stillShown(kept.properties, properties))
  ) {
    const shown: DrawnProperties = { shown: properties, own: new Map() };
    const setProperty = change
      ? (key: string, value: PropertyValue) => {
          const checked = checkedProperty(key, value);
          // A view drawn over since changes nothing.
          if (drawn.current?.properties !== shown) return;
          const made: ReadingChange = { kind: 'property', ...checked };
          setOwn(shown, checked.key, checked.value, () => {
            const applies = applyChange(shownNow.current, made);
            if (!applies.ok) throw new PluginError('invalid', applies.reason);
            change(made);
          });
        }
      : null;
    drawn.current = {
      props: { source, page: { spaceId, pageId }, setSource: null, properties, setProperty },
      properties: shown,
      with: made,
    };
  }
  const props = drawn.current?.props;
  // What a view the app draws takes in place: the props with the properties now.
  const live = useMemo(
    () => (inPlace && props ? { ...props, properties } : undefined),
    [inPlace, props, properties],
  );
  return (
    <div className="plugin-block" data-plugin-block={block.type}>
      {props && (
        <PluginView
          pluginId={block.pluginId}
          name={name ?? block.pluginId}
          view={block.view}
          props={props}
          live={live}
        />
      )}
    </div>
  );
}
