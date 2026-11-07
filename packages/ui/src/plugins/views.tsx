import type { View } from '@wikistow/plugin-sdk';
import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { PluginRuntime } from './runtime';
import { usePluginRuntime } from './runtime';

/**
 * Draw a plugin's view into `element`, an element this app owns: the
 * plugin gets the element and `props`, never the app's own React tree. If
 * drawing it throws, the runtime is told (`viewFailed`) and the element
 * says so instead, with Disable. Every plugin view the app draws, in a
 * region or for a block, fails this one way. A view drawn in place of the
 * app's own part (`fallBack`) also fails if it returns having drawn
 * nothing, and is undone and `fallBack` called instead of the note, so
 * the caller shows the app's own part with it (`FailedNote`). Returns
 * what undoes it, leaving the element empty.
 */
export function drawView<Props>(
  element: HTMLElement,
  {
    pluginId,
    name,
    view,
    props,
    runtime,
    fallBack,
  }: {
    pluginId: string;
    /** The plugin's name, for the failure note. */
    name: string;
    view: View<Props>;
    props: Props;
    runtime: Pick<PluginRuntime, 'viewFailed' | 'disable'>;
    /** For a view in place of the app's own part: called, in place of the note, if it fails. */
    fallBack?: (() => void) | undefined;
  },
): () => void {
  let undo: (() => void) | void;
  let note: ReturnType<typeof createRoot> | null = null;
  const undoView = () => {
    try {
      undo?.();
    } catch {
      // Its own cleanup failing leaves nothing of the app's behind.
    }
    undo = undefined;
    element.replaceChildren();
  };
  try {
    undo = view(element, props);
    // Drawn into the element, or into a shadow root it attached there.
    if (fallBack && !element.hasChildNodes() && !element.shadowRoot?.hasChildNodes())
      throw new Error('it drew nothing');
  } catch (error) {
    runtime.viewFailed(pluginId, error);
    if (fallBack) {
      undoView();
      fallBack();
    } else {
      // In a box of its own, so the element can be drawn into again at once.
      const box = document.createElement('div');
      element.replaceChildren(box);
      note = createRoot(box);
      note.render(<FailedNote name={name} disable={() => void runtime.disable(pluginId)} />);
    }
  }
  return () => {
    undoView();
    // Not while the caller may be rendering, which may be what removes it.
    const shown = note;
    if (shown) queueMicrotask(() => shown.unmount());
  };
}

/** Says a plugin's view failed where it is, with Disable. */
export function FailedNote({ name, disable }: { name: string; disable: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-wrap items-center gap-2">
        {name} failed here.
        <Button size="sm" variant="outline" onClick={disable}>
          Disable
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/**
 * A plugin's view in the app's React tree (`drawView`). Give `props` a
 * stable identity: a new one draws it afresh.
 */
export function PluginView<Props>({
  pluginId,
  name,
  view,
  props,
}: {
  pluginId: string;
  /** The plugin's name, for the failure note. */
  name: string;
  view: View<Props>;
  props: Props;
}) {
  const host = useRef<HTMLDivElement>(null);
  const runtime = usePluginRuntime();
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    return drawView(element, { pluginId, name, view, props, runtime });
  }, [view, props, runtime, pluginId, name]);
  return <div ref={host} data-plugin-view={pluginId} className="contents" />;
}
