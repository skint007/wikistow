import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
import { Code, Workflow } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore, type ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { PLAIN } from '../vault/store';
import { CopyCode } from './copy-code';
import { DiagramError, diagramUrl, drawDiagram } from './diagrams';

// Whether the palette shown is a dark one, as its `color-scheme` says,
// read again whenever the theme changes.
const watchTheme = (change: () => void) => {
  const observer = new MutationObserver(change);
  observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
};
const isDark = () => getComputedStyle(document.documentElement).colorScheme === 'dark';
const useDark = () => useSyncExternalStore(watchTheme, isDark);

/**
 * A diagram as drawn for this palette, kept as the page's body is, and
 * dropped with the decrypted queries when the vault locks. One that changes
 * where it's shown, as in the editor, shows as it was until drawn again.
 */
const diagramQuery = (source: string, dark: boolean) =>
  queryOptions({
    queryKey: [PLAIN, 'diagram', dark, source],
    queryFn: () => drawDiagram(source, dark),
    staleTime: 'static',
    networkMode: 'always',
    retry: false,
    placeholderData: keepPreviousData,
  });

/**
 * Why a diagram didn't draw, as a reader is told: Mermaid's first line,
 * and for a syntax error its last, which says what it expected.
 */
function failure(error: Error) {
  const lines = error instanceof DiagramError ? error.message.trim().split('\n') : [];
  const last = lines.length > 1 ? lines.at(-1) : undefined;
  const reason = [lines[0], last?.startsWith('Expecting') && last].filter(Boolean).join(' ');
  return `This diagram couldn’t be drawn. ${reason}`.trim();
}

/**
 * The diagram `svg` as an image, which runs nothing in it. Not draggable:
 * dropped in the visual editor, it would become an image of its `blob:`
 * address, gone once the page is reloaded.
 */
function DiagramImage({ svg }: { svg: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const made = diagramUrl(svg);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [svg]);
  return url && <img src={url} alt="Diagram" draggable={false} className="max-w-full" />;
}

/**
 * A `mermaid` code block in the reader (ADR 0010): its diagram, under a
 * label with buttons to see its source instead and to copy it. One that
 * doesn't draw shows its source and why.
 */
export function DiagramBlock({ source, pre }: { source: string; pre: ComponentProps<'pre'> }) {
  const [written, setWritten] = useState(false);
  const drawn = useQuery(diagramQuery(source, useDark()));
  const error = drawn.error && failure(drawn.error);
  return (
    <div className="code-block">
      <div className="code-language flex items-center gap-2 pt-1 pr-1">
        <span className="min-w-0 flex-1">mermaid</span>
        {!error && (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={written ? 'Show diagram' : 'Show source'}
            data-hint={written ? 'Show diagram' : 'Show source'}
            onClick={() => setWritten(!written)}
          >
            {written ? <Workflow strokeWidth={1.75} /> : <Code strokeWidth={1.75} />}
          </Button>
        )}
        <CopyCode text={source} />
      </div>
      {written || error ? (
        <pre {...pre} />
      ) : (
        <div className="overflow-x-auto px-4 pt-1 pb-4">
          {drawn.data ? (
            <DiagramImage svg={drawn.data} />
          ) : (
            <p className="text-sm text-muted-foreground">Drawing diagram…</p>
          )}
        </div>
      )}
      {error && (
        <p role="note" className="px-4 pb-3 text-xs text-muted-foreground">
          {error}
        </p>
      )}
    </div>
  );
}

/** `value`, once it has stayed the same for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * A `mermaid` code block's diagram in the visual editor, under its code,
 * drawn again once typing in it pauses. While it doesn't draw, it says why.
 */
export function DiagramPreview({ source }: { source: string }) {
  const settled = useSettled(source, 400);
  const drawn = useQuery(diagramQuery(settled, useDark()));
  if (drawn.error) {
    return (
      <p role="note" className="px-4 pb-3 text-xs text-muted-foreground">
        {failure(drawn.error)}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto px-4 pb-4">
      {drawn.data ? (
        <DiagramImage svg={drawn.data} />
      ) : (
        <p className="text-sm text-muted-foreground">Drawing diagram…</p>
      )}
    </div>
  );
}
