import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { adminRoutes, type aiRoutes } from '@wikistow/contracts';
import { RefreshCw } from 'lucide-react';
import { useId, useRef, useState, type ReactNode } from 'react';
import type { z } from 'zod';
import { FormMessage } from '@/components/layout/auth-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
import { Picker, type PickerOption } from '@/components/ui/picker';
import { api } from '../api';
import { useReauth } from '../auth/reauth';
import { errorMessage } from '../errors';
import {
  FromEnvironment,
  SecretField,
  secretFrom,
  secretValue,
  TextField,
  type Secret,
} from './fields';

type Ai = z.output<typeof adminRoutes.AdminAiSettings>;
type Field = Ai['environment'][number];

export const aiSettingsQuery = queryOptions({
  queryKey: ['admin', 'ai-settings'],
  queryFn: () => api.call(adminRoutes.getAiSettings),
});

const STYLES: readonly PickerOption<aiRoutes.AiStyle>[] = [
  { value: 'openai', label: 'OpenAI-compatible' },
  { value: 'anthropic', label: 'Anthropic' },
];

const BASE_URLS: Record<aiRoutes.AiStyle, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

const VARIABLES: Record<Field, string> = {
  style: 'AI_API_STYLE',
  baseUrl: 'AI_BASE_URL',
  apiKey: 'AI_API_KEY',
  model: 'AI_MODEL',
  maxOutputTokens: 'AI_MAX_OUTPUT_TOKENS',
  requestsPerMinute: 'AI_REQUESTS_PER_MINUTE',
};

/** A failed check in an administrator's words, with the provider's own if it gave any. */
function checkFailure(code: aiRoutes.AiProviderFailure, detail: string | undefined) {
  const said = detail ? ` The provider said: “${detail}”` : '';
  switch (code) {
    case 'key-rejected':
      return `The provider refused the key.${said}`;
    case 'model-unknown':
      return `The provider doesn’t offer that model.${said}`;
    case 'rate-limited':
      return `The provider is busy or limiting requests. Try again in a minute.${said}`;
    case 'unavailable':
      return `Couldn’t get an answer from the provider. Check the base URL.${said}`;
    case 'too-long':
    case 'failed':
      return `The provider couldn’t answer.${said}`;
  }
}

/** A whole number of at least 1, null when empty, or undefined when it isn't one. */
function count(text: string): number | null | undefined {
  if (text.trim() === '') return null;
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 && value <= 1_000_000 ? value : undefined;
}

/**
 * The AI provider people's assistants use. Fields an `AI_*` variable sets
 * are read-only; the key is write-only. The model field lists the
 * provider's models, fetched by the server with the form's style, base URL
 * and key, once it's focused or on Refresh; any name can still be typed.
 * Save and Check connection use what the form holds now.
 */
