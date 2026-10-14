import type { PageRef } from '@wikistow/plugin-sdk';
import type { Element, ElementContent } from 'hast';
import { useMemo } from 'react';
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
 * A plugin block in the reader: the plugin's view of the fence's text.
 * Anything entered there stays in the view; the page doesn't change.
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
  const props = useMemo(
    () => ({ source, page: { spaceId, pageId }, setSource: null }),
    [source, spaceId, pageId],
  );
  return (
    <div className="plugin-block" data-plugin-block={block.type}>
      <PluginView
        pluginId={block.pluginId}
        name={name ?? block.pluginId}
        view={block.view}
        props={props}
      />
    </div>
  );
}
