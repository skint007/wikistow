import type { ClientContext, exportOperations, SpaceId } from '@wikistow/client';
import { unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vite-plus/test';
import { summaryStatus } from '../src/shell/export-model.ts';
import {
  checkZipSize,
  ENTRY_BYTES,
  ExportTooLarge,
  exportZip,
  MAX_ZIP_BYTES,
  MAX_ZIP_ENTRIES,
} from '../src/shell/export-zip.ts';

type Options = Parameters<typeof exportOperations.exportMarkdown>[1];

// What the export writes, in place of opening a vault: each test sets it.
const fake = vi.hoisted(() => ({ run: async (_options: Options) => ({}) as unknown }));
vi.mock('@wikistow/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wikistow/client')>();
  return {
    ...actual,
    exportOperations: {
      ...actual.exportOperations,
      exportMarkdown: (_ctx: unknown, options: Options) => fake.run(options),
    },
  };
});

const summary: exportOperations.ExportSummary = {
  pages: [],
  attachments: [],
  skipped: [],
  unread: [],
};
const ctx = {} as ClientContext;
const scope = { spaceId: 'space' as SpaceId };

describe('the web export’s size limit', () => {
  it('takes up to 65,535 entries and a 1 GiB zip, and refuses past either', async () => {
    const size = (entries: number, bytes: number) => () =>
      checkZipSize({ entries, bytes, pathBytes: 0, longestPath: 0 });
    const headers = MAX_ZIP_ENTRIES * ENTRY_BYTES;
    expect(size(MAX_ZIP_ENTRIES, MAX_ZIP_BYTES - headers)).not.toThrow();
    expect(size(MAX_ZIP_ENTRIES + 1, 0)).toThrow(ExportTooLarge);
    expect(size(1, MAX_ZIP_BYTES - ENTRY_BYTES + 1)).toThrow(ExportTooLarge);
    // Counted as written too, in case the sizes listed were wrong.
    fake.run = async ({ write }) => {
      for (let i = 0; i <= MAX_ZIP_ENTRIES; i++) await write({ kind: 'dir', path: `d${i}` });
      return summary;
    };
    await expect(exportZip(ctx, scope)).rejects.toThrow(ExportTooLarge);
  });

  it('zips files of several chunks, written side by side, whole and in order', async () => {
    const page = new TextEncoder().encode('words '.repeat(500_000));
    const file = Uint8Array.from({ length: 2_500_000 }, (_, i) => i % 251);
    fake.run = async ({ write }) => {
      await write({ kind: 'dir', path: 'attachments' });
      await Promise.all([
        write({ kind: 'file', path: 'Long.md', bytes: page }),
        write({ kind: 'file', path: 'attachments/big.bin', bytes: file }),
      ]);
      return summary;
    };
    const { zip } = await exportZip(ctx, scope);
    const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
    expect(Object.keys(files)).toEqual(['attachments/', 'Long.md', 'attachments/big.bin']);
    // Compared as buffers: an element at a time takes seconds.
    expect(Buffer.from(files['Long.md'] ?? []).equals(page)).toBe(true);
    expect(Buffer.from(files['attachments/big.bin'] ?? []).equals(file)).toBe(true);
  });
});

describe('what the export dialog says it left out, or wrote as it was', () => {
  const page = { spaceId: 's' as SpaceId, pageId: 'p' as never };

  it('counts pages and attachments apart', () => {
    expect(summaryStatus({ skipped: [], unread: [] })).toBeNull();
    expect(summaryStatus({ skipped: [page], unread: [] })).not.toBeNull();
  });
});
