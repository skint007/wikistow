// Reads Markdown off the page's thread. Some text takes the parser far
// longer than its size suggests (#47), and nothing stops a parse once it
// has started, but the page can end this worker. One job at a time.
import { markdownJobs, type MarkdownRequest, type MarkdownResponse } from './markdown-jobs';

function run(request: MarkdownRequest) {
  switch (request.job) {
    case 'body':
      return markdownJobs.body(request.input);
    case 'spans':
      return markdownJobs.spans(request.input);
    case 'links':
      return markdownJobs.links(request.input);
    case 'wikilinks':
      return markdownJobs.wikilinks(request.input);
    case 'headings':
      return markdownJobs.headings(request.input);
    case 'fidelity':
      return markdownJobs.fidelity(request.input);
    case 'meaning':
      return markdownJobs.meaning(request.input);
    default:
      throw new Error(`Unknown Markdown job: ${JSON.stringify(request satisfies never)}`);
  }
}

self.onmessage = (event: MessageEvent<MarkdownRequest>) => {
  try {
    self.postMessage({ ok: true, output: run(event.data) } satisfies MarkdownResponse);
  } catch {
    // Past the parser's stack, or too deep for structured clone to copy.
    self.postMessage({ ok: false } satisfies MarkdownResponse);
  }
};

self.postMessage({ ready: true } satisfies MarkdownResponse);
