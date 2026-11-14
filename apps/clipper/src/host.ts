// Talking to the desktop app through native messaging (ADR 0017,
// decisions 1 and 4), from the background only: the popup closes when the
// person clicks into the app, and a port it held would close with it. Each
// status check, search or clip is a conversation of its own, on its own
// port, which closes once it's answered, so no helper runs between them.
import { api, browserName } from './api.ts';
import {
  envelope,
  HOSTS,
  type Answer,
  type HostKey,
  type Request,
  type Status,
} from './protocol.ts';

/** The port closed, or never opened, before the conversation was done. */
export class HostGone extends Error {
  /** Whether anything came back first: a host that answered is installed. */
  readonly answered: boolean;
  constructor(message: string, answered: boolean) {
    super(message);
    this.answered = answered;
  }
}

export class TimedOut extends Error {}

/** What a conversation's listener can do: wait longer, or say it's done. */
export type Conversation = {
  /** Wait `ms` for each answer from now on, rather than what was set. */
  wait(ms: number): void;
};

/**
 * Connect to `host`, send `messages`, and hand each answer to `heard`
 * until it returns true. Rejects with `HostGone` if the port closes first,
 * as it does when no host is installed, and `TimedOut` if no answer comes
 * within `ms` of the last (or what `wait` set). `signal` ends it early.
 */
export function converse(
  host: string,
  messages: readonly object[],
  heard: (answer: Answer, conversation: Conversation) => boolean | void,
  options: { ms: number; signal?: AbortSignal },
): Promise<void> {
  return new Promise((resolve, reject) => {
    // No native messaging at all, as on Firefox for Android.
    if (typeof api.runtime.connectNative !== 'function') {
      return reject(new HostGone('This browser can’t reach programs on the computer.', false));
    }
    let port: chrome.runtime.Port;
    try {
      port = api.runtime.connectNative(host);
    } catch (error) {
      return reject(new HostGone(String(error), false));
    }
    let answered = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** How long to wait for the next answer, as last set. */
    let patience = options.ms;
    const end = (error?: Error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', aborted);
      port.onMessage.removeListener(message);
      port.onDisconnect.removeListener(disconnected);
      if (error) reject(error);
      else resolve();
    };
    const conversation: Conversation = {
      wait(ms) {
        patience = ms;
        clearTimeout(timer);
        timer = setTimeout(() => {
          port.disconnect();
          end(new TimedOut(`No answer from ${host}`));
        }, ms);
      },
    };
    const message = (answer: unknown) => {
      answered = true;
      if (!answer || typeof answer !== 'object') return;
      conversation.wait(patience);
      let done: boolean | void;
      try {
        done = heard(answer as Answer, conversation);
      } catch (error) {
        port.disconnect();
        return end(error instanceof Error ? error : new Error(String(error)));
      }
      if (done) {
        port.disconnect();
        end();
      }
    };
    const disconnected = (gone: chrome.runtime.Port) => {
      // Chrome says why in `lastError`, Firefox on the port.
      const why =
        api.runtime.lastError?.message ??
        (gone as { error?: { message?: string } }).error?.message ??
        'The connection closed.';
      end(new HostGone(why, answered));
    };
    const aborted = () => {
      port.disconnect();
      end(
        options.signal?.reason instanceof Error ? options.signal.reason : new TimedOut('Stopped'),
      );
    };
    port.onMessage.addListener(message);
    port.onDisconnect.addListener(disconnected);
    options.signal?.addEventListener('abort', aborted, { once: true });
    conversation.wait(options.ms);
    for (const each of messages) port.postMessage(each);
  });
}

/** Ask `host` one thing, and take its first answer to it. */
export async function ask(host: HostKey, request: Request, ms = 10_000): Promise<Answer> {
  const message = envelope(request);
  let got: Answer | undefined;
  await converse(
    HOSTS[host],
    [message],
    (answer) => {
      if (answer.id !== message.id) return false;
      got = answer;
      return true;
    },
    { ms },
  );
  return got!;
}

/** Which app the extension reaches, and how it is. Null when no host is installed. */
export type Found = { host: HostKey; status: Status };

/** Ask one host how its app is: null if it isn't installed, or doesn't answer as one. */
async function hello(host: HostKey): Promise<Found | null> {
  const version = api.runtime.getManifest().version;
  try {
    const answer = await ask(host, { type: 'hello', extension: version, browser: browserName() });
    if (answer.type === 'status') return { host, status: answer };
    // An app that doesn't take this version answers `hello` itself so,
    // naming the versions it takes.
    if (answer.type === 'error' && answer.code === 'version' && answer.min !== undefined) {
      const protocols = { min: answer.min, max: answer.max ?? answer.min };
      return { host, status: { type: 'status', app: 'ready', protocols } };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Find the app (ADR 0017, decision 1): the stable app's host, then the
 * beta's, using the first whose app is ready, or else the first installed.
 * `pin` asks only one.
 */
export async function find(pin: HostKey | 'auto'): Promise<Found | null> {
  const hosts: HostKey[] = pin === 'auto' ? ['stable', 'beta'] : [pin];
  const found = await Promise.all(hosts.map(hello));
  return (
    found.find((one) => one?.status.app === 'ready') ?? found.find((one) => one !== null) ?? null
  );
}
