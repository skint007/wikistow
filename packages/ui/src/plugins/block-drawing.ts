import {
  PluginError,
  type BlockProps,
  type PageRef,
  type PropertyValue,
} from '@wikistow/plugin-sdk';
import {
  checkedProperty,
  setOwn,
  stillShown,
  type BlockProperties,
  type DrawnProperties,
} from './block-properties';
import { takesPropsInPlace, updateInPlace } from './in-place';
import type { PluginBlock, PluginRuntime, PluginsSnapshot } from './runtime';
import { drawView } from './views';

/** What drawing a block asks of the plugins' runtime: its plugins' names, and where a view failed. */
export type BlockRuntime = Pick<PluginRuntime, 'viewFailed' | 'disable'> & {
  get(): Pick<PluginsSnapshot, 'plugins'>;
};

/**
 * What a plugin block is drawn for, as the place drawing it knows it: the
 * reader and the visual editor give the same kinds of inputs, and differ
 * only in what they can change.
 */
export type BlockInputs = {
  /** The runtime the block's plugin runs in, told when its view fails; another draws it again. */
  runtime: BlockRuntime;
  /** The block's text, as the page holds it now. */
  source: string;
  page: PageRef;
  /** The page's properties as shown now (`blockProperties`). */
  properties: BlockProperties;
  /** Makes `text` the block's text, as the person's edit; null where the text can't change. */
  setSource: ((text: string) => void) | null;
  /**
   * Sets a property already checked (`checkedProperty`), or says why it
   * can't; null where the page's properties can't change.
   */
  setProperty:
    | ((key: string, value: PropertyValue) => { ok: true } | { ok: false; reason: string })
    | null;
};

/** A block as drawn: given the inputs as they change, and undone. */
export type BlockDrawing = {
  /** The inputs now: the view is drawn again only if they no longer stand for what it shows. */
  update(inputs: BlockInputs): void;
  /** Undo the view, leaving the element empty. */
  destroy(): void;
};

/** The view as drawn: its inputs, the text it was drawn for or last set, its properties and props. */
type Drawn = {
  inputs: BlockInputs;
  source: string;
  properties: DrawnProperties;
  props: BlockProps;
  undo: () => void;
};

const samePage = (a: PageRef, b: PageRef) => a.spaceId === b.spaceId && a.pageId === b.pageId;

/**
 * Draw `block`'s view into `element`, for `inputs`, the one way the reader
 * and the visual editor both draw plugin blocks.
 *
 * The view keeps the props it was drawn with while they still stand for
 * the page: the same text, page, runtime and abilities, and the same
 * properties but for those it set itself (`stillShown`). Its own
 * `setSource` and `setProperty` don't draw it again, so a form keeps the
 * field being typed in. One the app draws, a script's form, takes new
 * properties in place instead (`updateInPlace`). Anything else draws it
 * again, with the inputs as they are then. A view that throws shows the
 * failure note (`drawView`), and is tried again as it would be drawn again.
 *
 * Nothing here is a fence's: a claimed span could be drawn the same way,
 * its view given these props under its own names.
 */
export function drawBlock(
  element: HTMLElement,
  block: PluginBlock,
  inputs: BlockInputs,
): BlockDrawing {
  const inPlace = takesPropsInPlace(block.view);

  const draw = (inputs: BlockInputs): Drawn => {
    const { runtime, source, page, properties } = inputs;
    const drawn: Drawn = {
      inputs,
      source,
      properties: { shown: properties, own: new Map() },
      props: {
        source,
        page: { spaceId: page.spaceId, pageId: page.pageId },
        properties,
        // Each calls the place's latest setter, and does nothing once the view is drawn over.
        setSource:
          inputs.setSource &&
          ((text: string) => {
            const set = current?.inputs.setSource;
            if (current !== drawn || !set) return;
            // Noted first: the place may give the new text back at once.
            drawn.source = text;
            set(text);
          }),
        setProperty:
          inputs.setProperty &&
          ((key: string, value: PropertyValue) => {
            const checked = checkedProperty(key, value);
            const set = current?.inputs.setProperty;
            if (current !== drawn || !set) return;
            setOwn(drawn.properties, checked.key, checked.value, () => {
              const made = set(checked.key, checked.value);
              if (!made.ok) throw new PluginError('invalid', made.reason);
            });
          }),
      },
      undo: () => {},
    };
    const name =
      runtime.get().plugins.find(({ plugin }) => plugin.manifest.id === block.pluginId)?.plugin
        .manifest.name ?? block.pluginId;
    drawn.undo = drawView(element, {
      pluginId: block.pluginId,
      name,
      view: block.view,
      props: drawn.props,
      runtime,
    });
    return drawn;
  };

  // Set apart from drawing, so a view calling its setters as it's drawn finds none.
  let current: Drawn | null = null;
  current = draw(inputs);

  return {
    update(inputs) {
      const drawn = current;
      if (!drawn) return;
      const was = drawn.inputs;
      const stands =
        inputs.runtime === was.runtime &&
        inputs.source === drawn.source &&
        samePage(inputs.page, was.page) &&
        (inputs.setSource === null) === (was.setSource === null) &&
        (inputs.setProperty === null) === (was.setProperty === null);
      if (stands && (inPlace || stillShown(drawn.properties, inputs.properties))) {
        // Kept: its setters call these from now on.
        drawn.inputs = inputs;
        // Given the same values again, as for another block's change, one drawn by the app takes nothing.
        if (
          inPlace &&
          JSON.stringify(drawn.properties.shown) !== JSON.stringify(inputs.properties)
        ) {
          drawn.properties = { shown: inputs.properties, own: new Map() };
          drawn.props = { ...drawn.props, properties: inputs.properties };
          updateInPlace(element, drawn.props);
        }
        return;
      }
      // Drawn over first, so a view's cleanup sets nothing.
      current = null;
      drawn.undo();
      current = draw(inputs);
    },
    destroy() {
      const drawn = current;
      current = null;
      drawn?.undo();
    },
  };
}
