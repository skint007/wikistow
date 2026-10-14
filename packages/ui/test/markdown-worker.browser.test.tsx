import { findLinks, placedWikilinks } from '@wikistow/client/links';
import { linkSpans } from '@wikistow/client/markdown';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { MarkdownTimeout, MarkdownWorker } from '../src/page/markdown-worker.ts';

// Text the parser takes seconds over, far longer than its size suggests (#47).
const SLOW = '*a'.repeat(20_000);
// A job's budget counts a new worker's loading, which can take most of 10 s
// on a busy runner (#186); well within the test's own 60 s.
const ENOUGH = { budgetMs: 40_000 };

const workers: MarkdownWorker[] = [];
const worker = () => {
  const made = new MarkdownWorker();
  workers.push(made);
  return made;
};
afterEach(() => {
  for (const made of workers.splice(0)) made.close();
  vi.restoreAllMocks();
});

const heading = async (reading: Promise<{ children: { type: string }[] }>) =>
  (await reading).children[0]?.type;

describe('the Markdown worker', () => {
  it('reads a page’s links as export, the publish preview and saving do, on the page’s own', async () => {
    const reader = worker();
    const markdown = 'See [[Plan]] and [the map](attachment:a-map).';
    expect(await reader.run('spans', markdown, ENOUGH)).toEqual(linkSpans(markdown));
    expect(await reader.run('links', markdown, ENOUGH)).toEqual(findLinks(markdown));
    expect(await reader.run('wikilinks', markdown, ENOUGH)).toEqual(placedWikilinks(markdown));
  });

  it('ends a job past its time with its worker, and reads the next with a worker afresh', async () => {
    const reader = worker();
    const ended = vi.spyOn(Worker.prototype, 'terminate');
    const started = performance.now();
    await expect(reader.run('body', SLOW, { budgetMs: 200 })).rejects.toThrow(MarkdownTimeout);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(ended).toHaveBeenCalledOnce();
    expect(await heading(reader.run('body', '# Next', ENOUGH))).toBe('heading');
  });
});
