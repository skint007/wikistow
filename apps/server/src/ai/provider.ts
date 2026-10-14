import { aiRoutes } from '@wikistow/contracts';
import type { AiConfig } from '../config.ts';

type AiRequest = aiRoutes.AiRequest;
type AiEvent = aiRoutes.AiEvent;
type AiToolCall = aiRoutes.AiToolCall;
type Failure = Extract<AiEvent, { type: 'error' }>;
type FinishReason = aiRoutes.AiFinishReason;

/** The longest provider explanation passed on to the client. */
const MAX_DETAIL = 400;

/**
 * The provider's HTTP request for a conversation, in the configured API
 * style, streaming, and capped at `maxTokens` (the configured output limit
 * unless lower). Follows each SDK's base URL: OpenAI's includes `/v1`,
 * Anthropic's doesn't.
 */
export function providerRequest(
  ai: AiConfig,
  request: AiRequest,
  maxTokens = ai.maxOutputTokens,
): { url: string; init: RequestInit } {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (ai.style === 'openai') {
    if (ai.apiKey !== undefined) headers['authorization'] = `Bearer ${ai.apiKey}`;
    return {
      url: `${ai.baseUrl}/chat/completions`,
      init: { method: 'POST', headers, body: JSON.stringify(openAiBody(ai, request, maxTokens)) },
    };
  }
  if (ai.apiKey !== undefined) headers['x-api-key'] = ai.apiKey;
  headers['anthropic-version'] = '2023-06-01';
  return {
    url: `${ai.baseUrl}/v1/messages`,
    init: { method: 'POST', headers, body: JSON.stringify(anthropicBody(ai, request, maxTokens)) },
  };
}

function openAiBody(ai: AiConfig, { system, messages, tools }: AiRequest, maxTokens: number) {
  const turns: unknown[] = system === undefined ? [] : [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'user') turns.push({ role: 'user', content: message.text });
    else if (message.role === 'assistant') {
      turns.push({
        role: 'assistant',
        content: message.text === '' ? null : message.text,
        ...(message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                // Arguments that weren't JSON go back as they came.
                function: {
                  name: call.name,
                  arguments:
                    typeof call.input === 'string' ? call.input : JSON.stringify(call.input),
                },
              })),
            }
          : {}),
      });
    } else {
      // Chat Completions has no error flag on a tool result.
      for (const result of message.results) {
        turns.push({
          role: 'tool',
          tool_call_id: result.callId,
          content: result.isError ? `Error: ${result.output}` : result.output,
        });
      }
    }
  }
  return {
    model: ai.model,
    stream: true,
    stream_options: { include_usage: true },
    // OpenAI's reasoning models refuse the older `max_tokens`; servers that
    // don't know this name ignore it.
    max_completion_tokens: maxTokens,
    messages: turns,
    ...(tools.length > 0
      ? {
          tools: tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }
      : {}),
  };
}

type AnthropicTurn = { role: 'user' | 'assistant'; content: unknown[] };

function anthropicBody(ai: AiConfig, { system, messages, tools }: AiRequest, maxTokens: number) {
  const turns: AnthropicTurn[] = [];
  // Messages alternates roles, so tool results and a following question (or
  // two questions, after a reply that was stopped before it began) share a turn.
  const add = (role: AnthropicTurn['role'], content: unknown[]) => {
    const last = turns.at(-1);
    if (last?.role === role) last.content.push(...content);
    else turns.push({ role, content });
  };
  for (const message of messages) {
    if (message.role === 'user') add('user', [{ type: 'text', text: message.text }]);
    else if (message.role === 'assistant') {
      add('assistant', [
        // Messages refuses a text block of only whitespace.
        ...(message.text.trim() === '' ? [] : [{ type: 'text', text: message.text }]),
        ...message.toolCalls.map((call) => ({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          // Messages takes only an object; the client already refused any other input.
          input: isRecord(call.input) ? call.input : {},
        })),
      ]);
    } else {
      add(
        'user',
        message.results.map((result) => ({
          type: 'tool_result',
          tool_use_id: result.callId,
          content: result.output,
          is_error: result.isError,
        })),
      );
    }
  }
  return {
    model: ai.model,
    stream: true,
    max_tokens: maxTokens,
    ...(system === undefined ? {} : { system }),
    messages: turns,
    ...(tools.length > 0
      ? {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        }
      : {}),
  };
}

/**
 * The provider's answer as `AiEvent`s, ending with `finish` or `error`. A
 * refusal (any status but 2xx) becomes one `error`.
 */
