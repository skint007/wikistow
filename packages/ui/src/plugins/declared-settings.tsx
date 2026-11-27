import type { InstalledPlugin } from '@wikistow/contracts';
import type { Json, SettingField } from '@wikistow/plugin-sdk';
import { settingFits } from '@wikistow/plugin-sdk/manifest';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { FormMessage } from '@/components/layout/auth-card';
import { Input } from '@/components/ui/input';
import { Picker } from '@/components/ui/picker';
import { Switch } from '@/components/ui/switch';
import { useVault } from '../vault/store';
import { usePluginRuntime, usePlugins } from './runtime';

const message = (error: unknown) => (error instanceof Error ? error.message : 'It wasn’t saved.');

/** Why each field's newest save failed, by its key. */
export type SaveFailures = Readonly<Record<string, string>>;

/** The newest save of each plugin's field (`<id>\n<key>`), so only it says how it went. */
const newest = new Map<string, number>();

/**
 * The settings a plugin's manifest declares (`settings`, #310), drawn by
 * the app in the plugin's settings dialog on the Plugins page, whether or
 * not it runs:
 * each field with its value or default, saved as it is committed (on blur
 * or Enter for text and numbers, at once for the rest).
 */
export function DeclaredSettings({
  plugin,
  failed,
}: {
  plugin: InstalledPlugin;
  /**
   * Where why saves failed is kept, by whatever outlives these fields, as
   * a dialog's are taken away while a save they sent is on its way.
   */
  failed?: [SaveFailures, Dispatch<SetStateAction<SaveFailures>>];
}) {
  const runtime = usePluginRuntime();
  // Drawn again as the settings change, here or from the plugin.
  usePlugins();
  const vault = useVault();
  const own = useState<SaveFailures>({});
  const [errors, setErrors] = failed ?? own;
  const fields = plugin.manifest.settings ?? [];
  if (fields.length === 0) return null;
  if (vault.status !== 'unlocked') {
    return (
      <p className="text-sm text-muted-foreground">Unlock your vault to change its settings.</p>
    );
  }
  const values = runtime.settings(plugin);
  /**
   * Resolves whether it was saved. Only a field's newest save says so, as
   * an earlier one may settle after it.
   */
  const save = (key: string, value: Json) => {
    const at = `${plugin.manifest.id}\n${key}`;
    const mine = (newest.get(at) ?? 0) + 1;
    newest.set(at, mine);
    const settled = (error: string | null) => {
      if (newest.get(at) !== mine) return;
      setErrors((was) => {
        const next = { ...was };
        if (error) next[key] = error;
        else delete next[key];
        return next;
      });
    };
    return runtime.updateSettings(plugin, { [key]: value }).then(
      () => {
        settled(null);
        return true;
      },
      (failure: unknown) => {
        settled(message(failure));
        return false;
      },
    );
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
      {Object.entries(errors).map(([key, error]) => (
        <FormMessage key={key}>{error}</FormMessage>
      ))}
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
  onSave: (value: Json) => Promise<boolean>;
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
            onCheckedChange={(on) => void onSave(on)}
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
          onChange={(chosen) => void onSave(chosen)}
        />,
      );
    case 'text':
    case 'number':
      return labelled(
        <TypedSetting id={id} described={described} field={field} value={value} onSave={onSave} />,
      );
  }
}

/**
 * A text or number field, saved on blur or Enter when it changed and fits,
 * and as it goes, such as when its dialog closes, if what was typed wasn't
 * sent yet.
 */
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
  onSave: (value: Json) => Promise<boolean>;
}) {
  const shown = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const [text, setText] = useState(shown);
  const [wrong, setWrong] = useState(false);
  // What was last sent and not refused, so it isn't sent again, by a blur
  // after Enter or by going, before it comes back as `shown`.
  const sent = useRef<string | null>(null);
  const was = useRef(shown);
  const number = field.type === 'number';
  /** Whether two texts give the same value: `7.0` is 7. */
  const same = (one: string, other: string) =>
    number ? one.trim() !== '' && Number(one) === Number(other) : one === other;
  // A new value, from here or elsewhere, replaces what is typed only if
  // nothing was typed since the value before, or it is what was typed: an
  // earlier save landing after the dialog closed and opened again leaves
  // what was typed since, and what was sent for it.
  useEffect(() => {
    if (was.current === shown) return;
    const untouched = was.current;
    setText((typed) => (typed === untouched || same(typed, shown) ? shown : typed));
    was.current = shown;
    if (sent.current !== null && same(sent.current, shown)) sent.current = null;
  }, [shown]);
  const commit = () => {
    if (text === shown) return setWrong(false);
    if (text === sent.current) return;
    const next = number ? Number(text) : text;
    const fits = (!number || text.trim() !== '') && settingFits(field, next);
    setWrong(!fits);
    if (!fits) return;
    sent.current = text;
    void onSave(next).then((saved) => {
      // Refused, it can be sent again.
      if (!saved && sent.current === text) sent.current = null;
    });
  };
  // Going, it commits what was typed unless that was sent: a browser may
  // blur a field it takes away, as Chromium does, or may not, as Firefox.
  const latest = useRef({ commit, text });
  latest.current = { commit, text };
  useEffect(
    () => () => {
      if (latest.current.text !== sent.current) latest.current.commit();
    },
    [],
  );
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
