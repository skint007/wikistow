import { useMutation, useQuery } from '@tanstack/react-query';
import { aiFailureMessage } from '@wikistow/client';
import { aiRoutes } from '@wikistow/contracts';
import { FormMessage } from '@/components/layout/auth-card';
import { Button } from '@/components/ui/button';
import { api } from '../api';
import { errorMessage } from '../errors';
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

/** The server's AI provider and model, the disclosure, and a connection check. */
export function AiSettings() {
  const { data, error } = useQuery(aiStatusQuery);
  const check = useMutation({ mutationFn: () => api.call(aiRoutes.check) });

  if (error) return <FormMessage>{errorMessage(error)}</FormMessage>;
  if (!data) return null;
  if (!data.enabled) {
    return (
      <p className="text-sm text-muted-foreground">
        AI isn’t set up on this server, so there’s no assistant. The person who runs the server can
        connect an AI provider.
      </p>
    );
  }
  return (
    <div className="grid gap-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Provider</dt>
        <dd>
          {STYLE_LABELS[data.style]} at {data.host}
        </dd>
        <dt className="text-muted-foreground">Model</dt>
        <dd className="font-mono">{data.model}</dd>
        <dt className="text-muted-foreground">Longest reply</dt>
        <dd>{data.maxOutputTokens.toLocaleString()} tokens</dd>
      </dl>
      <AiDisclosure host={data.host} />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={check.isPending}
          onClick={() => check.mutate()}
        >
          Check connection
        </Button>
        {check.isPending && <span className="text-sm text-muted-foreground">Checking…</span>}
        {check.data?.ok && !check.isPending && (
          <span
            role="status"
            className="rounded-full bg-status-published px-2.5 py-[3px] text-[12.5px] font-bold text-status-published-foreground"
          >
            ✓ Connected
          </span>
        )}
      </div>
      {check.data && !check.data.ok && !check.isPending && (
        <FormMessage>{aiFailureMessage(check.data.code, check.data.detail)}</FormMessage>
      )}
      {check.error && <FormMessage>{errorMessage(check.error)}</FormMessage>}
    </div>
  );
}
