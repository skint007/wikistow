import type { AiMessage } from '@wikistow/client';
import { z } from 'zod';

const Fields = z.record(z.string(), z.unknown());

/** A line of a diff: kept, taken out, or put in. */
export type DiffLine = { kind: 'same' | 'removed' | 'added'; text: string };

/** Longest texts, in lines, diffed line by line; past that a diff shows the new text whole. */
const MAX_DIFF_LINES = 2000;

/**
 * `before` and `after` line by line, as the fewest lines removed and added
 * (a longest common subsequence). Null when either is too long to diff.
 */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;
  // At i * width + j: the longest common run of a[i..] and b[j..].
  const width = b.length + 1;
  const common = new Uint16Array((a.length + 1) * width);
  const at = (i: number, j: number) => common[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] ?? '' });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || at(i, j + 1) >= at(i + 1, j))) {
      out.push({ kind: 'added', text: b[j++] ?? '' });
    } else {
      out.push({ kind: 'removed', text: a[i++] ?? '' });
    }
  }
  return out;
}

/** A diff with long runs of unchanged lines folded to a few around each change. */
export function foldDiff(
  lines: readonly DiffLine[],
  around = 2,
): (DiffLine | { kind: 'fold'; count: number })[] {
  const near = lines.map((_, index) =>
    lines
      .slice(Math.max(0, index - around), index + around + 1)
      .some((line) => line.kind !== 'same'),
  );
  const out: (DiffLine | { kind: 'fold'; count: number })[] = [];
  lines.forEach((line, index) => {
    if (near[index]) out.push(line);
    else {
      const last = out.at(-1);
      if (last?.kind === 'fold') last.count++;
      else out.push({ kind: 'fold', count: 1 });
    }
  });
  return out;
}

/** What a tool call did, in a few words, for the chat's activity lines. */
export function toolActivity(name: string, input: unknown): string {
  const fields = Fields.safeParse(input).data;
  const field = (key: string) => {
    const value = fields?.[key];
    return typeof value === 'string' ? value : null;
  };
  switch (name) {
    case 'list_places':
      return 'Listed the folders it can use';
    case 'list_pages':
      return 'Listed pages';
    case 'search':
      return `Searched for “${field('query') ?? ''}”`;
    case 'read_page':
      return 'Read a page';
    case 'propose_new_page':
      return `Proposed a new page “${field('title') ?? ''}”`;
    case 'propose_page_edit':
      return 'Proposed an edit';
    case 'propose_new_folder':
      return `Proposed a new folder “${field('name') ?? ''}”`;
    case 'propose_move':
      return 'Proposed a move';
    case 'list_files':
      return 'Listed the workspace’s files';
    case 'read_file':
      return `Read ${field('path') ?? 'a file'}`;
    case 'write_file':
      return `Wrote ${field('path') ?? 'a file'}`;
    case 'delete_file':
      return `Deleted ${field('path') ?? 'a file'}`;
    case 'build_plugin':
      return 'Built the plugin';
    case 'preview_version':
      return 'Changed the version in the preview';
    case 'read_preview':
      return 'Looked at the preview';
    case 'write_sample_page':
      return `Wrote the sample page “${field('title') ?? ''}”`;
    case 'run_command':
      return `Ran ${field('command') ?? 'a command'} on a sample page`;
    case 'sdk_reference':
      return 'Read the plugin SDK’s reference';
    default:
      return name;
  }
}

/** Each tool call in the conversation with its answer, once it came: by call ID. */
export function toolResults(messages: readonly AiMessage[]) {
  const results = new Map<string, { output: string; isError: boolean }>();
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const result of message.results) results.set(result.callId, result);
  }
  return results;
}
