import { Button } from '@/components/ui/button';
import { propertiesText, withProperties } from './properties';

const BOX = 'rounded-control bg-muted text-sm';
const SUMMARY =
  'cursor-pointer rounded-control px-3 py-2 font-bold text-subtle-foreground select-none hover:tint active:tint-strong';

/**
 * A page's frontmatter above its body, read-only: a collapsed Properties
 * box that opens to the text between the delimiters, exactly as written.
 * WikiStow gives none of it meaning. It sits in the body, not among the
 * `pagePanels`, which open from the toolbar.
 */
export function PropertiesBox({ frontmatter }: { frontmatter: string }) {
  return (
    <details className={BOX}>
      <summary className={SUMMARY}>Properties</summary>
      <pre className="overflow-x-auto px-3 pb-3 font-mono text-[13px] leading-relaxed">
        {propertiesText(frontmatter)}
      </pre>
    </details>
  );
}

/**
 * The draft's frontmatter, editable as plain text: what's typed goes
 * between the delimiters, and the rest of the block stays as written.
 */
export function PropertiesEditor({
  frontmatter,
  open,
  onOpenChange,
  onChange,
  onRemove,
}: {
  frontmatter: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (frontmatter: string) => void;
  onRemove: () => void;
}) {
  const text = propertiesText(frontmatter);
  const ends = text.split('\n').some((line) => /^(?:---|\.\.\.)\r?$/.test(line));
  return (
    <details
      className={BOX}
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
    >
      <summary className={SUMMARY}>Properties</summary>
      <div className="grid gap-2 px-3 pb-3">
        <textarea
          aria-label="Properties"
          value={text}
          rows={Math.max(3, text.split('\n').length + 1)}
          spellCheck={false}
          onChange={(event) => onChange(withProperties(frontmatter, event.target.value))}
          className="w-full resize-y rounded-control border border-input bg-background px-3 py-2 font-mono text-[13px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {ends && (
          <p className="text-xs text-muted-foreground">
            A line of only --- or ... ends the properties. What follows it is part of the page.
          </p>
        )}
        <div>
          <Button size="sm" variant="outline" onClick={onRemove}>
            Remove properties
          </Button>
        </div>
      </div>
    </details>
  );
}
