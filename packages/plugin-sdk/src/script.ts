import {
  PluginError,
  type BlockField,
  type Command,
  type Disposer,
  type FolderEntry,
  type FolderRef,
  type OutputValue,
  type PageHandle,
  type PageRef,
  type PageVersion,
  type PluginEvents,
  type ScriptBlock,
  type ScriptHost,
  type SearchResult,
  PLUGIN_API,
} from './host.ts';
import type { HostMessage, Method, OutputResult, WorkerMessage } from './protocol.ts';

type Handlers = {
  [E in keyof PluginEvents]: Set<(event: PluginEvents[E]) => void | Promise<void>>;
};

const fire = <E extends keyof PluginEvents>(set: Handlers[E], payload: PluginEvents[E]) =>
  Promise.all([...set].map(async (handler) => handler(payload)));

/**
 * A script's entry: call it once, at the top of `script.ts`. It runs in the
 * plugin's own worker, which has no page, network or storage; `host` is its
 * one way to WikiStow, each call a message the host checks.
 */
export function defineScript(activate: (host: ScriptHost) => void | Promise<void>): void {
  const send = (message: WorkerMessage) => postMessage(message);
  let calls = 0;
  const answers = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  const call = <T>(method: Method, args: unknown[], invocation?: number) =>
    new Promise<T>((resolve, reject) => {
      const id = calls++;
      // Answers come from the host, which made this one for this method.
      answers.set(id, { resolve: (value) => resolve(value as T), reject });
      send({
        type: 'call',
        call: id,
        method,
        args,
        ...(invocation === undefined ? {} : { invocation }),
      });
    });

  const commands = new Map<string, Command>();
  const handlers: Handlers = { 'page.shown': new Set(), 'draft.saved': new Set() };
  const blocks = new Map<string, ScriptBlock<Record<string, BlockField>>>();

  const host: ScriptHost = {
    api: PLUGIN_API,
    // The sandboxed frame starts each script from a `data:` address, named
    // with its plugin's ID (ADR 0002).
    pluginId: self.name,
    signal: new AbortController().signal,
    pages: {
      read: (page) => call<PageVersion>('pages.read', [page]),
      list: (folder) => call<FolderEntry[]>('pages.list', [folder]),
      search: (text, options) =>
        call<SearchResult[]>('pages.search', options ? [text, options] : [text]),
      create: (folder, page) => call<PageVersion>('pages.create', [folder, page]),
      createFolder: (parent, name) => call<FolderRef>('pages.createFolder', [parent, name]),
      saveDraft: (page, change) => call<PageVersion>('pages.saveDraft', [page, change]),
      move: (node, parent) => call<void>('pages.move', [node, parent]),
    },
    commands: {
      register(command): Disposer {
        commands.set(command.id, command);
        send({ type: 'register', command: { id: command.id, title: command.title } });
        return () => {
          if (commands.get(command.id) !== command) return;
          commands.delete(command.id);
          send({ type: 'unregister', command: command.id });
        };
      },
    },
    events: {
      on(event, handler): Disposer {
        const set: Handlers[typeof event] = handlers[event];
        if (set.size === 0) send({ type: 'listen', event, on: true });
        set.add(handler);
        return () => {
          if (!set.delete(handler) || set.size > 0) return;
          send({ type: 'listen', event, on: false });
        };
      },
    },
    blocks: {
      register(block): Disposer {
        // Its functions stay here; the host gets what it draws.
        const entry: ScriptBlock<Record<string, BlockField>> = block;
        blocks.set(block.type, entry);
        send({
          type: 'block',
          block: {
            type: block.type,
            fields: Object.fromEntries(
              Object.entries(block.fields).map(([id, f]) => [id, declaredField(f)]),
            ),
            outputs: Object.fromEntries(
              Object.entries(block.outputs).map(([id, { label }]) => [id, { label }]),
            ),
          },
        });
        return () => {
          if (blocks.get(block.type) !== entry) return;
          blocks.delete(block.type);
          send({ type: 'unblock', block: block.type });
        };
      },
    },
  };

  const invoke = async (
    message: Extract<HostMessage, { type: 'invoke' }>,
  ): Promise<Record<string, OutputResult> | undefined> => {
    const { invocation, target } = message;
    // What arrives as it starts again waits for what it registers.
    await activated.catch(() => {});
    if (target.kind === 'calculate') {
      const block = blocks.get(target.block);
      if (!block) throw new Error(`No block ${target.block}`);
      return calculate(block, target.values, target.page);
    }
    if (target.kind === 'command') {
      const command = commands.get(target.id);
      if (!command) throw new Error(`No command ${target.id}`);
      const page: PageHandle = {
        page: target.page,
        read: () => call<PageVersion>('page.read', [], invocation),
        edit: target.editable
          ? (change) => call<PageVersion>('page.edit', [change], invocation)
          : null,
      };
      await command.run({ page });
      return;
    }
    switch (target.event) {
      case 'page.shown':
        await fire(handlers['page.shown'], target.payload);
        return;
      case 'draft.saved':
        await fire(handlers['draft.saved'], target.payload);
        return;
    }
  };

  addEventListener('message', (event: MessageEvent<HostMessage>) => {
    const message = event.data;
    if (message.type === 'answer') {
      const waiting = answers.get(message.call);
      answers.delete(message.call);
      if (message.ok) waiting?.resolve(message.value);
      else waiting?.reject(new PluginError(message.code, message.message));
      return;
    }
    invoke(message).then(
      (outputs) =>
        send({ type: 'done', invocation: message.invocation, ...(outputs ? { outputs } : {}) }),
      (error: unknown) =>
        send({ type: 'done', invocation: message.invocation, error: describe(error) }),
    );
  });

  const activated = Promise.resolve().then(() => activate(host));
  activated.then(
    () => send({ type: 'ready' }),
    (error: unknown) => send({ type: 'failed', message: describe(error) }),
  );
}

