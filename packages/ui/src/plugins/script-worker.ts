import {
  PluginError,
  type Disposer,
  type PageHandle,
  type PageRef,
  type PluginSettings,
} from '@wikistow/plugin-sdk';
import {
  METHODS,
  WorkerMessage,
  type BlockSpec,
  type HostMessage,
  type Method,
  type OutputResult,
  type ScriptEvent,
} from '@wikistow/plugin-sdk/protocol';
import { pluginError, type HostPages } from './pages';
import type { EventOf } from './registry';

/** What a script reaches of its settings: `host.settings` but its `on`, which it listens for as an event. */
export type ScriptSettings = Omit<PluginSettings, 'on'>;

/** How long a script's command or event handler may take, from asking to its answer, and its activation. */
export const SCRIPT_BUDGET_MS = 10_000;
/** How long a block's calculation may take. */
export const CALCULATE_BUDGET_MS = 1_000;
/** Failures (overrunning, crashing, a malformed message) that stop a script, within `FAILURE_WINDOW_MS`. */
const FAILURES_ALLOWED = 3;
const FAILURE_WINDOW_MS = 5 * 60_000;

/** Each method, checking its own arguments (a `ZodError` is `invalid`). */
type Calls = { [M in Method]: (args: unknown, page: PageHandle | null) => Promise<unknown> };

const handleOf = (page: PageHandle | null) => {
  if (!page) throw new PluginError('invalid', 'Only a command run on a page has its page');
  return page;
};

const editorOf = (page: PageHandle | null) => {
  const { editor } = handleOf(page);
  if (!editor) throw new PluginError('forbidden', 'This page isn’t open in the draft view');
  return editor;
};

type Outputs = Record<string, OutputResult>;

/**
 * Where a script's registrations go: its activation's registry. Each entry
 * runs by sending the worker an `invoke` and waiting for its `done`.
 */
export type ScriptRegistry = {
  command(id: string, title: string, run: (page: PageHandle) => Promise<void>): Disposer;
  /** A block it fills in: `calculate` gives its outputs from its valid fields' values. */
  block(
    spec: BlockSpec,
    calculate: (page: PageRef, values: Record<string, number | string>) => Promise<Outputs>,
  ): Disposer;
  listen<E extends ScriptEvent['event']>(
    event: E,
    run: (event: EventOf<E>) => Promise<void>,
  ): Disposer;
  /** What went wrong with it; `stopped` once it won't start again until re-enabled. */
  problem(message: string, stopped: boolean): void;
};

/** What a running script tells its `ScriptWorker`, only ever after `LaunchScript` returned. */
export type ScriptHandlers = {
  /** Each message its worker sends, unchecked. */
  message: (data: unknown) => void;
  /** It failed to load or threw, with the browser's message if there is one. */
  error: (message: string) => void;
  /**
   * It ended through no fault of its own: the frame holding it stopped
   * answering and was replaced. It starts again without counting a failure.
   */
  lost: () => void;
};

/** A running script, as its `ScriptWorker` drives it. */
export type ScriptPort = {
  post: (message: HostMessage) => void;
  /** End its worker at once. */
  close: () => void;
};

/** Start a script: `inFrame` (`script-frame.ts`) starts it in the sandboxed host frame. */
export type LaunchScript = (on: ScriptHandlers) => ScriptPort;

