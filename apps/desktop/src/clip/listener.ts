// The running app's end of the web clipper (docs/adr/0017-web-clipper.md,
// decision 1): a Unix socket in a folder only the person can open, or a
// named pipe on Windows, and clip-host.json, readable by the person alone,
// naming it with a fresh token. Each connection proves it holds the token
// before anything else is read, and the app never writes first, so a
// client without it learns nothing. No web page can reach a socket or a
// pipe, and the app opens no network port.
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import {
  appChallenge,
  Envelope,
  frame,
  frameReader,
  HANDSHAKE_MS,
  MAX_HANDSHAKE,
  MAX_MESSAGE,
  Message,
  parseJson,
  PROTOCOLS,
  type ErrorCode,
} from './protocol.ts';

/** At most this many helpers at once once proven; each popup or clip is one. */
const MAX_CONNECTIONS = 16;
/**
 * At most this many connections still to prove themselves. On Windows any
 * account, or another computer through file sharing, can open the pipe to
 * read, and can never send a byte; the oldest that sent none goes to make
 * room, so they can't keep out the person's helper, which sends its
 * challenge at once.
 */
const MAX_UNPROVEN = 16;
/** A socket's path must fit `sockaddr_un`, 104 bytes on a Mac with its ending. */
const MAX_SOCKET_PATH = 103;

/** Where to listen: a socket in `folder`, made only the person's, or a named pipe. */
export type ClipEndpoint = { kind: 'unix'; folder: string; name: string } | { kind: 'pipe' };

/** One connection's messages once it proved itself, and how to answer them. */
export type ClipConnection = {
  /** The extension the helper names (its origin, or Firefox's ID). */
  caller: string;
  reply(message: Record<string, unknown>): void;
  /** Aborted once the connection closes. */
  closed: AbortSignal;
};

export type ClipListenerOptions = {
  endpoint: ClipEndpoint;
  /** Where clip-host.json goes, for the helper to find. */
  hostFile: string;
  /** Whether the helper's caller is an extension this app answers. */
  allowed: (caller: string) => boolean;
  /** Answer one checked message. */
  answer: (message: Message, connection: ClipConnection) => void;
};

export class ClipListenerError extends Error {}

/** Make `folder` and check it is the person's alone: theirs, a real folder, mode 700. */
export async function privateFolder(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  let found = await lstat(folder);
  const mine = () => found.isDirectory() && found.uid === process.getuid?.();
  if (!mine()) throw new ClipListenerError(`${folder} isn’t a folder of yours`);
  if ((found.mode & 0o077) !== 0) {
    await chmod(folder, 0o700);
    found = await lstat(folder);
    if (!mine() || (found.mode & 0o077) !== 0) {
      throw new ClipListenerError(`${folder} is open to others`);
    }
  }
}

export function clipListener(options: ClipListenerOptions) {
  let server: Server | null = null;
  let address: string | null = null;
  const connections = new Set<Socket>();
  /** Connections not yet past the token's challenge, oldest first. */
  const unproven = new Set<Socket>();
  /** Those that haven't sent a byte yet. */
  const silent = new Set<Socket>();
  /** This run wrote clip-host.json, so it is this run's to delete. */
  let wrote = false;

  async function start(): Promise<void> {
    if (server) return;
    try {
      await listen();
    } catch (error) {
      await stop();
      throw error;
    }
  }

  async function listen(): Promise<void> {
    address = await listenAddress(options.endpoint);
    const token = randomBytes(32);
    const listening = createServer({ allowHalfOpen: false }, (socket) => {
      if (unproven.size >= MAX_UNPROVEN) {
        const oldest = silent.values().next().value;
        // All mid-challenge: this one waits its turn.
        if (!oldest) return void socket.destroy();
        oldest.destroy();
        unproven.delete(oldest);
        silent.delete(oldest);
      }
      unproven.add(socket);
      silent.add(socket);
      socket.once('data', () => silent.delete(socket));
      socket.once('close', () => {
        unproven.delete(socket);
        silent.delete(socket);
        connections.delete(socket);
      });
      serve(socket, token, options, () => {
        unproven.delete(socket);
        if (connections.size >= MAX_CONNECTIONS) return false;
        connections.add(socket);
        return true;
      });
    });
    await new Promise<void>((resolve, reject) => {
      listening.once('error', reject);
      listening.listen(address!, () => {
        listening.off('error', reject);
        resolve();
      });
    });
    server = listening;
    // A failed accept, as when out of file descriptors, drops only that connection.
    listening.on('error', () => {});
    // The folder keeps others out; the socket is the person's too.
    if (options.endpoint.kind === 'unix') await chmod(address, 0o600);
    await mkdir(dirname(options.hostFile), { recursive: true, mode: 0o700 });
    const next = `${options.hostFile}.next`;
    await writeFile(
      next,
      JSON.stringify({ v: 1, socket: address, token: token.toString('base64') }),
      { mode: 0o600 },
    );
    await rename(next, options.hostFile);
    wrote = true;
  }

  /** Stop listening, drop every connection, and delete clip-host.json and the socket. */
  async function stop(): Promise<void> {
    const closing = server;
    server = null;
    removeFiles();
    for (const socket of [...connections, ...unproven]) socket.destroy();
    if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
  }

  /** As the app quits: only the files, at once. */
  function removeFiles() {
    if (wrote) rmSync(options.hostFile, { force: true });
    wrote = false;
    if (address && options.endpoint.kind === 'unix') rmSync(address, { force: true });
    address = null;
  }

  return { start, stop, removeFiles, listening: () => server !== null };
}