export function AiSettingsCard({ ai }: { ai: Ai }) {
  const id = useId();
  const queryClient = useQueryClient();
  const withReauth = useReauth();
  const fixed = (field: Field) => ai.environment.includes(field);
  const [style, setStyle] = useState(ai.style);
  const [baseUrl, setBaseUrl] = useState(ai.baseUrl ?? '');
  const [apiKey, setApiKey] = useState<Secret>(secretFrom(ai.apiKeySaved));
  const [model, setModel] = useState(ai.model ?? '');
  const [maxOutputTokens, setMaxOutputTokens] = useState(String(ai.maxOutputTokens ?? ''));
  const [requestsPerMinute, setRequestsPerMinute] = useState(String(ai.requestsPerMinute ?? ''));
  const [message, setMessage] = useState<{ tone: 'error' | 'notice'; text: ReactNode } | null>(
    null,
  );

  const urlInvalid = baseUrl.trim() !== '' && !/^https?:\/\/[^\s/]+/i.test(baseUrl.trim());
  const tokens = count(maxOutputTokens);
  const perMinute = count(requestsPerMinute);
  const invalid = urlInvalid || tokens === undefined || perMinute === undefined;

  /** The form's values; the server ignores fields the environment sets. */
  const form = () => ({
    style,
    baseUrl: baseUrl.trim() || null,
    apiKey: secretValue(apiKey),
    model: model.trim() || null,
    maxOutputTokens: tokens,
    requestsPerMinute: perMinute,
  });

  const models = useMutation({
    mutationFn: (body: z.input<typeof adminRoutes.listAiModels.body>) =>
      withReauth(() => api.call(adminRoutes.listAiModels, { body })),
  });
  // What the list shown was fetched for, so focusing again doesn't refetch it.
  const listedFor = useRef<string | null>(null);
  const canList = (fixed('style') || style !== null) && (fixed('baseUrl') || baseUrl.trim() !== '');
  function listModels(again = false) {
    if (!canList || urlInvalid) return;
    const { style, baseUrl, apiKey } = form();
    const body = { style, baseUrl, apiKey };
    const key = JSON.stringify(body);
    if (!again && key === listedFor.current) return;
    listedFor.current = key;
    models.mutate(body);
  }
  const listing = models.data;
  const modelStatus = models.isPending ? (
    'Getting the provider’s models…'
  ) : listing && !listing.ok ? (
    <span className="text-destructive">{listing.reason} You can still type a model’s name.</span>
  ) : models.error ? (
    <span className="text-destructive">{errorMessage(models.error)}</span>
  ) : !canList ? (
    'Choose the API style and base URL to list the provider’s models.'
  ) : null;

  const save = useMutation({
    mutationFn: () => withReauth(() => api.call(adminRoutes.updateAiSettings, { body: form() })),
    onMutate: () => setMessage(null),
    onSuccess: (saved) => {
      queryClient.setQueryData(aiSettingsQuery.queryKey, saved);
      setApiKey(secretFrom(saved.apiKeySaved));
      setMessage({ tone: 'notice', text: 'Saved.' });
    },
    onError: (caught) => setMessage({ tone: 'error', text: errorMessage(caught) }),
  });
  const check = useMutation({
    mutationFn: () => withReauth(() => api.call(adminRoutes.checkAi, { body: form() })),
    onMutate: () => setMessage(null),
    onSuccess: (result) =>
      setMessage(
        result.ok
          ? { tone: 'notice', text: 'Connected. The provider answered with this model.' }
          : { tone: 'error', text: checkFailure(result.code, result.detail) },
      ),
    onError: (caught) => setMessage({ tone: 'error', text: errorMessage(caught) }),
  });
  const busy = save.isPending || check.isPending;

  return (
    <Card className="rounded-card shadow-card">
      <CardHeader>
        <CardTitle className="text-lg font-extrabold">AI assistant</CardTitle>
        <CardDescription>
          {ai.enabled
            ? 'People’s assistants use this provider. What they send goes through this server to it, with the key added here.'
            : 'AI is off. Choose the API style and fill in the base URL and model to turn it on.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid max-w-md gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!invalid) save.mutate();
          }}
        >
          {fixed('style') ? (
            <FromEnvironment label="API style" variable={VARIABLES.style} />
          ) : (
            <div className="grid gap-2">
              <Label htmlFor={`${id}-style`}>API style</Label>
              <Picker
                id={`${id}-style`}
                label="API style"
                value={style}
                options={STYLES}
                onChange={setStyle}
              />
            </div>
          )}
          {fixed('baseUrl') ? (
            <FromEnvironment label="Base URL" variable={VARIABLES.baseUrl} />
          ) : (
            <TextField
              id={`${id}-base-url`}
              label="Base URL"
              value={baseUrl}
              onChange={setBaseUrl}
              placeholder={BASE_URLS[style ?? 'openai']}
              autoComplete="off"
              error={urlInvalid ? 'Use an address starting with http:// or https://' : undefined}
            />
          )}
          {fixed('apiKey') ? (
            <FromEnvironment label="API key" variable={VARIABLES.apiKey} />
          ) : (
            <SecretField
              id={`${id}-api-key`}
              label="API key"
              saved={ai.apiKeySaved}
              value={apiKey}
              onChange={setApiKey}
            />
          )}
          {fixed('model') ? (
            <FromEnvironment label="Model" variable={VARIABLES.model} />
          ) : (
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={`${id}-model`}>Model</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={!canList || urlInvalid || models.isPending}
                  onClick={() => listModels(true)}
                >
                  <RefreshCw aria-hidden />
                  Refresh
                </Button>
              </div>
              <Combobox
                id={`${id}-model`}
                value={model}
                onChange={setModel}
                options={
                  listing?.ok
                    ? listing.models.map(({ id, name }) => ({ value: id, label: name }))
                    : undefined
                }
                onFocus={() => listModels()}
                noun="models"
                status={
                  <p className="text-sm text-muted-foreground">
                    {modelStatus ?? 'The model must support tool calls.'}
                  </p>
                }
              />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            {fixed('maxOutputTokens') ? (
              <FromEnvironment label="Longest reply" variable={VARIABLES.maxOutputTokens} />
            ) : (
              <TextField
                id={`${id}-tokens`}
                label="Longest reply, in tokens"
                value={maxOutputTokens}
                onChange={setMaxOutputTokens}
                placeholder="4096"
                inputMode="numeric"
                error={tokens === undefined ? 'Use a whole number' : undefined}
              />
            )}
            {fixed('requestsPerMinute') ? (
              <FromEnvironment label="Requests a minute" variable={VARIABLES.requestsPerMinute} />
            ) : (
              <TextField
                id={`${id}-per-minute`}
                label="Requests a minute per person"
                value={requestsPerMinute}
                onChange={setRequestsPerMinute}
                placeholder="30"
                inputMode="numeric"
                error={perMinute === undefined ? 'Use a whole number' : undefined}
              />
            )}
          </div>
          {message && <FormMessage tone={message.tone}>{message.text}</FormMessage>}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              disabled={busy || ai.environment.length === adminRoutes.AiField.options.length}
            >
              Save
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || invalid}
              onClick={() => check.mutate()}
            >
              Check connection
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
