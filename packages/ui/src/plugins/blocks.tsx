import type { PageRef } from '@wikistow/plugin-sdk';
import type { Element, ElementContent } from 'hast';
import { use, useEffect, useMemo, useRef } from 'react';
import { PageProperties } from '../page/body-context';
import { ReadingChanges } from '../page/reading-changes';
import { applyChange, type ReadingChange } from '../page/reading-changes-model';
import { drawBlock, type BlockDrawing, type BlockInputs } from './block-drawing';
import { blockProperties } from './block-properties';
import { usePluginRuntime, type PluginBlock } from './runtime';

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
 * What a plugin block or span in the reader is drawn for: the page's
 * properties as shown, and, where the page can change while it's read
 * (`ReadingChanges`), a `setProperty` that queues a property's change, as
 * a tick is, once it is known to apply to the page as shown; one that
 * can't is refused as the visual editor refuses it, and nothing is queued.
 * Elsewhere it is null, and values entered stay in the view. `setSource`
 * is always null here: the reader changes no block's or span's text.
 */
function useReaderInputs(source: string, page: PageRef): BlockInputs {
  const read = use(PageProperties);
  const properties = useMemo(() => blockProperties(read), [read]);
  const reading = use(ReadingChanges);
  const change = reading?.rights.allowed ? reading.change : null;
  const shown = reading?.markdown ?? '';
  return {
    runtime: usePluginRuntime(),
    source,
    page: { spaceId: page.spaceId, pageId: page.pageId },
    properties,
    setSource: null,
    setProperty: change
      ? (key, value) => {
          // It must apply to the page as shown when it comes.
          const made: ReadingChange = { kind: 'property', key, value };
          const applies = applyChange(shown, made);
          if (applies.ok) change(made);
          return applies;
        }
      : null,
  };
}

/**
 * A plugin block in the reader (`drawBlock`): the plugin's view of the
 * fence's text, and of the page's properties as shown, which it can set
 * where the page can change while it's read (`useReaderInputs`).
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
  const host = useDrawing<HTMLDivElement>(block, useReaderInputs(source, page));
  return <div ref={host} className="plugin-block" data-plugin-block={block.type} />;
}

/**
 * Inline code a running plugin claims, in the reader (ADR 0011, decision
 * 7): the plugin's view of the span's text, drawn as a block's is
 * (`drawBlock`), with the page's properties, which it can set as a block
 * can (`useReaderInputs`). The span's text can't change here, so `setText`
 * is null (#402, decided 2026-11-13).
 */
export function ReaderSpan({
  span,
  text,
  page,
}: {
  span: PluginBlock;
  text: string;
  page: PageRef;
}) {
  const host = useDrawing<HTMLSpanElement>(span, useReaderInputs(text, page));
  return <span ref={host} className="plugin-inline" data-plugin-inline={span.type} />;
}

/** The element `block` is drawn into, for `inputs` as they are each render. */
function useDrawing<E extends HTMLElement>(
  { pluginId, type, view }: PluginBlock,
  inputs: BlockInputs,
) {
  const latest = useRef(inputs);
  latest.current = inputs;
  const host = useRef<E>(null);
  const drawing = useRef<BlockDrawing | null>(null);
  // Drawn afresh for another view, as the plugin reloads; the runtime
  // builds its list of blocks again on every change, so not for that.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const drawn = drawBlock(element, { pluginId, type, view }, latest.current);
    drawing.current = drawn;
    return () => {
      drawn.destroy();
      drawing.current = null;
    };
  }, [pluginId, type, view]);
  // Every render's inputs: the drawing decides whether they draw it again.
  useEffect(() => drawing.current?.update(inputs));
  return host;
}
