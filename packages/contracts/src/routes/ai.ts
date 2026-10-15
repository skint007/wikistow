import { z } from 'zod';
import type { RouteDef, StreamRouteDef } from '../route.ts';

/**
 * The AI assistant's connection (wikistow.md, AI assistant). The server's
 * operator configures one provider: an API style, a base URL, a key and a
 * model. Clients send the conversation and their tool definitions to the
 * server, which forwards them with the key and streams the answer back as
 * `AiEvent` lines. Tools run only in the client; the server never runs one,
 * and keeps no prompt or answer.
 */

/** OpenAI-compatible Chat Completions, or Anthropic Messages. */
export const AiStyle = z.enum(['openai', 'anthropic']);
export type AiStyle = z.infer<typeof AiStyle>;

/** What a model may call: the tool's name, what it is for, and a JSON Schema for its input. */
export const AiToolDefinition = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  description: z.string().max(4096),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type AiToolDefinition = z.infer<typeof AiToolDefinition>;

/** A model's request to run a tool. `input` is what it sent, which the client validates. */
export const AiToolCall = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(64),
  input: z.json(),
});
export type AiToolCall = z.infer<typeof AiToolCall>;

/** What a tool answered, as text. `isError` tells the model the call failed. */
export const AiToolResult = z.object({
  callId: z.string().min(1).max(256),
  output: z.string(),
  isError: z.boolean(),
});
export type AiToolResult = z.infer<typeof AiToolResult>;

/**
 * One turn of a conversation. A `tool` turn answers every call of the
 * assistant turn before it.
 */
export const AiMessage = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), text: z.string().min(1) }),
  z.object({ role: z.literal('assistant'), text: z.string(), toolCalls: z.array(AiToolCall) }),
  z.object({ role: z.literal('tool'), results: z.array(AiToolResult).min(1) }),
]);
export type AiMessage = z.infer<typeof AiMessage>;

export const AiRequest = z.object({
  system: z.string().optional(),
  messages: z.array(AiMessage).min(1),
  tools: z.array(AiToolDefinition).max(128),
});
export type AiRequest = z.infer<typeof AiRequest>;

/**
 * Why the provider gave no (complete) answer. `key-rejected`: it refused the
 * server's key. `model-unknown`: it doesn't offer the configured model.
 * `rate-limited`: it is limiting requests or overloaded. `unavailable`: the
 * server couldn't reach it, it failed, or its answer broke off. `too-long`:
 * the conversation is more than the model takes. `failed`: anything else.
 */
export const AiProviderFailure = z.enum([
  'key-rejected',
  'model-unknown',
  'rate-limited',
  'unavailable',
  'too-long',
  'failed',
]);
export type AiProviderFailure = z.infer<typeof AiProviderFailure>;

/**
 * Why a reply ended: `stop` (finished), `tool-calls` (waiting for tool
 * results), `length` (it reached the output limit), or `other`.
 */
export const AiFinishReason = z.enum(['stop', 'tool-calls', 'length', 'other']);
export type AiFinishReason = z.infer<typeof AiFinishReason>;

/**
 * One line of the stream, the same for both API styles. Text arrives in
 * pieces; each tool call arrives whole. A stream ends with `finish` or
 * `error`. `detail` is the provider's own explanation, when it gave one,
 * and never carries the key.
 */
export const AiEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool-call'), call: AiToolCall }),
  z.object({
    type: z.literal('usage'),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal('finish'), reason: AiFinishReason }),
  z.object({ type: z.literal('error'), code: AiProviderFailure, detail: z.string().optional() }),
]);
export type AiEvent = z.infer<typeof AiEvent>;

/**
 * Whether this server has AI set up, and with what. `host` names where
 * requests go, for the disclosure; the key and the rest of the URL stay on
 * the server.
 */
export const AiStatus = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    style: AiStyle,
    host: z.string(),
    model: z.string(),
    maxOutputTokens: z.number().int().positive(),
  }),
]);
export type AiStatus = z.infer<typeof AiStatus>;

export const status = {
  method: 'GET',
  path: '/api/ai',
  response: AiStatus,
} as const satisfies RouteDef;

/** Send the provider a tiny request, to show whether the key and model work. */
export const check = {
  method: 'POST',
  path: '/api/ai/check',
  response: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true) }),
    z.object({ ok: z.literal(false), code: AiProviderFailure, detail: z.string().optional() }),
  ]),
} as const satisfies RouteDef;

/**
 * Forward a conversation and stream the reply, one JSON `AiEvent` per line
 * (`application/x-ndjson`), with a blank line every 15 seconds the provider
 * is quiet, for readers to skip. Refusals before the stream starts (AI off,
 * signed out, rate limited, too large) are ordinary API errors. Ending the
 * request cancels the provider's request.
 */
export const stream = {
  method: 'POST',
  path: '/api/ai/stream',
  body: AiRequest,
  event: AiEvent,
} as const satisfies StreamRouteDef;
