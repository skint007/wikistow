import type { InstalledPlugin } from '@wikistow/contracts';
import type { Json, SettingField } from '@wikistow/plugin-sdk';
import { settingFits } from '@wikistow/plugin-sdk/manifest';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { FormMessage } from '@/components/layout/auth-card';
import { Input } from '@/components/ui/input';
import { Picker } from '@/components/ui/picker';
import { Switch } from '@/components/ui/switch';
import { useVault } from '../vault/store';
import { usePluginRuntime, usePlugins } from './runtime';

const message = (error: unknown) => (error instanceof Error ? error.message : 'It wasn’t saved.');

/**
 * The settings a plugin's manifest declares (`settings`, #310), drawn by
 * the app in the plugin's row on the Plugins page, whether or not it runs:
 * each field with its value or default, saved as it is committed (on blur
 * or Enter for text and numbers, at once for the rest).
 */
export function DeclaredSettings({ plugin }: { plugin: InstalledPlugin }) {
  const runtime = usePluginRuntime();
  // Drawn again as the settings change, here or from the plugin.
  usePlugins();
  const vault = useVault();
  const [error, setError] = useState<string | null>(null);
  const fields = plugin.manifest.settings ?? [];
  if (fields.length === 0) return null;
  if (vault.status !== 'unlocked') {
    return (
      <p className="text-sm text-muted-foreground">Unlock your vault to change its settings.</p>
    );
  }
  const values = runtime.settings(plugin);
  const save = (key: string, value: Json) => {
    setError(null);
    runtime.updateSettings(plugin, { [key]: value }).catch((failure: unknown) => {
      setError(message(failure));
    });
  };
  return (
    <section
      aria-label={`${plugin.manifest.name} settings`}
      className="grid gap-3 rounded-control bg-muted/50 p-3 text-sm"
    >
      {fields.map((field) => (
        <Setting
          key={field.key}
          field={field}
          value={values[field.key]}
          onSave={(value) => save(field.key, value)}
        />
      ))}
      {error && <FormMessage>{error}</FormMessage>}
    </section>
  );
}

function Setting({
  field,
  value,
  onSave,
}: {
  field: SettingField;
  value: Json | undefined;
  onSave: (value: Json) => void;
}) {
  const id = useId();
  const described = field.description ? `${id}-about` : undefined;
  const about = field.description && (
    <p id={described} className="text-muted-foreground">
      {field.description}
    </p>
  );
  const labelled = (control: ReactNode) => (
    <div className="grid gap-1">
      <label htmlFor={id} className="font-bold">
        {field.label}
      </label>
      {about}
      {control}
    </div>
  );
  switch (field.type) {
    case 'boolean':
      return (
        <div className="flex items-start gap-3">
          <div className="grid flex-1 gap-1">
            <label htmlFor={id} className="font-bold">
              {field.label}
            </label>
            {about}
          </div>
          <Switch
            id={id}
            aria-describedby={described}
            checked={value === true}
            onCheckedChange={(on) => onSave(on)}
          />
        </div>
      );
    case 'choice':
      return labelled(
        <Picker
          id={id}
          aria-describedby={described}
          label={field.label}
          className="w-auto min-w-48 justify-self-start"
          value={typeof value === 'string' ? value : null}
          options={field.options}
          onChange={(chosen) => onSave(chosen)}
        />,
      );
    case 'text':
    case 'number':
      return labelled(
        <TypedSetting id={id} described={described} field={field} value={value} onSave={onSave} />,
      );
  }
}

/** A text or number field, saved on blur or Enter when it changed and fits. */
function TypedSetting({
  id,
  described,
  field,
  value,
  onSave,
}: {
  id: string;
  described: string | undefined;
  field: Extract<SettingField, { type: 'text' | 'number' }>;
  value: Json | undefined;
  onSave: (value: Json) => void;
}) {
  const shown = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const [text, setText] = useState(shown);
  const [wrong, setWrong] = useState(false);
  // What is typed starts again from the value whenever it changes, here or elsewhere.
  useEffect(() => setText(shown), [shown]);
  const number = field.type === 'number';
  const commit = () => {
    if (text === shown) return setWrong(false);
    const next = number ? Number(text) : text;
    const fits = (!number || text.trim() !== '') && settingFits(field, next);
    setWrong(!fits);
    if (fits) onSave(next);
  };
  const range =
    field.type === 'number' && (field.min !== undefined || field.max !== undefined)
      ? [
          field.min !== undefined && `from ${field.min}`,
          field.max !== undefined && `to ${field.max}`,
        ]
          .filter(Boolean)
          .join(' ')
      : null;
  return (
    <>
      <Input
        id={id}
        aria-describedby={described}
        aria-invalid={wrong}
        className="w-auto min-w-48 justify-self-start"
        inputMode={number ? 'decimal' : undefined}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
      />
      {wrong && (
        <p role="alert" className="text-destructive">
          {range ? `Enter a number ${range}.` : 'Enter a number.'}
        </p>
      )}
    </>
  );
}
