// A stand-in for wikistow-clip-host and the app behind it, for the
// extension's tests (clipper.spec.ts). Chromium starts it through the host
// manifest the test writes. It answers as the test's scenario file says,
// read again for each message, and logs every message it gets.
//
//   FAKE_HOST_DIR=… FAKE_HOST_NAME=stable node fake-host.ts
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Answer, AppState, Folder } from '../src/protocol.ts';

/** An answer without the envelope the host adds. */
type Body = Answer extends infer One
  ? One extends unknown
    ? Omit<One, 'v' | 'id'>
    : never
  : never;

/** What the test sets for this host's app. */
export type Scenario = {
  app: AppState;
  offline?: boolean;
  protocols?: { min: number; max: number };
  /**
   * The states `open` passes through, the last kept; `hold` waits for a file
   * the test writes. While it's `starting`, only the helper that sent `open`
   * reaches the app: another answers `closed`, as the real one does.
   */
  open?: (AppState | { hold: string })[];
  recent?: Folder[];
  folders?: Folder[];
  /** The answers to a clip, after `accepted`; `hold` waits for a file the test writes. */
  clip?: ({ hold: string } | Body)[];
};

const dir = process.env['FAKE_HOST_DIR']!;
const name = process.env['FAKE_HOST_NAME']!;
const scenarioFile = join(dir, `${name}.json`);
const read = (): Scenario => JSON.parse(readFileSync(scenarioFile, 'utf8')) as Scenario;

function send(message: object) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const held = (file: string) => existsSync(join(dir, file));
/** Whether this helper sent `open`, so it reaches an app that's starting. */
let opened = false;

async function answer(message: { v: number; id: string; type: string; [key: string]: unknown }) {
  appendFileSync(join(dir, `${name}.log`), `${JSON.stringify(message)}\n`);
  const scenario = read();
  const app = !opened && scenario.app === 'starting' ? 'closed' : scenario.app;
  const reply = (body: object) => send({ v: 1, id: message.id, ...body });
  const status = (app: AppState) =>
    reply(
      app === 'closed' || app === 'starting'
        ? { type: 'status', app }
        : {
            type: 'status',
            app,
            offline: scenario.offline ?? false,
            appVersion: '0.0.0',
            protocols: scenario.protocols ?? { min: 1, max: 1 },
          },
    );
  switch (message.type) {
    case 'hello':
      return status(app);
    case 'open': {
      opened = true;
      for (const step of scenario.open ?? ['ready']) {
        if (typeof step === 'object') {
          while (!held(step.hold)) await sleep(50);
          continue;
        }
        status(step);
        writeFileSync(scenarioFile, JSON.stringify({ ...read(), app: step }));
        await sleep(50);
      }
      return;
    }
    case 'folders': {
      const query = String(message['query']).toLowerCase();
      const matches = query
        ? (scenario.folders ?? []).filter((one) => one.path.toLowerCase().includes(query))
        : [];
      return reply({ type: 'folders', recent: scenario.recent ?? [], matches });
    }
    case 'clip': {
      if (app === 'closed') return status('closed');
      const waits = app === 'ready' ? null : app === 'starting' ? 'starting' : 'unlock';
      reply({ type: 'accepted', waits });
      for (const step of scenario.clip ?? []) {
        if ('hold' in step) {
          while (!held(step.hold)) await sleep(50);
          continue;
        }
        reply(step);
      }
      return;
    }
    case 'show':
      return reply({ type: 'shown' });
  }
}

// The browser's framing: a 32-bit length in the computer's byte order, then JSON.
let buffered = Buffer.alloc(0);
let queue = Promise.resolve();
process.stdin.on('data', (chunk: Buffer) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32LE(0)) {
    const size = buffered.readUInt32LE(0);
    const message = JSON.parse(buffered.subarray(4, 4 + size).toString('utf8'));
    buffered = buffered.subarray(4 + size);
    queue = queue.then(() => answer(message));
  }
});
process.stdin.on('end', () => process.exit(0));
