// Fields of the admin settings cards, where a setting may come from the
// server's environment and a secret is write-only.
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** A saved secret stays unless it's replaced or removed. */
export type Secret = { kind: 'keep' } | { kind: 'remove' } | { kind: 'enter'; value: string };

/** A secret field's start: Saved if one is, else empty. */
export const secretFrom = (saved: boolean): Secret =>
  saved ? { kind: 'keep' } : { kind: 'enter', value: '' };

/** What a form sends for a secret: null removes it, undefined keeps what is saved. */
export function secretValue(secret: Secret): string | null | undefined {
  if (secret.kind === 'remove') return null;
  return secret.kind === 'enter' && secret.value !== '' ? secret.value : undefined;
}

/** A setting the server's environment makes, which this page can't change. */
export function FromEnvironment({ label, variable }: { label: string; variable: string }) {
  return (
    <div className="grid gap-2">
      <span className="text-sm leading-none font-medium">{label}</span>
      <p className="text-sm text-muted-foreground">
        Set in the server’s environment (<code>{variable}</code>)
      </p>
    </div>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  error,
  ...input
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  placeholder?: string;
  autoComplete?: string;
  inputMode?: 'numeric';
}) {
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        {...input}
      />
      {error && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Write-only: a saved secret shows as Saved, with Replace and Remove. */
export function SecretField({
  id,
  label,
  saved,
  value,
  onChange,
}: {
  id: string;
  label: string;
  saved: boolean;
  value: Secret;
  onChange: (value: Secret) => void;
}) {
  if (value.kind === 'enter') {
    return (
      <div className="grid gap-2">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex gap-2">
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            value={value.value}
            onChange={(event) => onChange({ kind: 'enter', value: event.target.value })}
          />
          {saved && (
            <Button type="button" variant="ghost" onClick={() => onChange({ kind: 'keep' })}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <span className="text-sm leading-none font-medium">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">
          {value.kind === 'keep' ? 'Saved' : 'Removed when you save'}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange({ kind: 'enter', value: '' })}
        >
          Replace
        </Button>
        {value.kind === 'keep' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange({ kind: 'remove' })}
          >
            Remove
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange({ kind: 'keep' })}
          >
            Keep
          </Button>
        )}
      </div>
    </div>
  );
}
