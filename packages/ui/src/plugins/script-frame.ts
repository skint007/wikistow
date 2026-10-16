import { PLUGIN_HOST_PAGE } from '@wikistow/contracts';
import type { LaunchScript, ScriptHandlers } from './script-worker';

/** How long the frame may take to confirm it ended a script before the app replaces it. */
const ANSWER_MS = 2_000;

/** What the frame says to the app (see `apps/web/public/plugin-host.js`). */
type FrameMessage = { type: 'ready' } | { type: 'ended'; id: number };
/** What it relays from a script's worker over that script's port. */
type PortMessage = { message: unknown } | { error: string };

const isFrameMessage = (data: unknown): data is FrameMessage =>
  typeof data === 'object' &&
  data !== null &&
  'type' in data &&
  (data.type === 'ready' || (data.type === 'ended' && 'id' in data && typeof data.id === 'number'));

const isPortMessage = (data: unknown): data is PortMessage =>
  typeof data === 'object' &&
  data !== null &&
  ('message' in data || ('error' in data && typeof data.error === 'string'));

/**
 * The hidden `sandbox="allow-scripts"` frame that holds scripts' workers
 * (ADR 0002). Its opaque origin reaches none of the app's storage, cookies
 * or document, and its policy allows its workers no requests. It is added
 * with the first script and removed with the last. If it stops answering,
 * it is removed, which ends every worker in it, and each script still
 * running there is told it was lost, so its `ScriptWorker` starts it
 * again in a new frame. Plugin code never runs on the frame's own thread,
 * so that isn't the scripts' failure.
 */
class HostFrame {
  readonly #iframe = document.createElement('iframe');
  /** Messages for the frame, held until its script says it is ready. */
  #queue: { message: object; ports: MessagePort[] }[] | null = [];
  readonly #scripts = new Map<number, ScriptHandlers>();
  /** Scripts asked to end whose ending the frame hasn't confirmed yet. */
  readonly #ending = new Map<number, ReturnType<typeof setTimeout>>();
  #next = 0;
  readonly #listen = (event: MessageEvent<unknown>) => {
    if (event.source !== this.#iframe.contentWindow || !isFrameMessage(event.data)) return;
    if (event.data.type === 'ended') {
      clearTimeout(this.#ending.get(event.data.id));
      this.#ending.delete(event.data.id);
      return;
    }
    const queued = this.#queue ?? [];
    this.#queue = null;
    for (const { message, ports } of queued) this.#post(message, ports);
  };

  constructor() {
    this.#iframe.setAttribute('sandbox', 'allow-scripts');
    this.#iframe.hidden = true;
    this.#iframe.src = PLUGIN_HOST_PAGE;
    window.addEventListener('message', this.#listen);
    document.body.append(this.#iframe);
  }

  /** Start `source` (from `url`) as a worker named `name`, relayed over a new port. */
  open(url: string, name: string, on: ScriptHandlers) {
    const id = this.#next++;
    const channel = new MessageChannel();
    this.#scripts.set(id, on);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      if (!this.#scripts.has(id) || !isPortMessage(event.data)) return;
      if ('error' in event.data) on.error(event.data.error);
      else on.message(event.data.message);
    };
    // The app's own origin, so the session goes with it, as for the plugin's other files.
    void fetch(url)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error())))
      .then(
        (source) => {
          if (this.#scripts.has(id))
            this.#post({ type: 'start', id, name, source }, [channel.port2]);
        },
        () => {
          if (this.#scripts.has(id)) on.error('');
        },
      );
    return {
      post: (message: unknown) => channel.port1.postMessage(message),
      close: () => {
        channel.port1.close();
        if (!this.#scripts.delete(id)) return;
        if (this.#scripts.size === 0) return this.#remove();
        this.#ending.set(
          id,
          setTimeout(() => this.#stuck(), ANSWER_MS),
        );
        this.#post({ type: 'end', id });
      },
    };
  }

  #remove() {
    window.removeEventListener('message', this.#listen);
    this.#iframe.remove();
    for (const timer of this.#ending.values()) clearTimeout(timer);
    if (frame === this) frame = null;
  }

  #stuck() {
    const running = [...this.#scripts.values()];
    this.#scripts.clear();
    this.#remove();
    for (const on of running) on.lost();
  }

  #post(message: object, ports: MessagePort[] = []) {
    if (this.#queue) return void this.#queue.push({ message, ports });
    // Its origin is opaque, so it has no name to send to.
    this.#iframe.contentWindow?.postMessage(message, '*', ports);
  }
}

let frame: HostFrame | null = null;

/**
 * Run the script at `url`, a plugin's file on the app's origin, in the
 * host frame, which keeps it off the app's origin.
 * `pluginId` becomes the worker's name, which the SDK reads as
 * `host.pluginId` (a `data:` worker's address doesn't hold it).
 */
export const inFrame =
  (url: string, pluginId: string): LaunchScript =>
  (on) =>
    (frame ??= new HostFrame()).open(url, pluginId, on);
