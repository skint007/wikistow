import { z } from 'zod';
import type { AiConfig } from '../config.ts';

/** The most models listed, and how long fetching them may take in all. */
const MAX_MODELS = 2000;
const DEADLINE_MS = 10_000;

// What each style's list answers, kept loose: only the fields used here.
const OpenAiList = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string().optional() })),
});
const AnthropicPage = z.object({
  data: z.array(z.object({ id: z.string(), display_name: z.string().optional() })),
  has_more: z.boolean().optional(),
  last_id: z.string().nullable().optional(),
});

type Model = { id: string; name: string | null };
type Listing = { ok: true; models: Model[] } | { ok: false; reason: string };

/**
 * The provider's models, sorted by ID: OpenAI style `GET {baseUrl}/models`
 * (OpenRouter adds a `name`), Anthropic style `GET {baseUrl}/v1/models`
 * page by page, with `display_name`. Up to 2,000, within 10 seconds. A
 * failure says why in words for the admin page, never quoting the key.
 */
export async function listModels(
  ai: Pick<AiConfig, 'style' | 'baseUrl' | 'apiKey'>,
  signal: AbortSignal,
): Promise<Listing> {
  const host = new URL(ai.baseUrl).host;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS)]);
  const headers: Record<string, string> =
    ai.style === 'openai'
      ? ai.apiKey === undefined
        ? {}
        : { authorization: `Bearer ${ai.apiKey}` }
      : {
          'anthropic-version': '2023-06-01',
          ...(ai.apiKey !== undefined && { 'x-api-key': ai.apiKey }),
        };
  const models: Model[] = [];
  let after: string | null = null;
  try {
    do {
      const url =
        ai.style === 'openai'
          ? `${ai.baseUrl}/models`
          : `${ai.baseUrl}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
      // A redirect could carry the key elsewhere, so none is followed.
      const res = await fetch(url, { headers, signal: deadline, redirect: 'error' });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: 'The provider refused the key.' };
      }
      if (res.status === 404) {
        return { ok: false, reason: `${host} has no list of models there. Check the base URL.` };
      }
      if (!res.ok) {
        return { ok: false, reason: `${host} answered ${res.status} for its list of models.` };
      }
      const body: unknown = await res.json().catch(() => undefined);
      if (ai.style === 'openai') {
        const list = OpenAiList.safeParse(body);
        if (!list.success) return notAList(host);
        models.push(...list.data.data.map(({ id, name }) => ({ id, name: name ?? null })));
        after = null;
      } else {
        const page = AnthropicPage.safeParse(body);
        if (!page.success) return notAList(host);
        models.push(
          ...page.data.data.map(({ id, display_name }) => ({ id, name: display_name ?? null })),
        );
        after = page.data.has_more && page.data.last_id ? page.data.last_id : null;
      }
    } while (after !== null && models.length < MAX_MODELS);
  } catch {
    if (signal.aborted) return { ok: false, reason: 'The request was cancelled.' };
    return deadline.aborted
      ? { ok: false, reason: `${host} didn’t answer within 10 seconds.` }
      : { ok: false, reason: `Couldn’t reach ${host}.` };
  }
  const unique = new Map(models.map((model) => [model.id, model]));
  return {
    ok: true,
    models: [...unique.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, MAX_MODELS),
  };
}

const notAList = (host: string): Listing => ({
  ok: false,
  reason: `${host} didn’t answer with a list of models. Check the base URL.`,
});