async function listenAddress(endpoint: ClipEndpoint): Promise<string> {
  if (endpoint.kind === 'pipe')
    return `\\\\.\\pipe\\wikistow-clip-${randomBytes(8).toString('hex')}`;
  const path = join(endpoint.folder, endpoint.name);
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH) {
    throw new ClipListenerError(`The socket’s path is too long: ${path}`);
  }
  await privateFolder(endpoint.folder);
  // Left by a run that crashed. The single-instance lock means it was this app's.
  await rm(path, { force: true });
  return path;
}

/**
 * One helper's connection: the token's challenge within `HANDSHAKE_MS`,
 * then its messages, each checked for its version and against its schema.
 * Anything else drops it.
 */
function serve(
  socket: Socket,
  token: Uint8Array,
  options: ClipListenerOptions,
  /** Count the connection as proven, if there's room. */
  admit: () => boolean,
) {
  const challenge = appChallenge(token);
  let step: 'challenge' | 'proof' | 'open' = 'challenge';
  let caller = '';
  /** Answered for the last time: what still arrives is dropped unread. */
  let done = false;
  const ended = new AbortController();
  const timer = setTimeout(() => socket.destroy(), HANDSHAKE_MS);
  timer.unref();
  const read = frameReader(() => (step === 'open' ? MAX_MESSAGE : MAX_HANDSHAKE));
  const send = (message: unknown) => {
    if (!socket.destroyed) socket.write(frame(message));
  };
  const refuse = (code: ErrorCode, id?: string, extra: Record<string, unknown> = {}) => {
    send({ v: 1, ...(id ? { id } : {}), type: 'error', code, ...extra });
  };
  /** Say why, if anything, then close, giving the answer a moment to go. */
  const drop = (code?: ErrorCode, id?: string) => {
    done = true;
    if (code) refuse(code, id);
    socket.end();
    setTimeout(() => socket.destroy(), 1_000).unref();
  };
  socket.once('close', () => {
    clearTimeout(timer);
    ended.abort();
  });
  socket.on('error', () => socket.destroy());
  const connection: ClipConnection = {
    get caller() {
      return caller;
    },
    reply: (message) => send({ v: 1, ...message }),
    closed: ended.signal,
  };

  function received(body: Buffer) {
    if (step === 'challenge') {
      const answer = challenge.challenged(body);
      if (!answer) return drop();
      step = 'proof';
      return send(answer);
    }
    if (step === 'proof') {
      const proven = challenge.proven(body);
      if (!proven) return drop();
      // It holds the token, so it may hear why.
      if (!options.allowed(proven.caller)) return drop('not-allowed');
      if (!admit()) return drop('busy');
      clearTimeout(timer);
      caller = proven.caller;
      step = 'open';
      return;
    }
    const json = parseJson(body);
    const envelope = Envelope.safeParse(json);
    if (!envelope.success) return drop('invalid');
    const { v, id } = envelope.data;
    if (v < PROTOCOLS.min || v > PROTOCOLS.max) {
      return refuse('version', id, { min: PROTOCOLS.min, max: PROTOCOLS.max });
    }
    const message = Message.safeParse(json);
    if (!message.success) return drop('invalid', id);
    options.answer(message.data, connection);
  }

  socket.on('data', (chunk: Buffer) => {
    if (done) return;
    read.push(chunk);
    while (!done) {
      let body: Buffer | null;
      try {
        body = read.next();
      } catch {
        return drop(step === 'open' ? 'too-large' : undefined);
      }
      if (!body) return;
      received(body);
    }
  });
}
