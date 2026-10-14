import { aiRoutes, ApiErrorBody } from '@wikistow/contracts';
import { z } from 'zod';
import type { Fetch } from './api/client.ts';

/**
 * The AI assistant's client side (wikistow.md, AI assistant). A session
 * holds one conversation in memory and streams replies through the
 * server's AI proxy. When the model asks for a tool, the session runs it
 * here through its dispatcher and sends the result back; the server and
 * provider never run one. Nothing is stored: closing the session loses it.
 *
 *   const tools = aiDispatcher([
 *     aiTool({
 *       name: 'search',
 *       description: 'Search pages the agent may read',
 *       input: z.object({ query: z.string() }),
 *       run: async ({ query }, signal) => JSON.stringify(await search(query, signal)),
 *     }),
 *   ]);
 *   const session = createAiSession({ dispatcher: tools, system: '…' });
 *   session.subscribe(() => render(session.state()));
 *   await session.send('Find my notes on backups');
 *   session.stop();   // ends the reply; nothing that arrives later runs
 *   session.close();  // also forgets the conversation
 */

export type AiMessage = aiRoutes.AiMessage;
export type AiToolCall = aiRoutes.AiToolCall;
export type AiToolResult = aiRoutes.AiToolResult;
export type AiToolDefinition = aiRoutes.AiToolDefinition;
export type AiFinishReason = aiRoutes.AiFinishReason;

/** Model requests (replies plus tool steps) one `send` may make, unless set. */
export const DEFAULT_AI_STEPS = 8;

/**
 * A tool the model may call. `input` validates what it sends, and gives the
 * provider its JSON Schema. `run` answers with text (often JSON) for the
 * model; a thrown error goes back to it as a failed result. Stopping the
 * session aborts `signal`, and anything `run` returns after that is dropped.
 */
export type AiTool<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  input: S;
  run(input: z.output<S>, signal: AbortSignal): Promise<string>;
};

/** Infer a tool's input type from its schema. */
export const aiTool = <S extends z.ZodType>(tool: AiTool<S>): AiTool<S> => tool;

/**
 * Runs the tools a model asks for, in this client. The session is its only
 * caller, and never after a stop. Answers every call, a refusal included,
 * so the model always hears back.
 */
export type AiDispatcher = {
  readonly definitions: readonly AiToolDefinition[];
  dispatch(call: AiToolCall, signal: AbortSignal): Promise<AiToolResult>;
};

/**
 * A dispatcher for `tools`, which validates each call's input before
 * running it. Throws at once for a tool the server would refuse (a name
 * outside `[A-Za-z0-9_-]{1,64}`, or a description over 4096 characters).
 */
export function aiDispatcher(tools: readonly AiTool[]): AiDispatcher {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    definitions: tools.map((tool) =>
      aiRoutes.AiToolDefinition.parse({
        name: tool.name,
        description: tool.description,
        inputSchema: z.toJSONSchema(tool.input, { io: 'input' }),
      }),
    ),
    async dispatch(call, signal) {
      const failed = (output: string) => ({ callId: call.id, output, isError: true });
      const tool = byName.get(call.name);
      if (!tool) return failed(`There is no tool named ${call.name}.`);
      const input = tool.input.safeParse(call.input);
      if (!input.success) return failed(`Invalid input: ${z.prettifyError(input.error)}`);
      try {
        return { callId: call.id, output: await tool.run(input.data, signal), isError: false };
      } catch (error) {
        return failed(error instanceof Error ? error.message : 'The tool failed.');
      }
    },
  };
}

/**
 * Why a reply failed. The provider's own reasons (`AiProviderFailure`), and
 * this side's: `off` (the server has no AI), `signed-out`, `busy` (this
 * account's AI rate limit), `network` (no answer from WikiStow's server, or
 * it broke off), and `step-limit` (the model kept calling tools).
 */
export type AiFailureCode =
  | aiRoutes.AiProviderFailure
  | 'off'
  | 'signed-out'
  | 'busy'
  | 'network'
  | 'step-limit';

export type AiFailure = { code: AiFailureCode; message: string };

const ASK = 'Ask the person who runs your WikiStow server to check';

