import { streamingHash } from '@wikistow/client';
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Bytes written to staging under a temporary name, not yet stored. */
export type StagedBlob = {
  hash: string;
  size: number;
  /** Move the bytes under their hash. Safe to repeat for the same content. */
  commit(): Promise<void>;
  /** Remove the staged bytes. */
  discard(): Promise<void>;
};

/** A stored blob, read as it is sent. */
export type StoredBlob = { size: number; body: ReadableStream<Uint8Array> };

/** Where encrypted attachment bytes live. Postgres keeps the metadata and access rules. */
export type BlobStore = {
  /**
   * Stream `body` into staging while hashing it. Past `maxBytes`, or on any
   * read or write failure, the partial file is removed and the error thrown.
   */
  stage(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<StagedBlob>;
  /** The bytes as a stream, or null if there is no such blob. */
  get(hash: string): Promise<StoredBlob | null>;
  delete(hash: string): Promise<void>;
  /** Stored hashes with when each file was written, for the orphan sweep. */
  list(): AsyncIterable<{ hash: string; writtenAt: Date }>;
  /** Remove staging files older than `olderThanMs`, left by interrupted uploads. */
  clearStaging(olderThanMs: number): Promise<void>;
};

export class BlobTooLarge extends Error {
  constructor() {
    super('Attachment is too large');
    this.name = 'BlobTooLarge';
  }
}

const HASH = /^[A-Za-z0-9_-]{43}$/;

const isMissing = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

/** A web stream's chunks as a Node stream, so it can join a pipeline. */
async function* chunks(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** A file's chunks as a web stream, read only as fast as they are sent. */
function webStream(path: string): ReadableStream<Uint8Array> {
  const file = createReadStream(path);
  const iterator: AsyncIterator<unknown> = file[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) return controller.close();
      if (!(value instanceof Uint8Array)) throw new Error('unexpected chunk from file');
      controller.enqueue(value);
    },
    cancel() {
      file.destroy();
    },
  });
}

/**
 * Blobs as files under `dir/objects/<first two chars>/<hash>`. Uploads stream
 * into `dir/staging` and are renamed into place, so a crash never leaves a
 * half-written blob under its final name. Names are checked, so nothing can
 * escape `dir`.
 */
export function fileBlobStore(dir: string): BlobStore {
  const objects = join(dir, 'objects');
  const staging = join(dir, 'staging');
  const pathFor = (hash: string) => {
    if (!HASH.test(hash)) throw new Error('invalid blob hash');
    return join(objects, hash.slice(0, 2), hash);
  };

  return {
    async stage(body, maxBytes) {
      await mkdir(staging, { recursive: true });
      const temporary = join(staging, `${randomBytes(12).toString('hex')}.tmp`);
      const digest = streamingHash();
      let size = 0;
      const measure = new Transform({
        transform(chunk: Uint8Array, _encoding, done) {
          size += chunk.byteLength;
          if (size > maxBytes) return done(new BlobTooLarge());
          digest.update(chunk);
          done(null, chunk);
        },
      });
      // A pipeline settles once, whichever side fails: a disk error mid-upload
      // rejects here instead of escaping as an unhandled stream error.
      try {
        await pipeline(Readable.from(chunks(body)), measure, createWriteStream(temporary));
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      const hash = digest.digest();
      return {
        hash,
        size,
        async commit() {
          const path = pathFor(hash);
          await mkdir(join(path, '..'), { recursive: true });
          await rename(temporary, path);
        },
        discard: () => rm(temporary, { force: true }),
      };
    },
    async get(hash) {
      const path = pathFor(hash);
      try {
        const { size } = await stat(path);
        return { size, body: webStream(path) };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async delete(hash) {
      await rm(pathFor(hash), { force: true });
    },
    async *list() {
      const prefixes = await readdir(objects).catch((error: unknown) => {
        if (isMissing(error)) return [];
        throw error;
      });
      for (const prefix of prefixes) {
        for (const name of await readdir(join(objects, prefix))) {
          if (!HASH.test(name)) continue;
          yield { hash: name, writtenAt: (await stat(join(objects, prefix, name))).mtime };
        }
      }
    },
    async clearStaging(olderThanMs) {
      const names = await readdir(staging).catch((error: unknown) => {
        if (isMissing(error)) return [];
        throw error;
      });
      const cutoff = Date.now() - olderThanMs;
      for (const name of names) {
        const path = join(staging, name);
        const written = await stat(path).catch(() => null);
        if (written && written.mtimeMs < cutoff) await rm(path, { force: true });
      }
    },
  };
}
