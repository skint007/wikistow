import type { exportOperations } from '@wikistow/client';

/**
 * What an export left out, and which pages it wrote as they were because
 * their links couldn't be read, as the dialog says it, or null for neither.
 */
export function summaryStatus({
  skipped,
  unread,
}: Pick<exportOperations.ExportSummary, 'skipped' | 'unread'>): string | null {
  const files = skipped.filter((item) => 'attachmentId' in item).length;
  const left = (n: number, what: string, why: string) =>
    n === 0
      ? []
      : [
          `${n === 1 ? `One ${what}` : `${n.toLocaleString()} ${what}s`} couldn’t be ${why}, so ${n === 1 ? 'it was' : 'they were'} left out.`,
        ];
  const n = unread.length;
  const parts = [
    ...left(skipped.length - files, 'page', 'opened'),
    ...left(files, 'attachment', 'downloaded'),
    ...(n === 0
      ? []
      : [
          `${n === 1 ? 'One page’s links' : `${n.toLocaleString()} pages’ links`} couldn’t be read, so ${n === 1 ? 'it was' : 'they were'} exported as written.`,
        ]),
  ];
  return parts.length === 0 ? null : `Downloaded. ${parts.join(' ')}`;
}

/** How far an export has got, as the dialog says it. */
export function exportStatus(progress: exportOperations.ExportProgress): string {
  const { phase, done, total } = progress;
  const what =
    phase === 'pages'
      ? 'Opening pages'
      : phase === 'preparing'
        ? 'Preparing pages'
        : 'Downloading attachments';
  return `${what}: ${done.toLocaleString()} of ${total.toLocaleString()}`;
}
