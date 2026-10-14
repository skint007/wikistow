import { lazy, Suspense, useState, type ComponentType } from 'react';
import type { EditorSurfaceProps } from './surface';

// CodeMirror is a large download only editors need, so it loads with the
// first draft opened rather than with the app. Once loaded, it's shown at
// once, with no wait for a key to land in.
let loaded: ComponentType<EditorSurfaceProps> | null = null;
const load = () =>
  import('./source/codemirror').then((module) => {
    loaded = module.default;
    return module;
  });
const CodeMirrorSurface = lazy(load);

/** Load the source editor ahead, so turning to it takes no wait. */
export const preloadSourceEditor = () => void load();

/** The page's Markdown source, editable once the editor has loaded and shown as it is until then. */
export function SourceEditor(props: EditorSurfaceProps) {
  // Which, as it's first shown: changing it would make the editor anew.
  const [Ready] = useState(() => loaded);
  if (Ready) return <Ready {...props} />;
  return (
    <Suspense
      fallback={
        <textarea
          readOnly
          aria-label="Page source (loading)"
          aria-busy
          value={props.initial}
          className="h-full w-full resize-none rounded-control border border-input bg-background p-4 font-mono text-sm leading-relaxed text-muted-foreground outline-none"
        />
      }
    >
      <CodeMirrorSurface {...props} />
    </Suspense>
  );
}
