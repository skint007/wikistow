import { useMutation, useQuery } from '@tanstack/react-query';
import { aiFailureMessage } from '@wikistow/client';
import { aiRoutes } from '@wikistow/contracts';
import { useId, useState } from 'react';
import { FormMessage } from '@/components/layout/auth-card';
import { Button } from '@/components/ui/button';
import { api } from '../api';
import { errorMessage } from '../errors';
import { SettingRow } from '../settings/rows';
import { aiStatusQuery } from './session';

const STYLE_LABELS: Record<aiRoutes.AiStyle, string> = {
  openai: 'OpenAI-compatible API',
  anthropic: 'Anthropic Messages API',
};

/**
 * Where a conversation goes and how long it lasts, for anyone about to
 * send one. `host` is the provider's, from `aiStatusQuery`.
 */
export function AiDisclosure({ host }: { host: string }) {
  return (
    <div className="grid gap-1.5 text-sm text-muted-foreground">
      <p>
        When you use the assistant, your messages, any page you include, and the pages it reads in
        its folders go through your WikiStow server to the AI provider at{' '}
        <strong className="text-foreground">{host}</strong>. The server passes them on without
        keeping them.
      </p>
      <p>
        A conversation is kept only in this tab or app window. Reloading or closing it, starting a
        new conversation, locking your vault, or signing out loses it.
      </p>
    </div>
  );
}

/**
 * Settings' AI assistant row: the server's AI provider, model and host, a
 * connection check, and Where it goes, which shows the disclosure in place.
 */
export function AiSettings() {
  const { data, error } = useQuery(aiStatusQuery);
  const check = useMutation({ mutationFn: () => api.call(aiRoutes.check) });
  const [disclosed, setDisclosed] = useState(false);
  const disclosure = useId();

  if (error)
    return (
      <SettingRow name="AI assistant" state={<FormMessage>{errorMessage(error)}</FormMessage>} />
    );
  if (!data) return null;
  if (!data.enabled) {
    return (
      <SettingRow
        name="Not set up"
        state="AI isn’t set up on this server, so there’s no assistant. The person who runs the server can connect an AI provider."
      />
    );
  }
  return (
    <SettingRow
      name={STYLE_LABELS[data.style]}
      state={
        <>
          <span className="font-mono">{data.model}</span> at {data.host}, replies up to{' '}
          {data.maxOutputTokens.toLocaleString()} tokens
        </>
      }
      action={
        <>
          {check.isPending && <span className="text-sm text-muted-foreground">Checking…</span>}
          {check.data?.ok && !check.isPending && (
            <span
              role="status"
              className="rounded-full bg-status-published px-2.5 py-[3px] text-[12.5px] font-bold text-status-published-foreground"
            >
              ✓ Connected
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={check.isPending}
            onClick={() => check.mutate()}
          >
            Check connection
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={disclosed}
            aria-controls={disclosed ? disclosure : undefined}
            onClick={() => setDisclosed(!disclosed)}
          >
            Where it goes
          </Button>
        </>
      }
    >
      {check.data && !check.data.ok && !check.isPending && (
        <FormMessage>{aiFailureMessage(check.data.code, check.data.detail)}</FormMessage>
      )}
      {check.error && <FormMessage>{errorMessage(check.error)}</FormMessage>}
      {disclosed && (
        <div id={disclosure}>
          <AiDisclosure host={data.host} />
        </div>
      )}
    </SettingRow>
  );
}