/** What to tell the person about a failure, with the provider's own `detail` if it gave one. */
export function aiFailureMessage(code: AiFailureCode, detail?: string): string {
  const said = detail ? ` The provider said: “${detail}”` : '';
  switch (code) {
    case 'key-rejected':
      return `The AI provider turned down this server’s API key. ${ASK} AI_API_KEY.`;
    case 'model-unknown':
      return `The AI provider doesn’t offer the model this server asks for. ${ASK} AI_MODEL.${said}`;
    case 'rate-limited':
      return `The AI provider is busy or limiting requests. Wait a minute and try again.${said}`;
    case 'unavailable':
      return `Your WikiStow server couldn’t get an answer from the AI provider. Try again in a moment. If it keeps happening, ${ASK.charAt(0).toLowerCase()}${ASK.slice(1)} AI_BASE_URL.${said}`;
    case 'too-long':
      return 'This conversation is too long for the model. Start a new one, or include less.';
    case 'failed':
      return `The AI provider couldn’t answer.${said}`;
    case 'off':
      return 'AI isn’t set up on this server.';
    case 'signed-out':
      return 'Your session ended. Sign in again to use the assistant.';
    case 'busy':
      return 'You’ve sent a lot of AI requests in the last minute. Wait a minute and try again.';
    case 'network':
      return 'This app couldn’t reach your WikiStow server. Check your connection and try again.';
    case 'step-limit':
      return 'The assistant took as many steps as it may in one go. Send a message to let it carry on.';
  }
}

export type AiSessionState = {
  /** The conversation, the reply being written included. */
  messages: readonly AiMessage[];
  /** `closed` once `close` was called: the conversation is gone and `send` refuses. */
  status: 'idle' | 'running' | 'closed';
  /** Why the last reply ended, once it has: as the provider said, or `stopped`. */
  finish: AiFinishReason | 'stopped' | null;
  /** Why the last reply failed, until the next `send`. */
  failure: AiFailure | null;
  /** Tokens the provider reported for this session so far. */
  usage: { inputTokens: number; outputTokens: number };
};

export type AiSessionOptions = {
  /** For clients outside the browser, as for `createApiClient`. */
  baseUrl?: string;
  fetch?: Fetch;
  dispatcher?: AiDispatcher;
  system?: string;
  /** Model requests one `send` may make. Defaults to `DEFAULT_AI_STEPS`. */
  maxSteps?: number;
};

export type AiSession = ReturnType<typeof createAiSession>;

const STOPPED = 'The person stopped the reply before this ran.';