/**
 * A field's declaration as the host takes it: only the keys it knows, and
 * only those set. An app older than a key checks fields strictly and
 * would refuse it, even unset, so a field without `property` never
 * sends one.
 */
export function declaredField(declared: BlockField): BlockField {
  const { label, property } = declared;
  const fields: BlockField =
    declared.type === 'number'
      ? {
          type: 'number',
          label,
          default: declared.default,
          min: declared.min,
          max: declared.max,
          property,
        }
      : { type: 'text', label, default: declared.default, property };
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as BlockField;
}

/** An output read before it was calculated: its reader waits for another round. */
class Waiting {}

/**
 * Every output of `block`, from the fields' `values` (invalid ones left
 * out). Outputs may read each other: one that reads an output not yet
 * calculated runs again after the others, and those still waiting when a
 * round calculates nothing more read each other in a loop.
 */
async function calculate(
  block: ScriptBlock<Record<string, BlockField>>,
  values: Record<string, OutputValue>,
  page: PageRef,
): Promise<Record<string, OutputResult>> {
  const results = new Map<string, OutputResult>();
  const read: Record<string, OutputValue> = {};
  for (const [id, { label }] of Object.entries(block.fields)) {
    Object.defineProperty(read, id, {
      enumerable: true,
      get() {
        const value = values[id];
        if (value === undefined) throw new Error(`Needs a valid ${label}`);
        return value;
      },
    });
  }
  for (const [id, { label }] of Object.entries(block.outputs)) {
    Object.defineProperty(read, id, {
      enumerable: true,
      get() {
        const result = results.get(id);
        if (!result) throw new Waiting();
        if ('error' in result) throw new Error(`Needs ${label}`);
        return result.value;
      },
    });
  }
  let waiting = Object.keys(block.outputs);
  while (waiting.length > 0) {
    const next: string[] = [];
    for (const id of waiting) {
      try {
        const value: unknown = await block.outputs[id]?.calculate(read, { page: { ...page } });
        results.set(id, answer(value));
      } catch (error) {
        if (error instanceof Waiting) next.push(id);
        else results.set(id, { error: describe(error) });
      }
    }
    if (next.length === waiting.length) {
      for (const id of next)
        results.set(id, { error: 'Reads outputs that read each other in a loop' });
      break;
    }
    waiting = next;
  }
  return Object.fromEntries(results);
}

const answer = (value: unknown): OutputResult =>
  typeof value === 'string'
    ? { value: value.slice(0, 1000) }
    : typeof value === 'number' && Number.isFinite(value)
      ? { value }
      : { error: typeof value === 'number' ? 'Not a finite number' : 'Not a number or text' };

const describe = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 2000);
