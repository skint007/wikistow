import type { View } from '@wikistow/plugin-sdk';
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { updateInPlace } from './in-place';
import { usePluginRuntime } from './runtime';

/**
 * A plugin's view, drawn into an element this app owns: the plugin gets the
 * element and `props`, never the app's own React tree. If drawing it
 * throws, its place says so, with Disable. Give `props` a stable identity:
 * a new one draws it afresh. A view the app draws itself takes `live`, its
 * props now, in place (`updateInPlace`).
 */
export function PluginView<Props>({
  pluginId,
  name,
  view,
  props,
  live,
}: {
  pluginId: string;
  /** The plugin's name, for the failure note. */
  name: string;
  view: View<Props>;
  props: Props;
  live?: Props | undefined;
}) {
  const host = useRef<HTMLDivElement>(null);
  const runtime = usePluginRuntime();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let undo: (() => void) | void;
    try {
      undo = view(element, props);
    } catch (error) {
      setFailed(true);
      runtime.viewFailed(pluginId, error);
    }
    return () => {
      try {
        undo?.();
      } catch {
        // Its own cleanup failing leaves nothing of the app's behind.
      }
      element.replaceChildren();
    };
  }, [view, props, runtime, pluginId]);
  useEffect(() => {
    if (live !== undefined && host.current) updateInPlace(host.current, live);
  }, [live]);
  if (failed) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-2">
          {name} failed here.
          <Button size="sm" variant="outline" onClick={() => void runtime.disable(pluginId)}>
            Disable
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return <div ref={host} data-plugin-view={pluginId} className="contents" />;
}
