import { lazy, Suspense } from 'react';
import type { VisualSurfaceProps } from './visual/visual-surface';

// Milkdown, like CodeMirror, is a download only editors need, and only
// those who turn to the visual editor: it loads the first time they do.
const load = () => import('./visual/visual-surface');
const VisualSurface = lazy(load);

/** Whether the visual editor keeps everything `body` says, and if not, why it stays in source mode. */
export const checkFidelity = async (body: string) => (await load()).checkFidelity(body);

/** The page body as the reader shows it, editable, once the visual editor has loaded. */
export function VisualEditor(props: VisualSurfaceProps) {
  return (
    <Suspense fallback={<BodyLoading text={props.initial} />}>
      <VisualSurface {...props} />
    </Suspense>
  );
}

/** The body as it is, while an editor for it loads. */
export function BodyLoading({ text }: { text: string }) {
  return (
    <textarea
      readOnly
      aria-label="Page (loading)"
      aria-busy
      value={text}
      className="h-full w-full resize-none rounded-control border border-input bg-background p-4 font-mono text-sm leading-relaxed text-muted-foreground outline-none"
    />
  );
}
