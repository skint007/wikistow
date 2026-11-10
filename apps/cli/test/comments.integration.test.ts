// `page comments` and `page comment` (ADR 0014, decision 10): the built CLI
// against the real server, with its person's comments made through the
// client library, as their web app makes them.
import { commentOperations, pageOperations as pages } from '@wikistow/client';
import { personWithVault } from '@wikistow/server-app/testing/content';
import { createTestApp, type TestApp } from '@wikistow/server-app/testing/harness';
import { invite, library, shareFolder } from '@wikistow/server-app/testing/sharing';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  buildCli,
  cleanUp,
  cli,
  cliHome,
  enroll,
  listen,
  PASSPHRASE,
  type Listening,
} from './support/cli.ts';

let t: TestApp;
let server: Listening;
beforeAll(async () => {
  [t] = await Promise.all([createTestApp(), buildCli()]);
  server = await listen(t);
}, 180_000);
afterAll(async () => {
  await server.close();
  await Promise.all([t.drop(), cleanUp()]);
});

const ESC = '\u001b';

describe('comments', () => {
  it('lists threads, and adds comments and replies only for the audience named', async () => {
    const alice = await personWithVault(t);
    const bob = await personWithVault(t);
    const carol = await personWithVault(t);
    const lib = await library(alice);
    await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [
        await invite(alice, bob, 'editor', true),
        await invite(alice, carol, 'reader', false),
      ],
    });
    const agent = async (canPublish: boolean) => {
      const home = await cliHome();
      const pick = { spaceId: lib.spaceId, folderId: lib.shared, role: 'editor' as const };
      const { agentId } = await enroll(server, home, bob, { picks: [{ ...pick, canPublish }] });
      const run = (args: readonly string[], json = true) =>
        cli(home, ['page', ...args, ...(json ? ['--json'] : [])], { passphrase: PASSPHRASE });
      return { agentId, run };
    };
    const publisher = await agent(true);
    const editor = await agent(false);
    const pageId = lib.page.pageId;

    // Carol, who only reads and has written nothing else, asks a question
    // with a terminal escape in it. The agents can look her up to check it.
    const info = await pages.loadPage(carol.ctx, pageId);
    const published = info.heads.publishedHead!;
    const { region } = await pages.openRevisionOf(carol.ctx, lib.page, 'published', published);
    const question = `Fan oven or not? ${ESC}[2J`;
    const thread = await commentOperations.addComment(
      carol.ctx,
      { ...lib.page, region },
      { audience: 'published', text: question },
    );

    const listed = await publisher.run(['comments', pageId]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.json().threads).toEqual([
      {
        thread,
        for: 'readers',
        resolved: null,
        beforeUnpublish: false,
        comments: [
          expect.objectContaining({
            commentId: thread,
            state: 'opened',
            author: {
              identityId: carol.ctx.identity.public.id,
              name: carol.email.split('@')[0],
              agentName: null,
              personId: null,
            },
            edited: false,
            quote: null,
            text: question,
          }),
        ],
      },
    ]);
    // As text, the escape is shown, not sent to the terminal.
    const plain = await publisher.run(['comments', pageId], false);
    expect(plain.stdout).toContain('Fan oven or not? \\u{1b}[2J');
    expect(plain.stdout).not.toContain(ESC);

    // --for is always needed, and a reply goes to its thread's audience.
    const noFor = await publisher.run(['comment', pageId, '--text', 'Fan: 170']);
    expect(noFor.json().error).toMatchObject({ exit: 2, message: '--for is required' });
    const wrongFor = await publisher.run([
      'comment',
      pageId,
      '--text',
      'Fan: 170',
      '--for',
      'editors',
      '--reply-to',
      thread,
    ]);
    expect(wrongFor.json().error).toMatchObject({ exit: 2, for: 'readers' });

    // An agent that can't publish writes nothing for readers.
    const refused = await editor.run([
      'comment',
      pageId,
      '--text',
      'Fan: 170',
      '--for',
      'readers',
      '--reply-to',
      thread,
    ]);
    expect(refused.json().error).toMatchObject({ exit: 1, code: 'forbidden' });

    const reply = await publisher.run([
      'comment',
      pageId,
      '--text',
      'Fan: 170 °C.',
      '--for',
      'readers',
      '--reply-to',
      thread,
    ]);
    expect(reply.code, reply.stdout).toBe(0);
    expect(reply.json()).toMatchObject({ pageId, thread, for: 'readers' });
    const note = await editor.run(['comment', pageId, '--text', 'Shorter?', '--for', 'editors']);
    expect(note.code, note.stdout).toBe(0);
    expect(note.json()).toMatchObject({ thread: null, for: 'editors' });

    // The owner's app opens both, as the agents' own, in their audiences,
    // though the agents have written nothing else.
    const { region: owners } = await pages.openRevisionOf(
      alice.ctx,
      lib.page,
      'published',
      published,
      {
        fresh: true,
      },
    );
    const shown = await commentOperations.pageComments(alice.ctx, { ...lib.page, region: owners });
    const byId = new Map(
      shown.threads.flatMap((t) => [t.first, ...t.replies]).map((c) => [c.commentId, c]),
    );
    expect(byId.get(reply.json().commentId as never)?.state).toMatchObject({
      kind: 'opened',
      authorId: publisher.agentId,
      payload: { thread, threadAuthor: carol.ctx.identity.public.id, audience: 'published' },
    });
    expect(byId.get(note.json().commentId as never)?.state).toMatchObject({
      kind: 'opened',
      authorId: editor.agentId,
      payload: { thread: null, audience: 'draft', text: 'Shorter?' },
    });

    // Both agents list the threads, each comment by its author.
    const again = await editor.run(['comments', pageId]);
    const threads = again.json().threads as { for: string; comments: { author: unknown }[] }[];
    expect(threads.map((t) => t.for)).toEqual(['readers', 'editors']);
    expect(threads[0]?.comments[1]?.author).toMatchObject({
      identityId: publisher.agentId,
      personId: bob.ctx.identity.public.id,
      agentName: expect.any(String),
    });
  });
});
