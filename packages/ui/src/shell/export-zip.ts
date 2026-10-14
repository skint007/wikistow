import { exportOperations, pace, safeName, type ClientContext } from '@wikistow/client';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { MarkdownWorker, READ_BUDGET_MS } from '../page/markdown-worker';

/** Entries a zip without ZIP64 counts: past it, the count wraps and readers miss files. */
export const MAX_ZIP_ENTRIES = 65_535;
/**
 * Bytes of the zip the browser builds, its files and what it writes for
 * each (`ENTRY_BYTES`, and its path twice): it is held in memory, then
 * copied into the download's Blob, so a tab holds about twice this. Well
 * under the 4 GiB a zip without ZIP64 can hold.
 */
export const MAX_ZIP_BYTES = 1024 ** 3;
/**
 * What fflate writes for each entry besides its contents and its path,
 * which it writes twice: a local header (30 bytes), a data descriptor
 * (16), a central directory record (46), and a folder's `/` twice.
 */
export const ENTRY_BYTES = 30 + 16 + 46 + 2;
/** UTF-8 bytes of a path a zip can hold, 65,535, less a folder's `/`. */
const MAX_ZIP_PATH = 65_534;

/** Bytes zipped at a time, so a large file lets the page respond as it goes (`pace`). */
const ZIP_CHUNK = 1024 ** 2;

/** An export too large for the browser to zip. */
export class ExportTooLarge extends Error {
  constructor() {
    super(
      'This is too large to export in the browser: the limit is 65,535 files and folders, or 1 GB. Use wikistow export on the command line instead.',
    );
    this.name = 'ExportTooLarge';
  }
}

/** Refuse an export past what a zip, or a tab, can hold. */
export function checkZipSize(size: exportOperations.ExportSize): void {
  const { entries, bytes, pathBytes, longestPath } = size;
  const zipped = bytes + entries * ENTRY_BYTES + 2 * pathBytes;
  if (entries > MAX_ZIP_ENTRIES || zipped > MAX_ZIP_BYTES || longestPath > MAX_ZIP_PATH) {
    throw new ExportTooLarge();
  }
}

/**
 * What `scope` exports (`exportMarkdown`), as a zip built in memory. It is
 * refused as soon as it is known to be too large (`checkZipSize`), from the
 * tree before any page is opened, and from what the pages list before any
 * attachment is downloaded; what is written is counted too, in case those
 * were wrong. Each file is zipped as it is written, with fflate's
 * synchronous streaming API: the asynchronous one starts workers from blob
 * URLs, which the app's `worker-src 'self'` refuses. Pages are compressed;
 * attachments, mostly images already compressed, are stored as they are.
 * A large file is zipped a chunk at a time, letting the page respond
 * between. Each page's links are read in a worker of the export's own,
 * given `READ_BUDGET_MS` a read, so no page holds up the tab or Cancel; a
 * page past that is exported as written. Nothing is kept anywhere but the
 * returned Blob.
 */
export async function exportZip(
  ctx: ClientContext,
  scope: exportOperations.ExportScope,
  options: {
    onProgress?: (progress: exportOperations.ExportProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ zip: Blob; summary: exportOperations.ExportSummary }> {
  const chunks: Uint8Array[] = [];
  let failed = null as Error | null;
  const zip = new Zip((error, chunk) => {
    if (error) failed = error;
    else chunks.push(chunk);
  });
  const add = async (file: ZipPassThrough | ZipDeflate, bytes: Uint8Array) => {
    zip.add(file);
    for (let at = 0; ; at += ZIP_CHUNK) {
      const end = Math.min(at + ZIP_CHUNK, bytes.length);
      file.push(bytes.subarray(at, end), end === bytes.length);
      if (failed) throw failed;
      if (end === bytes.length) return;
      await pace();
    }
  };
  const encoder = new TextEncoder();
  const written = { entries: 0, bytes: 0, pathBytes: 0, longestPath: 0 };
  const reader = new MarkdownWorker();
  const { signal } = options;
  let summary: exportOperations.ExportSummary;
  try {
    summary = await exportOperations.exportMarkdown(ctx, {
      scope,
      ...options,
      read: (markdown) =>
        reader.run('spans', markdown, { budgetMs: READ_BUDGET_MS, ...(signal && { signal }) }),
      checkSize: checkZipSize,
      write: async (entry) => {
        const pathBytes = encoder.encode(entry.path).length;
        written.entries += 1;
        written.pathBytes += pathBytes;
        written.longestPath = Math.max(written.longestPath, pathBytes);
        if (entry.kind === 'file') written.bytes += entry.bytes.length;
        checkZipSize(written);
        if (entry.kind === 'dir') await add(new ZipPassThrough(`${entry.path}/`), new Uint8Array());
        else if (entry.path.endsWith('.md'))
          await add(new ZipDeflate(entry.path, { level: 6 }), entry.bytes);
        else await add(new ZipPassThrough(entry.path), entry.bytes);
      },
    });
  } finally {
    reader.close();
  }
  zip.end();
  if (failed) throw failed;
  // The Blob copies the chunks, which go once this returns.
  return {
    zip: new Blob(chunks as Uint8Array<ArrayBuffer>[], { type: 'application/zip' }),
    summary,
  };
}

/** A zip's file name, from what was exported: a name every system takes. */
export const zipName = (name: string) =>
  `${safeName(name, { fallback: 'WikiStow export' }).stem}.zip`;

/**
 * Hand `blob` to the browser to save as `name`. Its object URL is revoked
 * as soon as the download has it, so the decrypted zip isn't left reachable.
 */
export function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Once the click's download has started from it.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
