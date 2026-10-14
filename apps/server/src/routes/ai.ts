import { aiRoutes } from '@wikistow/contracts';
import { providerEvents, providerRequest } from '../ai/provider.ts';
import type { AiConfig } from '../config.ts';
import { ApiError } from '../http/errors.ts';
import type { Log } from '../http/logger.ts';
import type { Routes } from '../http/mount.ts';

/** The longest one provider request may take, start to finish. */
const REQUEST_DEADLINE_MS = 10 * 60_000;
/** The connection check asks for a few tokens, and gives up sooner. */
const CHECK_TOKENS = 16;
const CHECK_DEADLINE_MS = 30_000;

/**
 * The AI proxy (`aiRoutes`). The server adds the key and forwards; it never
 * runs a tool, keeps a prompt or answer, or logs either. Only failure codes
 * are logged. Each request, a tool step included, counts toward the
 * account's AI rate limit.
 */
export function mountAiRoutes(routes: Routes, { ai, log }: { ai: AiConfig | null; log: Log }) {
  const off = () => new ApiError('ai-off', 'AI is not set up on this server');
  const limits = ai ? { rateLimit: { windowSeconds: 60, max: ai.requestsPerMinute } } : {};

  routes.account(aiRoutes.status, () =>
    ai
      ? {
          enabled: true as const,
          style: ai.style,
          host: new URL(ai.baseUrl).host,
          model: ai.model,
          maxOutputTokens: ai.maxOutputTokens,
        }
      : { enabled: false as const },
  );

  routes.account(
    aiRoutes.check,
    async (_input, { c }) => {
      if (!ai) throw off();
      const request = { messages: [{ role: 'user' as const, text: 'Reply with OK.' }], tools: [] };
      const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(CHECK_DEADLINE_MS)]);
      for await (const event of forward(ai, request, { signal, log, maxTokens: CHECK_TOKENS })) {
        if (event.type === 'error')
          return { ok: false as const, code: event.code, detail: event.detail };
        if (event.type === 'finish') break;
      }
      return { ok: true as const };
    },
    limits,
  );

  routes.stream(
    aiRoutes.stream,
    (body, { signal }) => {
      if (!ai) throw off();
      return forward(ai, body, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_DEADLINE_MS)]),
        log,
      });
    },
    limits,
  );
}

/**
 * Send `request` to the provider and yield its answer as events. A client
 * that leaves (`signal`) ends the provider's request with it.
 */
async function* forward(
  ai: AiConfig,
  request: aiRoutes.AiRequest,
  { signal, log, maxTokens }: { signal: AbortSignal; log: Log; maxTokens?: number },
): AsyncGenerator<aiRoutes.AiEvent> {
  const { url, init } = providerRequest(ai, request, maxTokens);
  const failed = (code: aiRoutes.AiProviderFailure, status?: number) =>
    log({ level: 'warn', event: 'ai-provider-failed', code, status });
  let response: Response;
  try {
    // A redirect could carry the key elsewhere, so none is followed.
    response = await fetch(url, { ...init, signal, redirect: 'error' });
  } catch {
    if (signal.aborted && !timedOut(signal)) return;
    failed('unavailable');
    yield { type: 'error', code: 'unavailable' };
    return;
  }
  try {
    for await (const event of providerEvents(ai, response)) {
      if (event.type === 'error') failed(event.code, response.status);
      yield event;
    }
  } catch {
    if (signal.aborted && !timedOut(signal)) return;
    failed('unavailable', response.status);
    yield { type: 'error', code: 'unavailable', detail: 'The answer broke off.' };
  }
}

const timedOut = (signal: AbortSignal) =>
  signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError';
