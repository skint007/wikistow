import {
  PluginError,
  type PageHandle,
  type PageRef,
  type Pages,
  type PluginEvent,
  type PluginEvents,
} from '@wikistow/plugin-sdk';
import {
  METHODS,
  WorkerMessage,
  type BlockSpec,
  type HostMessage,
  type Method,
  type OutputResult,
} from '@wikistow/plugin-sdk/protocol';
import { pluginError } from './pages';

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

export type ScriptEvents = {
  /** Its commands, by ID with their titles, changed. */
  commands: (commands: ReadonlyMap<string, string>) => void;
  /** The blocks it fills in, by type, changed. */
  blocks: (blocks: ReadonlyMap<string, BlockSpec>) => void;
  /** What went wrong with it; `stopped` once it won't start again until re-enabled. */
  problem: (message: string, stopped: boolean) => void;
};

type Outputs = Record<string, OutputResult>;

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

/**
 * Start a script: `inFrame` (`script-frame.ts`) in the browser's sandboxed
 * frame, `inWorker` as a worker of the app's own origin.
 */
export type LaunchScript = (on: ScriptHandlers) => ScriptPort;

/**
 * Run the script at `url` as a module worker of the app's origin, as the
 * desktop app does: it serves the file with a policy that allows the
 * worker no requests (no fetch, imports or workers).
 */
export const inWorker =
  (url: string): LaunchScript =>
  (on) => {
    const worker = new Worker(url, { type: 'module' });
    worker.onmessage = (event: MessageEvent<unknown>) => on.message(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      on.error(event.message);
    };
    return { post: (message) => worker.postMessage(message), close: () => worker.terminate() };
  };

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
 * call's arguments, before the page operations run it.
 * A command or event that runs past `SCRIPT_BUDGET_MS`, a crash or a
 * malformed message ends the worker and starts it again; after
 * `FAILURES_ALLOWED` of those in five minutes it stays stopped.
 */
export class ScriptWorker {
  readonly #launch: LaunchScript;
  readonly #on: ScriptEvents;
  readonly #calls: Calls;
  #worker: ScriptPort | null = null;
  #commands = new Map<string, string>();
  /** Kept as it starts again, which registers the same blocks: their forms stay. */
  #blocks = new Map<string, BlockSpec>();
  #calculating: Promise<unknown> = Promise.resolve();
  /** Its activation finished; until then `#started` waits, settled as it does or the worker ends. */
  #ready = false;
  #started = Promise.withResolvers<void>();
  #listening = new Set<keyof PluginEvents>();
  #invocations = new Map<number, Invocation>();
  #next = 0;
  #failures: number[] = [];
  #stopped = false;
  /** Its activation's time, from starting the worker to `ready`. */
  #starting: ReturnType<typeof setTimeout> | undefined;

  constructor(launch: LaunchScript, pages: Pages, on: ScriptEvents) {
    this.#launch = launch;
    this.#on = on;
    this.#calls = {
      'pages.read': (args) => pages.read(...METHODS['pages.read'].parse(args)),
      'pages.list': (args) => pages.list(...METHODS['pages.list'].parse(args)),
      'pages.search': (args) => pages.search(...METHODS['pages.search'].parse(args)),
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

  listens(event: keyof PluginEvents) {
    return this.#listening.has(event);
  }

  async runCommand(id: string, page: PageHandle): Promise<void> {
    await this.#invoke(
      { kind: 'command', id, page: { ...page.page }, editable: page.edit !== null },
      page,
    );
  }

  async deliver(event: PluginEvent): Promise<void> {
    await this.#invoke({ kind: 'event', ...event }, null);
  }

  /**
   * Block `type`'s outputs from its valid fields' `values`. One at a time,
   * so a calculation's second starts when the worker takes it, not while it
   * waits behind another block's.
   */
  calculate(type: string, page: PageRef, values: Record<string, number | string>) {
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
        this.#on.problem(`Its script failed to start: ${message.message}`, true);
        return;
      case 'register':
        this.#commands.set(message.command.id, message.command.title);
        this.#on.commands(new Map(this.#commands));
        return;
      case 'unregister':
        this.#commands.delete(message.command);
        this.#on.commands(new Map(this.#commands));
        return;
      case 'block':
        this.#blocks.set(message.block.type, message.block);
        this.#on.blocks(new Map(this.#blocks));
        return;
      case 'unblock':
        this.#blocks.delete(message.block);
        this.#on.blocks(new Map(this.#blocks));
        return;
      case 'listen':
        if (message.on) this.#listening.add(message.event);
        else this.#listening.delete(message.event);
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
      this.#on.problem(
        `Stopped after ${FAILURES_ALLOWED} failures in five minutes. ${reason}`,
        true,
      );
      return;
    }
    this.#on.problem(reason, false);
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
    this.#listening.clear();
    if (this.#commands.size > 0) {
      this.#commands.clear();
      this.#on.commands(new Map());
    }
  }
}