export async function* providerEvents(ai: AiConfig, response: Response): AsyncGenerator<AiEvent> {
  if (!response.ok) {
    yield refusal(ai, response.status, await response.text().catch(() => ''));
    return;
  }
  if (!response.body) {
    yield { type: 'error', code: 'unavailable' };
    return;
  }
  const events =
    ai.style === 'openai' ? openAiEvents(ai, response.body) : anthropicEvents(ai, response.body);
  let ended = false;
  for await (const event of events) {
    yield event;
    if (event.type === 'finish' || event.type === 'error') {
      ended = true;
      break;
    }
  }
  // The provider's stream broke off before saying it was done.
  if (!ended) yield { type: 'error', code: 'unavailable', detail: 'The answer broke off.' };
}

async function* openAiEvents(
  ai: AiConfig,
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<AiEvent> {
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let reason: string | null = null;
  let usage: Extract<AiEvent, { type: 'usage' }> | null = null;
  for await (const data of sseData(body)) {
    if (data === '[DONE]') break;
    const chunk = parseJson(data);
    if (!isRecord(chunk)) continue;
    if (isRecord(chunk['error'])) {
      yield streamFailure(ai, chunk['error']);
      return;
    }
    if (isRecord(chunk['usage'])) {
      usage = {
        type: 'usage',
        inputTokens: count(chunk['usage']['prompt_tokens']),
        outputTokens: count(chunk['usage']['completion_tokens']),
      };
    }
    const choice = Array.isArray(chunk['choices']) ? chunk['choices'][0] : undefined;
    if (!isRecord(choice)) continue;
    if (typeof choice['finish_reason'] === 'string') reason = choice['finish_reason'];
    const delta = choice['delta'];
    if (!isRecord(delta)) continue;
    if (typeof delta['content'] === 'string' && delta['content'] !== '') {
      yield { type: 'text', text: delta['content'] };
    }
    if (!Array.isArray(delta['tool_calls'])) continue;
    for (const part of delta['tool_calls']) {
      if (!isRecord(part)) continue;
      const index = typeof part['index'] === 'number' ? part['index'] : calls.size;
      const call = calls.get(index) ?? { id: '', name: '', args: '' };
      const fn = isRecord(part['function']) ? part['function'] : {};
      if (typeof part['id'] === 'string') call.id = part['id'];
      if (typeof fn['name'] === 'string') call.name += fn['name'];
      if (typeof fn['arguments'] === 'string') call.args += fn['arguments'];
      calls.set(index, call);
    }
  }
  if (reason === null) return;
  for (const [index, call] of [...calls].sort(([a], [b]) => a - b)) {
    yield { type: 'tool-call', call: toolCall(call.id || `call_${index}`, call.name, call.args) };
  }
  if (usage) yield usage;
  // Some compatible servers say `stop` even when they asked for tools.
  const finish: FinishReason =
    calls.size > 0
      ? 'tool-calls'
      : reason === 'stop'
        ? 'stop'
        : reason === 'length'
          ? 'length'
          : 'other';
  yield { type: 'finish', reason: finish };
}

async function* anthropicEvents(
  ai: AiConfig,
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<AiEvent> {
  const tools = new Map<number, { id: string; name: string; json: string }>();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let reason: string | null = null;
  for await (const data of sseData(body)) {
    const event = parseJson(data);
    if (!isRecord(event)) continue;
    const index = typeof event['index'] === 'number' ? event['index'] : -1;
    switch (event['type']) {
      case 'message_start': {
        const message = isRecord(event['message']) ? event['message'] : {};
        const usage = isRecord(message['usage']) ? message['usage'] : {};
        inputTokens = count(usage['input_tokens']) ?? inputTokens;
        break;
      }
      case 'content_block_start': {
        const block = event['content_block'];
        if (!isRecord(block)) break;
        if (block['type'] === 'tool_use') {
          tools.set(index, {
            id: typeof block['id'] === 'string' ? block['id'] : `call_${index}`,
            name: typeof block['name'] === 'string' ? block['name'] : '',
            json: '',
          });
        } else if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text']) {
          yield { type: 'text', text: block['text'] };
        }
        break;
      }
      case 'content_block_delta': {
        const delta = event['delta'];
        if (!isRecord(delta)) break;
        if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
          yield { type: 'text', text: delta['text'] };
        } else if (
          delta['type'] === 'input_json_delta' &&
          typeof delta['partial_json'] === 'string'
        ) {
          const tool = tools.get(index);
          if (tool) tool.json += delta['partial_json'];
        }
        break;
      }
      case 'content_block_stop': {
        const tool = tools.get(index);
        if (tool) yield { type: 'tool-call', call: toolCall(tool.id, tool.name, tool.json) };
        break;
      }
      case 'message_delta': {
        const delta = isRecord(event['delta']) ? event['delta'] : {};
        if (typeof delta['stop_reason'] === 'string') reason = delta['stop_reason'];
        const usage = isRecord(event['usage']) ? event['usage'] : {};
        inputTokens = count(usage['input_tokens']) ?? inputTokens;
        outputTokens = count(usage['output_tokens']) ?? outputTokens;
        break;
      }
      case 'message_stop': {
        yield { type: 'usage', inputTokens, outputTokens };
        yield {
          type: 'finish',
          reason:
            reason === 'tool_use'
              ? 'tool-calls'
              : reason === 'end_turn' || reason === 'stop_sequence'
                ? 'stop'
                : reason === 'max_tokens'
                  ? 'length'
                  : 'other',
        };
        return;
      }
      case 'error': {
        yield streamFailure(ai, isRecord(event['error']) ? event['error'] : {});
        return;
      }
    }
  }
}

