import { createAiSession } from '@wikistow/client';
import { schema } from '@wikistow/server';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { signedInPerson } from './support/accounts.ts';
import { scratchApps } from './support/harness.ts';

const KEY = 'sk-test-ai-key-that-must-stay-on-the-server';
const PROMPT = 'PRIVATE-PROMPT-TEXT-51c9';

// A provider that answers one streamed word, or refuses quoting the key,
// as some do in their error messages.
const seen: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
const provider = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString()));
  req.on('end', () => {
    seen.push({ url: req.url ?? '', headers: req.headers, body });
    if (req.url?.startsWith('/refuse')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Bad request for key ${KEY}` } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      req.url?.endsWith('/chat/completions')
        ? 'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        : [
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
            'data: {"type":"message_stop"}',
          ].join('\n\n') + '\n\n',
    );
  });
});
let origin = '';
beforeAll(async () => {
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
});
afterAll(() => provider.close());

const app = scratchApps();

// The key is the server's alone, and prompts pass through without being
// kept or logged (wikistow.md, AI assistant).
describe.each(['openai', 'anthropic'] as const)('the %s AI proxy', (style) => {
  it('sends the key only to the provider, and never logs prompts', async () => {
    const ai = {
      style,
      baseUrl: origin,
      apiKey: KEY,
      model: 'test-model',
      maxOutputTokens: 100,
      requestsPerMinute: 10,
    };
    const t = await app({ ai });
    const person = await signedInPerson(t);
    const answers: string[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      const res = await person.browser.fetch(url, init);
      answers.push(await res.clone().text());
      return res;
    };
    await fetch('/api/ai', { method: 'GET' });
    const session = createAiSession({ fetch });
    await session.send(PROMPT);
    expect(session.state().messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Hi' });

    // A refusal that quotes the key reaches the person without it.
    ai.baseUrl = `${origin}/refuse`;
    const refused = createAiSession({ fetch });
    await refused.send(PROMPT);
    expect(refused.state().failure?.message).toContain('Bad request for key [key]');

    const header = style === 'openai' ? `Bearer ${KEY}` : KEY;
    const sent = seen.filter((request) => request.body.includes(PROMPT));
    expect(sent).toHaveLength(2);
    for (const request of sent) {
      expect(request.headers[style === 'openai' ? 'authorization' : 'x-api-key']).toBe(header);
      expect(request.body + request.url).not.toContain(KEY);
    }
    seen.length = 0;
    const logs = JSON.stringify(t.logs);
    for (const text of [...answers, JSON.stringify(session.state()), logs]) {
      expect(text).not.toContain(KEY);
    }
    expect(logs).not.toContain(PROMPT);
  });
});

// Set on the admin page instead, the key is write-only, sealed at rest, and
// used from the next request on.
it('keeps a key saved on the admin page off the API and the database', async () => {
  const t = await app();
  const admin = await signedInPerson(t, 'admin');
  const saved = await admin.browser.request('/api/admin/settings/ai', {
    method: 'PUT',
    json: { style: 'openai', baseUrl: origin, apiKey: KEY, model: 'test-model' },
  });
  expect(saved.status).toBe(200);
  const answers = [
    await saved.text(),
    await (await admin.browser.request('/api/admin/settings/ai')).text(),
    await (await admin.browser.request('/api/ai')).text(),
    await (
      await admin.browser.request('/api/admin/ai/models', { method: 'POST', json: {} })
    ).text(),
  ];
  for (const text of answers) expect(text).not.toContain(KEY);
  expect(JSON.parse(answers[2] ?? '')).toMatchObject({ enabled: true, model: 'test-model' });
  const [row] = await t.db.select().from(schema.settings);
  expect(row?.aiApiKey).not.toContain(KEY);

  const session = createAiSession({ fetch: (url, init) => admin.browser.fetch(url, init) });
  await session.send(PROMPT);
  expect(seen.at(-1)?.headers['authorization']).toBe(`Bearer ${KEY}`);
});
