import type { z } from 'zod';

/**
 * A stream route's events (`StreamRouteDef`), each line parsed with `event`
 * as it arrives, until the stream ends or `signal` aborts. Blank lines, which
 * keep a quiet stream open, are skipped. A line that isn't an event throws.
 */
export async function* jsonLines<S extends z.ZodType>(
  response: Response,
  event: S,
  signal: AbortSignal,
): AsyncGenerator<z.output<S>> {
  if (!response.body) return;
  // A reader rather than `for await`, which Safari only has from version 27.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || signal.aborted) return;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.trim() === '') continue;
        const parsed = event.safeParse(parseLine(line));
        if (!parsed.success) throw new Error('Unreadable stream event');
        yield parsed.data;
      }
    }
  } finally {
    // Leaving early lets the rest of the stream go.
    reader.cancel().catch(() => {});
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