// A tool call whose arguments, sent in pieces, are now whole. Arguments that
// aren't JSON go on as the text they are, for the client to refuse.
function toolCall(id: string, name: string, args: string): AiToolCall {
  if (args.trim() === '') return { id, name, input: {} };
  const input = aiRoutes.AiToolCall.shape.input.safeParse(parseJson(args));
  return { id, name, input: input.success ? input.data : args };
}

/** The data of each server-sent event in `body`. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (line === '') {
        if (data.length > 0) yield data.join('\n');
        data = [];
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
  if (data.length > 0) yield data.join('\n');
}

/** What a provider's refusal means, from its status and its error body. */
export function refusal(ai: AiConfig, status: number, text: string): Failure {
  const body = parseJson(text);
  const error = isRecord(body) && isRecord(body['error']) ? body['error'] : {};
  const message =
    typeof error['message'] === 'string'
      ? error['message']
      : isRecord(body) && typeof body['error'] === 'string'
        ? body['error']
        : '';
  const code = typeof error['code'] === 'string' ? error['code'] : '';
  const detail = cleanDetail(ai, message);
  if (status === 401 || status === 403) return { type: 'error', code: 'key-rejected' };
  if (status === 429 || status === 529) return { type: 'error', code: 'rate-limited', detail };
  if (code === 'model_not_found' || MODEL_UNKNOWN.test(message)) {
    return { type: 'error', code: 'model-unknown', detail };
  }
  // A bare 404 is most often a base URL missing (or with an extra) `/v1`.
  if (status === 404) return { type: 'error', code: 'unavailable', detail };
  if (status === 413 || code === 'context_length_exceeded' || TOO_LONG.test(message)) {
    return { type: 'error', code: 'too-long', detail };
  }
  if (status >= 500) return { type: 'error', code: 'unavailable', detail };
  return { type: 'error', code: 'failed', detail };
}

// How providers word an unknown model, or a conversation over its context window.
const MODEL_UNKNOWN =
  /^model: |model.{0,40}(not found|not exist|unknown|not supported|unsupported|invalid)|(unknown|invalid|unsupported) (provider for )?model/i;
const TOO_LONG = /context (length|window)|too long|too many tokens|maximum context/i;

// An error the provider sent in the middle of its stream.
function streamFailure(ai: AiConfig, error: Record<string, unknown>): Failure {
  const kind = typeof error['type'] === 'string' ? error['type'] : '';
  const detail = cleanDetail(ai, typeof error['message'] === 'string' ? error['message'] : '');
  if (kind === 'rate_limit_error' || kind === 'overloaded_error') {
    return { type: 'error', code: 'rate-limited', detail };
  }
  if (kind === 'authentication_error' || kind === 'permission_error') {
    return { type: 'error', code: 'key-rejected' };
  }
  if (kind === 'api_error') return { type: 'error', code: 'unavailable', detail };
  return { type: 'error', code: 'failed', detail };
}

// The provider's explanation without the key, should it quote it, and short.
function cleanDetail(ai: AiConfig, message: string): string | undefined {
  let text = message.trim();
  if (ai.apiKey) text = text.replaceAll(ai.apiKey, '[key]');
  if (text === '') return undefined;
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}

const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
