import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { foldDiff, lineDiff } from './chat-model';

/**
 * `before` and `after` as a line diff, long unchanged runs folded, worked
 * out once for each pair; `after` whole when either is too long to diff.
 */
export function LineDiff({ before, after }: { before: string; after: string }) {
  const diff = useMemo(() => {
    const lines = lineDiff(before, after);
    return lines && foldDiff(lines);
  }, [before, after]);
  if (!diff) return <Text>{after}</Text>;
  return (
    <pre
      aria-label="Changes"
      className="max-h-64 overflow-auto rounded-control bg-muted p-2 font-mono text-xs whitespace-pre-wrap"
    >
      {diff.map((line, index) =>
        line.kind === 'fold' ? (
          <div key={index} className="text-muted-foreground">
            ⋯ {line.count} unchanged
          </div>
        ) : (
          <div
            key={index}
            className={cn(
              line.kind === 'added' && 'bg-status-published/30',
              line.kind === 'removed' && 'bg-destructive/15 line-through',
            )}
          >
            {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}
            {line.text}
          </div>
        ),
      )}
    </pre>
  );
}

/** Text as it is, in the diff's box. */
export function Text({ children }: { children: string }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-control bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
      {children}
    </pre>
  );
}