type Invocation = {
  resolve: (outputs: Outputs | undefined) => void;
  reject: (error: PluginError) => void;
  page: PageHandle | null;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * One plugin's script, in a module worker of its own that can make no
 * requests (`LaunchScript`), so its only way out is this class's messages,
 * over the port it is launched with. Every message is checked, and every
 * call's arguments, before the page operations run it. What it registers
 * goes into its activation's registry (`ScriptRegistry`) as entries that
 * invoke it, beside what app code registers.
 * A command or event that runs past `SCRIPT_BUDGET_MS`, a crash or a
 * malformed message ends the worker and starts it again; after
 * `FAILURES_ALLOWED` of those in five minutes it stays stopped.
 */
export class ScriptWorker {
  readonly #launch: LaunchScript;
  readonly #registry: ScriptRegistry;
  readonly #calls: Calls;
  #worker: ScriptPort | null = null;
  /** What it registered, each with what takes it out of the registry again. */
  #commands = new Map<string, Disposer>();
  /** Kept as it starts again, which registers the same blocks: their forms stay. */
  #blocks = new Map<string, { spec: BlockSpec; dispose: Disposer }>();
  #calculating: Promise<unknown> = Promise.resolve();
  /** Its activation finished; until then `#started` waits, settled as it does or the worker ends. */
  #ready = false;
  #started = Promise.withResolvers<void>();
  #listening = new Map<ScriptEvent['event'], Disposer>();
  #invocations = new Map<number, Invocation>();
  #next = 0;
  #failures: number[] = [];
  #stopped = false;
  /** Its activation's time, from starting the worker to `ready`. */
  #starting: ReturnType<typeof setTimeout> | undefined;

  constructor(
    launch: LaunchScript,
    pages: HostPages,
    settings: ScriptSettings,
    registry: ScriptRegistry,
  ) {
    this.#launch = launch;
    this.#registry = registry;
    this.#calls = {
      'pages.read': (args) => pages.read(...METHODS['pages.read'].parse(args)),
      'pages.list': (args) => pages.list(...METHODS['pages.list'].parse(args)),
      'pages.tree': (args) => pages.tree(...METHODS['pages.tree'].parse(args)),
      'pages.search': (args) => pages.search(...METHODS['pages.search'].parse(args)),
      'pages.index': (args) => pages.index(...METHODS['pages.index'].parse(args)),
      'pages.query': (args) => pages.query(...METHODS['pages.query'].parse(args)),
      'pages.create': (args) => pages.create(...METHODS['pages.create'].parse(args)),
      'pages.createFolder': (args) =>
        pages.createFolder(...METHODS['pages.createFolder'].parse(args)),
      'pages.saveDraft': (args) => pages.saveDraft(...METHODS['pages.saveDraft'].parse(args)),
      'pages.move': (args) => pages.move(...METHODS['pages.move'].parse(args)),
      'page.read': async (args, page) => {
        METHODS['page.read'].parse(args);
        return handleOf(page).read();
      },
      'page.edit': async (args, page) => {
        const [change] = METHODS['page.edit'].parse(args);
        const { edit } = handleOf(page);
        if (!edit) throw new PluginError('forbidden', 'This page isn’t open in the draft view');
        return edit(change);
      },
      'page.selection': async (args, page) => {
        METHODS['page.selection'].parse(args);
        return editorOf(page).selection();
      },
      'page.insert': async (args, page) => {
        const [markdown] = METHODS['page.insert'].parse(args);
        return editorOf(page).insert(markdown);
      },
      'settings.get': async (args) => {
        METHODS['settings.get'].parse(args);
        return settings.get();
      },
      'settings.set': (args) => settings.set(...METHODS['settings.set'].parse(args)),
      'settings.update': (args) => settings.update(...METHODS['settings.update'].parse(args)),
    };
  }

  start() {
    if (this.#stopped || this.#worker) return;
    const worker: ScriptPort = this.#launch({
      message: (data) => {
        if (this.#worker !== worker) return;
        const message = WorkerMessage.safeParse(data);
        if (!message.success) {
          // Its first problem, such as a block's field ID the app doesn't take.
          const [issue] = message.error.issues;
          const where = issue ? ` (${[...issue.path, issue.message].join(': ')})` : '';
          return this.#fail(`Its script sent a message the app doesn’t accept${where}.`);
        }
        this.#receive(worker, message.data);
      },
      error: (message) => {
        if (this.#worker === worker)
          this.#fail(`Its script failed: ${message || 'it didn’t load'}`);
      },
      lost: () => {
        if (this.#worker !== worker) return;
        this.#end(new PluginError('failed', 'The plugin sandbox stopped answering'));
        this.start();
      },
    });
    this.#worker = worker;
    this.#ready = false;
    this.#started = Promise.withResolvers<void>();
    this.#starting = setTimeout(() => {
      if (this.#worker !== worker) return;
      this.#fail(`Its script took longer than ${SCRIPT_BUDGET_MS / 1000} seconds to start.`);
    }, SCRIPT_BUDGET_MS);
  }

  /** Settled once its activation finished, or the worker ended. */
  started() {
    return this.#started.promise;
  }

  /** End the worker for good, as the plugin unloads: what it was doing fails as `unloaded`. */
  stop() {
    this.#stopped = true;
    this.#end(new PluginError('unloaded', 'The plugin was turned off'));
  }

  async #runCommand(id: string, page: PageHandle): Promise<void> {
    await this.#invoke(
      {
        kind: 'command',
        id,
        page: { ...page.page },
        editable: page.edit !== null,
        cursor: !!page.editor,
      },
      page,
    );
  }

  async #deliver(event: ScriptEvent): Promise<void> {
    await this.#invoke({ kind: 'event', ...event }, null);
  }

  /**
   * Block `type`'s outputs from its valid fields' `values`. One at a time,
   * so a calculation's second starts when the worker takes it, not while it
   * waits behind another block's.
   */
  #calculate(type: string, page: PageRef, values: Record<string, number | string>) {
    const run = this.#calculating.then(async () => {
      // Its start has a budget of its own, which the calculation's mustn't spend.
      while (this.#worker && !this.#ready) await this.#started.promise;
      return this.#invoke(
        { kind: 'calculate', block: type, page: { ...page }, values },
        null,
        CALCULATE_BUDGET_MS,
      );
    });
    this.#calculating = run.catch(() => {});
    return run.then((outputs) => outputs ?? {});
  }

  #invoke(
    target: Extract<HostMessage, { type: 'invoke' }>['target'],
    page: PageHandle | null,
    budget = SCRIPT_BUDGET_MS,
  ) {
    const worker = this.#worker;
    if (!worker) {
      return Promise.reject(
        this.#stopped
          ? new PluginError('failed', 'Its script stopped; turn it back on in Settings → Plugins.')
          : new PluginError('unloaded', 'Its script isn’t running'),
      );
    }
    const invocation = this.#next++;
    return new Promise<Outputs | undefined>((resolve, reject) => {
      const seconds = budget / 1000;
      const timer = setTimeout(
        () =>
          this.#fail(
            `Its script took longer than ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`,
            'timeout',
          ),
        budget,
      );
      this.#invocations.set(invocation, { resolve, reject, page, timer });
      worker.post({ type: 'invoke', invocation, target });
    });
  }

  #receive(worker: ScriptPort, message: WorkerMessage) {
    switch (message.type) {
      case 'ready':
        clearTimeout(this.#starting);
        this.#ready = true;
        this.#started.resolve();
        // Its last failure stays shown: starting again doesn't explain it.
        return;
      case 'failed':
        clearTimeout(this.#starting);
        // Starting it again would fail the same way.
        this.#stopped = true;
        this.#end(new PluginError('failed', message.message));
        this.#registry.problem(`Its script failed to start: ${message.message}`, true);
        return;
      case 'register': {
        const { id, title } = message.command;
        this.#commands.get(id)?.();
        this.#commands.set(
          id,
          this.#registry.command(id, title, (page) => this.#runCommand(id, page)),
        );
        return;
      }
      case 'unregister':
        this.#commands.get(message.command)?.();
        this.#commands.delete(message.command);
        return;
      case 'block': {
        const spec = message.block;
        const kept = this.#blocks.get(spec.type);
        // The same block as it starts again: its form stays, and what is entered in it.
        if (kept && JSON.stringify(kept.spec) === JSON.stringify(spec)) return;
        kept?.dispose();
        const dispose = this.#registry.block(spec, (page, values) =>
          this.#calculate(spec.type, page, values),
        );
        this.#blocks.set(spec.type, { spec, dispose });
        return;
      }
      case 'unblock':
        this.#blocks.get(message.block)?.dispose();
        this.#blocks.delete(message.block);
        return;
      case 'listen':
        if (message.on && !this.#listening.has(message.event)) {
          const dispose = this.#registry.listen(message.event, (event) => this.#deliver(event));
          this.#listening.set(message.event, dispose);
        } else if (!message.on) {
          this.#listening.get(message.event)?.();
          this.#listening.delete(message.event);
        }
        return;
      case 'done': {
        const waiting = this.#invocations.get(message.invocation);
        if (!waiting) return;
        this.#invocations.delete(message.invocation);
        clearTimeout(waiting.timer);
        if (message.error === undefined) waiting.resolve(message.outputs);
        else waiting.reject(new PluginError('failed', message.error));
        return;
      }
      case 'call':
        void this.#answer(worker, message);
        return;
    }
  }

  async #answer(
    worker: ScriptPort,
    { call, method, args, invocation }: Extract<WorkerMessage, { type: 'call' }>,
  ) {
    const page =
      invocation === undefined ? null : (this.#invocations.get(invocation)?.page ?? null);
    let answer: HostMessage;
    try {
      answer = { type: 'answer', call, ok: true, value: await this.#run(method, args, page) };
    } catch (error) {
      const { code, message } = pluginError(error);
      answer = { type: 'answer', call, ok: false, code, message };
    }
    // Not to a worker ended meanwhile, nor its successor.
    if (this.#worker === worker) worker.post(answer);
  }

  #run(method: Method, args: unknown, page: PageHandle | null) {
    return this.#calls[method](args, page);
  }

  #fail(reason: string, code: 'timeout' | 'failed' = 'failed') {
    const now = Date.now();
    this.#failures = [...this.#failures.filter((at) => at > now - FAILURE_WINDOW_MS), now];
    this.#end(new PluginError(code, reason));
    if (this.#failures.length >= FAILURES_ALLOWED) {
      this.#stopped = true;
      this.#registry.problem(
        `Stopped after ${FAILURES_ALLOWED} failures in five minutes. ${reason}`,
        true,
      );
      return;
    }
    this.#registry.problem(reason, false);
    this.start();
  }

  #end(error: PluginError) {
    clearTimeout(this.#starting);
    this.#worker?.close();
    this.#worker = null;
    this.#started.resolve();
    for (const { reject, timer } of this.#invocations.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#invocations.clear();
    // Its commands and handlers go until it registers them again; its blocks stay.
    for (const dispose of [...this.#listening.values(), ...this.#commands.values()]) dispose();
    this.#listening.clear();
    this.#commands.clear();
  }
}