/** Start a conversation. Nothing is sent until `send`. */
export function createAiSession({
  baseUrl = '',
  fetch: send = (url, init) => globalThis.fetch(url, init),
  dispatcher = aiDispatcher([]),
  system,
  maxSteps = DEFAULT_AI_STEPS,
}: AiSessionOptions = {}) {
  let state: AiSessionState = {
    messages: [],
    status: 'idle',
    finish: null,
    failure: null,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const listeners = new Set<() => void>();
  // The reply being written. Stopping aborts it, and every step checks it
  // after each wait, so nothing that arrives later changes the
  // conversation or runs a tool.
  let current: AbortController | null = null;

  const update = (change: Partial<AiSessionState>) => {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  };
  const replaceLast = (message: AiMessage) =>
    update({ messages: [...state.messages.slice(0, -1), message] });

  // One model request: stream the reply into the conversation as it comes.
  async function step(
    signal: AbortSignal,
  ): Promise<{ toolCalls: AiToolCall[]; finish: AiFinishReason } | AiFailure | null> {
    const fail = (code: AiFailureCode, detail?: string) => ({
      code,
      message: aiFailureMessage(code, detail),
    });
    let response: Response;
    try {
      response = await send(`${baseUrl}${aiRoutes.stream.path}`, {
        method: aiRoutes.stream.method,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(system === undefined ? {} : { system }),
          messages: [...state.messages],
          tools: [...dispatcher.definitions],
        } satisfies aiRoutes.AiRequest),
        signal,
      });
    } catch {
      return signal.aborted ? null : fail('network');
    }
    if (!response.ok) {
      const body = ApiErrorBody.safeParse(await response.json().catch(() => null));
      const code = body.success ? body.data.error.code : null;
      if (code === 'ai-off') return fail('off');
      if (code === 'unauthenticated' || code === 'account-suspended') return fail('signed-out');
      if (code === 'rate-limited') return fail('busy');
      if (code === 'payload-too-large') return fail('too-long');
      // A proxy in front of the server answering for it while it's down.
      if (response.status >= 500 || code === null) return fail('network');
      return fail('failed');
    }
    const reply: Extract<AiMessage, { role: 'assistant' }> = {
      role: 'assistant',
      text: '',
      toolCalls: [],
    };
    update({ messages: [...state.messages, reply] });
    try {
      for await (const event of events(response, signal)) {
        if (signal.aborted) return null;
        switch (event.type) {
          case 'text':
            reply.text += event.text;
            replaceLast({ ...reply });
            break;
          case 'tool-call':
            reply.toolCalls.push(event.call);
            replaceLast({ ...reply, toolCalls: [...reply.toolCalls] });
            break;
          case 'usage':
            update({
              usage: {
                inputTokens: state.usage.inputTokens + (event.inputTokens ?? 0),
                outputTokens: state.usage.outputTokens + (event.outputTokens ?? 0),
              },
            });
            break;
          case 'finish':
            return { toolCalls: reply.toolCalls, finish: event.reason };
          case 'error':
            return fail(event.code, event.detail);
        }
      }
    } catch {
      return signal.aborted ? null : fail('network');
    }
    return signal.aborted ? null : fail('network');
  }

  // Once a reply ends, leave a conversation the provider will take next
  // time: no empty reply (a model can finish without a word), and after a
  // stop or failure an answer to every tool call.
  function settle() {
    const last = state.messages.at(-1);
    if (last?.role !== 'assistant') return;
    if (last.text.trim() === '' && last.toolCalls.length === 0) {
      update({ messages: state.messages.slice(0, -1) });
    } else if (last.toolCalls.length > 0) {
      const results = last.toolCalls.map((call) => ({
        callId: call.id,
        output: STOPPED,
        isError: true,
      }));
      update({ messages: [...state.messages, { role: 'tool', results }] });
    }
  }

  return {
    state: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /**
     * Ask `text`, then let the model reply, running the tools it calls
     * between steps, until it finishes, fails, is stopped, or reaches the
     * step limit. Resolves when the reply ends; the outcome is in `state()`.
     * Throws for empty `text`, or while a reply is still being written.
     */
    async send(text: string): Promise<void> {
      if (state.status === 'closed') throw new Error('This conversation is closed');
      if (text.trim() === '') throw new Error('There is nothing to send');
      if (current) throw new Error('A reply is still being written');
      const run = new AbortController();
      current = run;
      const { signal } = run;
      update({
        messages: [...state.messages, { role: 'user', text }],
        status: 'running',
        finish: null,
        failure: null,
      });
      try {
        for (let steps = 0; ; steps++) {
          if (steps === maxSteps) {
            settle();
            update({ failure: { code: 'step-limit', message: aiFailureMessage('step-limit') } });
            return;
          }
          const outcome = await step(signal);
          if (signal.aborted || outcome === null) return;
          if ('code' in outcome) {
            settle();
            update({ failure: outcome });
            return;
          }
          if (outcome.toolCalls.length === 0) {
            settle();
            update({ finish: outcome.finish });
            return;
          }
          const results: AiToolResult[] = [];
          for (const call of outcome.toolCalls) {
            const result = await dispatcher.dispatch(call, signal);
            if (signal.aborted) return;
            results.push(result);
          }
          update({ messages: [...state.messages, { role: 'tool', results }] });
        }
      } finally {
        if (current === run) {
          current = null;
          update({ status: 'idle' });
        }
      }
    },
    /** End the reply being written. What it wrote stays; nothing arriving later is used. */
    stop() {
      if (!current) return;
      current.abort();
      current = null;
      settle();
      update({ status: 'idle', finish: 'stopped' });
    },
    /** Stop, and forget the conversation. For vault lock and sign-out. */
    close() {
      current?.abort();
      current = null;
      update({
        messages: [],
        status: 'closed',
        finish: null,
        failure: null,
      });
    },
  };
}

// The stream's lines as events. A line that isn't one ends it.
async function* events(response: Response, signal: AbortSignal) {
  if (!response.body) return;
  // A reader rather than `for await`, which Safari only has from version 27.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || signal.aborted) return;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.trim() === '') continue;
        const event = aiRoutes.AiEvent.safeParse(parseLine(line));
        if (!event.success) throw new Error('Unreadable AI event');
        yield event.data;
      }
    }
  } finally {
    // Leaving early (at `finish`) lets the rest of the stream go.
    reader.cancel().catch(() => {});
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
