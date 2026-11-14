import { DESKTOP_CHANNELS, type ClipImage, type ClipRequest } from '@wikistow/contracts';
import { describe, expect, it } from 'vite-plus/test';
import { clipDesk, type PageContents } from '../src/clip/desk.ts';
import type { FetchImageOptions } from '../src/clip/images.ts';
import type { ClipConnection } from '../src/clip/listener.ts';
import { Message, type ClipMessage } from '../src/clip/protocol.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function connection() {
  const replies: Record<string, unknown>[] = [];
  const ended = new AbortController();
  const open: ClipConnection = {
    caller: 'chrome-extension://x/',
    reply: (message) => void replies.push(message),
    closed: ended.signal,
  };
  return { open, replies, close: () => ended.abort() };
}

function setup({ session = 'signed-in' as 'starting' | 'signed-out' | 'signed-in' } = {}) {
  let time = 1_000_000;
  let signedIn = session;
  const shown: number[] = [];
  const requests: ClipRequest[] = [];
  const handlers = new Map<string, () => void>();
  const fetches: { url: string; options: FetchImageOptions }[] = [];
  const allowedFor: string[] = [];
  let fetched: (url: string, options: FetchImageOptions) => Promise<ClipImage> = async () => ({
    ok: true,
    bytes: PNG,
    mediaType: 'image/png',
  });
  const desk = clipDesk({
    session: () => signedIn,
    show: () => void shown.push(time),
    now: () => time,
    searchMs: 50,
    fetcher: {
      allowedFor: async (page) => {
        allowedFor.push(page);
        return new Set(['public']);
      },
      fetchImage: (url, options) => {
        fetches.push({ url, options });
        return fetched(url, options);
      },
    },
  });
  const contents: PageContents = {
    send: (channel, request) => {
      expect(channel).toBe(DESKTOP_CHANNELS.onClipRequest);
      requests.push(request as ClipRequest);
    },
    on: (event, listener) => void handlers.set(event, listener),
  };
  desk.attach(contents);
  return {
    desk,
    shown,
    requests,
    fetches,
    allowedFor,
    page: (event: string) => handlers.get(event)?.(),
    tick: (ms: number) => (time += ms),
    signIn: (next: typeof signedIn) => (signedIn = next),
    fetchWith: (next: typeof fetched) => (fetched = next),
  };
}

let ids = 0;
const clipMessage = (fields: Record<string, unknown> = {}): ClipMessage => {
  const parsed = Message.parse({
    v: 1,
    id: `m${++ids}`,
    type: 'clip',
    mode: 'article',
    url: 'https://news.example/story',
    title: 'A story',
    html: '<p>Hi</p>',
    folder: { spaceId: 'space1', folderId: 'folder1' },
    ...fields,
  });
  if (parsed.type !== 'clip') throw new Error('Not a clip');
  return parsed;
};

const SAVED = {
  ok: true,
  spaceId: 'space1',
  pageId: 'page1',
  title: 'A story',
  path: 'Home / News',
  images: { saved: 1, skipped: 0 },
  faithful: true,
} as const;

describe('the app’s state for the extension', () => {
  it('starts until the page says, then is the vault’s, and starts again as the page reloads', () => {
    const { desk, page } = setup();
    expect(desk.state()).toBe('starting');
    desk.setPageState({ vault: 'locked', offline: false });
    expect(desk.state()).toBe('locked');
    desk.setPageState({ vault: 'unlocked', offline: true });
    expect(desk.state()).toBe('ready');
    expect(desk.offline()).toBe(true);
    page('did-navigate');
    expect(desk.state()).toBe('starting');
    desk.setPageState({ vault: 'unlocked', offline: false });
    page('render-process-gone');
    expect(desk.state()).toBe('starting');
  });

  it('is signed out without a session, whatever the page said', () => {
    const { desk, signIn } = setup();
    desk.setPageState({ vault: 'unlocked', offline: false });
    signIn('signed-out');
    expect(desk.state()).toBe('signed-out');
  });

  it('takes only a state that reads as one', () => {
    const { desk } = setup();
    expect(() => desk.setPageState({ vault: 'open', offline: false })).toThrow();
    expect(() => desk.setPageState({ vault: 'locked', offline: false, extra: 1 })).toThrow();
  });
});

describe('a clip', () => {
  it('goes to the page while unlocked, and its outcome back to the extension', () => {
    const { desk, requests } = setup();
    desk.setPageState({ vault: 'unlocked', offline: false });
    const { open, replies } = connection();
    const message = clipMessage({ tags: ['news'], byline: 'Ann' });
    desk.answer(message, open);
    expect(replies).toEqual([{ id: message.id, type: 'accepted', waits: null }]);
    const [request] = requests;
    expect(request).toEqual({
      kind: 'clip',
      clip: {
        id: expect.any(String),
        mode: 'article',
        url: 'https://news.example/story',
        title: 'A story',
        note: '',
        tags: ['news'],
        html: '<p>Hi</p>',
        text: '',
        byline: 'Ann',
        folder: { spaceId: 'space1', folderId: 'folder1' },
        screenshot: null,
        waited: false,
        made: null,
      },
    });
    if (request?.kind !== 'clip') throw new Error('Not a clip');
    expect(desk.waiting()).toEqual([request.clip]);
    desk.done(request.clip.id, SAVED);
    expect(replies[1]).toEqual({
      id: message.id,
      type: 'saved',
      spaceId: 'space1',
      pageId: 'page1',
      title: 'A story',
      path: 'Home / News',
      images: { saved: 1, skipped: 0 },
      faithful: true,
    });
    expect(desk.waiting()).toEqual([]);
    expect(desk.recent()).toEqual([
      { spaceId: 'space1', pageId: 'page1', title: 'A story', path: 'Home / News' },
    ]);
  });

  it('waits for the unlock while locked, bringing the window forward', () => {
    const { desk, shown, requests } = setup();
    desk.setPageState({ vault: 'locked', offline: false });
    const { open, replies } = connection();
    desk.answer(clipMessage(), open);
    expect(replies).toEqual([expect.objectContaining({ type: 'accepted', waits: 'unlock' })]);
    expect(shown).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: 'clip', clip: { waited: true } });
    expect(desk.holding()).toHaveLength(1);
  });

  it('waits for the app to start, and brings it forward once the page says it’s locked', () => {
    const { desk, shown } = setup();
    const { open, replies } = connection();
    desk.answer(clipMessage(), open);
    expect(replies).toEqual([expect.objectContaining({ type: 'accepted', waits: 'starting' })]);
    expect(shown).toHaveLength(0);
    desk.setPageState({ vault: 'locked', offline: false });
    expect(shown).toHaveLength(1);
  });

  it('is refused signed out, and nothing is held', () => {
    const { desk, requests } = setup({ session: 'signed-out' });
    const { open, replies } = connection();
    desk.answer(clipMessage(), open);
    expect(replies).toEqual([expect.objectContaining({ type: 'error', code: 'signed-out' })]);
    expect(requests).toEqual([]);
    expect(desk.holding()).toEqual([]);
  });

  it('is one at a time: another meanwhile is busy', () => {
    const { desk } = setup();
    desk.setPageState({ vault: 'locked', offline: false });
    desk.answer(clipMessage(), connection().open);
    const { open, replies } = connection();
    desk.answer(clipMessage(), open);
    expect(replies).toEqual([expect.objectContaining({ type: 'error', code: 'busy' })]);
  });

  it('is at most 30 a minute', () => {
    const { desk, requests, tick } = setup();
    desk.setPageState({ vault: 'unlocked', offline: false });
    const send = () => {
      const { open, replies } = connection();
      desk.answer(clipMessage(), open);
      const request = requests.at(-1);
      if (replies[0]?.['type'] === 'accepted' && request?.kind === 'clip') {
        desk.done(request.clip.id, { ok: false, code: 'failed', message: 'No' });
      }
      return replies[0];
    };
    for (let i = 0; i < 30; i++) expect(send()).toMatchObject({ type: 'accepted' });
    expect(send()).toMatchObject({ type: 'error', code: 'busy' });
    tick(60_001);
    expect(send()).toMatchObject({ type: 'accepted' });
  });

  it('says how it failed', () => {
    const { desk, requests } = setup();
    desk.setPageState({ vault: 'unlocked', offline: false });
    const { open, replies } = connection();
    desk.answer(clipMessage(), open);
    const request = requests[0]!;
    if (request.kind !== 'clip') throw new Error('Not a clip');
    expect(() => desk.done(request.clip.id, { ok: false, code: 'nope', message: '' })).toThrow();
    desk.done(request.clip.id, { ok: false, code: 'too-large', message: 'Too long' });
    expect(replies[1]).toEqual({
      id: expect.any(String),
      type: 'error',
      code: 'too-large',
      message: 'Too long',
    });
    // Once answered, it's gone: a second answer does nothing.
    desk.done(request.clip.id, SAVED);
    expect(replies).toHaveLength(2);
  });

  it('keeps its page once made, for a page that loads again to finish', () => {
    const { desk, requests } = setup();
    desk.setPageState({ vault: 'unlocked', offline: false });
    desk.answer(clipMessage(), connection().open);
    const request = requests[0]!;
    if (request.kind !== 'clip') throw new Error('Not a clip');
    expect(() =>
      desk.made(request.clip.id, { spaceId: 'space1', pageId: '../x', path: '' }),
    ).toThrow();
    desk.made(request.clip.id, { spaceId: 'space1', pageId: 'page1', path: 'Home' });
    expect(desk.waiting()[0]?.made).toEqual({ spaceId: 'space1', pageId: 'page1', path: 'Home' });
  });

  it('is saved and listed when the extension left meanwhile', () => {
    const { desk, requests } = setup();
    desk.setPageState({ vault: 'locked', offline: false });
    const { open, replies, close } = connection();
    desk.answer(clipMessage(), open);
    close();
    const request = requests[0]!;
    if (request.kind !== 'clip') throw new Error('Not a clip');
    desk.done(request.clip.id, SAVED);
    expect(replies).toHaveLength(1);
    // Listed only while the vault is open: the names are the vault's.
    expect(desk.recent()).toEqual([]);
    desk.setPageState({ vault: 'unlocked', offline: false });
    expect(desk.recent()).toHaveLength(1);
    // Gone once signed out, and no longer shown from the browser.
    desk.signedOut();
    expect(desk.recent()).toEqual([]);
    const show = connection();
    const parsed = Message.parse({
      v: 1,
      id: 's',
      type: 'show',
      spaceId: 'space1',
      pageId: 'page1',
    });
    if (parsed.type !== 'show') throw new Error('Not a show');
    desk.answer(parsed, show.open);
    expect(show.replies).toEqual([expect.objectContaining({ code: 'not-allowed' })]);
  });

  it('is let go once the page loads in an app signed out meanwhile', () => {
    const { desk, signIn } = setup();
    const { open, replies } = connection();
    desk.answer(clipMessage(), open);
    signIn('signed-out');
    desk.setPageState({ vault: 'locked', offline: false });
    expect(replies[1]).toMatchObject({ type: 'error', code: 'signed-out' });
    expect(desk.holding()).toEqual([]);
  });

  it('is let go once the person signs out, and the page told', () => {
    const { desk, requests } = setup();
    desk.setPageState({ vault: 'locked', offline: false });
    const { open, replies } = connection();
    desk.answer(clipMessage(), open);
    desk.signedOut();
    expect(replies[1]).toMatchObject({ type: 'error', code: 'signed-out' });
    expect(desk.holding()).toEqual([]);
    const clipId = requests[0]?.kind === 'clip' ? requests[0].clip.id : null;
    expect(requests.at(-1)).toEqual({ kind: 'dropped', clipIds: [clipId] });
  });

  it('lists the last ten saved, newest first', () => {
    const { desk, requests } = setup();
    desk.setPageState({ vault: 'unlocked', offline: false });
    for (let i = 0; i < 12; i++) {
      desk.answer(clipMessage(), connection().open);
      const request = requests.at(-1)!;
      if (request.kind !== 'clip') throw new Error('Not a clip');
      desk.done(request.clip.id, { ...SAVED, pageId: `page${i}`, title: `Clip ${i}` });
    }
    expect(desk.recent().map((clip) => clip.title)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Clip ${11 - i}`),
    );
  });
});

describe('the clip’s schema', () => {
  const parse = (fields: Record<string, unknown>) =>
    Message.safeParse({
      v: 1,
      id: 'a',
      type: 'clip',
      mode: 'link',
      url: 'https://example.com/',
      title: 'T',
      folder: { spaceId: 'space1', folderId: null },
      ...fields,
    }).success;

  it('holds each field to its limit, and takes nothing else', () => {
    expect(parse({})).toBe(true);
    expect(parse({ title: 'x'.repeat(501) })).toBe(false);
    expect(parse({ note: 'x'.repeat(10_001) })).toBe(false);
    expect(parse({ tags: Array(21).fill('a') })).toBe(false);
    expect(parse({ tags: ['x'.repeat(101)] })).toBe(false);
    expect(parse({ mode: 'screenshot' })).toBe(false);
    expect(parse({ mode: 'screenshot', screenshot: '' })).toBe(false);
    expect(parse({ mode: 'screenshot', screenshot: 'iVBORw0K' })).toBe(true);
    expect(parse({ mode: 'screenshot', screenshot: 'not base64!' })).toBe(false);
    expect(parse({ mode: 'screenshot', screenshot: 'iVBORw0' })).toBe(false);
    expect(parse({ mode: 'link', screenshot: 'iVBORw0K' })).toBe(false);
    expect(parse({ mode: 'screenshot', screenshot: 'iVBORw0K', html: '<p>x</p>' })).toBe(false);
    expect(parse({ folder: { spaceId: '../x', folderId: null } })).toBe(false);
    expect(parse({ folder: undefined })).toBe(false);
    expect(parse({ url: '' })).toBe(false);
    expect(parse({ cookie: 'a' })).toBe(false);
  });
});

describe('a screenshot', () => {
  const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

  it('keeps whether its page was made only partly, for a reload to finish it', () => {
    const { desk, requests } = setup();
    desk.setPageState({ vault: 'unlocked', offline: false });
    const { open } = connection();
    desk.answer(clipMessage({ mode: 'screenshot', html: '', screenshot: base64(PNG) }), open);
    const request = requests[0]!;
    if (request.kind !== 'clip') throw new Error('Not a clip');
    const page = { spaceId: 'space1', pageId: 'page1', path: 'Home' };
    desk.made(request.clip.id, { ...page, partial: true });
    expect(desk.waiting()[0]?.made).toEqual({ ...page, partial: true });
    desk.made(request.clip.id, { ...page, partial: false });
    expect(desk.waiting()[0]?.made).toEqual({ ...page, partial: false });
    expect(() => desk.made(request.clip.id, { ...page, partial: 'no' })).toThrow();
  });

  it('goes to the page as its bytes, told PNG or JPEG by them', () => {
    const { desk, requests } = setup();
    desk.setPageState({ vault: 'unlocked', offline: false });
    for (const [bytes, mediaType] of [
      [PNG, 'image/png'],
      [JPEG, 'image/jpeg'],
    ] as const) {
      const { open, replies } = connection();
      const message = clipMessage({ mode: 'screenshot', html: '', screenshot: base64(bytes) });
      desk.answer(message, open);
      expect(replies).toEqual([{ id: message.id, type: 'accepted', waits: null }]);
      const request = requests.at(-1)!;
      if (request.kind !== 'clip') throw new Error('Not a clip');
      expect(request.clip).toMatchObject({ mode: 'screenshot', html: '', text: '' });
      expect(request.clip.screenshot?.mediaType).toBe(mediaType);
      expect([...request.clip.screenshot!.bytes]).toEqual([...bytes]);
      desk.done(request.clip.id, SAVED);
    }
  });

  it('refuses what isn’t a PNG or JPEG by its bytes, whatever it claims', () => {
    const { desk, requests } = setup();
    desk.setPageState({ vault: 'unlocked', offline: false });
    for (const bytes of [
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0]),
    ]) {
      const { open, replies } = connection();
      const message = clipMessage({ mode: 'screenshot', html: '', screenshot: base64(bytes) });
      desk.answer(message, open);
      expect(replies).toEqual([
        { id: message.id, type: 'error', code: 'invalid', message: expect.any(String) },
      ]);
    }
    expect(requests).toEqual([]);
    expect(desk.holding()).toEqual([]);
  });

  it('refuses one over 24 MiB as too large, before holding it', () => {
    const { desk, requests } = setup();
    desk.setPageState({ vault: 'unlocked', offline: false });
    const big = new Uint8Array(24 * 1024 * 1024 + 1);
    big.set(PNG);
    const { open, replies } = connection();
    const message = clipMessage({ mode: 'screenshot', html: '', screenshot: base64(big) });
    desk.answer(message, open);
    expect(replies).toEqual([
      { id: message.id, type: 'error', code: 'too-large', message: expect.any(String) },
    ]);
    expect(requests).toEqual([]);
  });
});

describe('the folder search', () => {
  const folder = (path: string) => ({ spaceId: 's', folderId: 'f', path });

  it('answers only while unlocked', async () => {
    const { desk, requests } = setup();
    desk.setPageState({ vault: 'locked', offline: false });
    const { open, replies } = connection();
    desk.answer({ v: 1, id: 'q', type: 'folders', query: 'rec' }, open);
    await Promise.resolve();
    expect(replies).toEqual([expect.objectContaining({ id: 'q', type: 'error', code: 'locked' })]);
    expect(requests).toEqual([]);
  });

  it('asks the page, and answers at most 50 matches and five recent, paths cut short', async () => {
    const { desk, requests } = setup();
    desk.setPageState({ vault: 'unlocked', offline: false });
    const { open, replies } = connection();
    desk.answer({ v: 1, id: 'q', type: 'folders', query: 'rec' }, open);
    const request = requests[0]!;
    expect(request).toEqual({ kind: 'folders', id: expect.any(String), query: 'rec' });
    if (request.kind !== 'folders') throw new Error('Not a search');
    desk.answerFolders(request.id, {
      recent: Array.from({ length: 7 }, (_, i) => folder(`Recent ${i}`)),
      matches: [folder('x'.repeat(300)), ...Array.from({ length: 60 }, (_, i) => folder(`M ${i}`))],
    });
    await new Promise((resolve) => setTimeout(resolve));
    const [answer] = replies;
    expect(answer).toMatchObject({ id: 'q', type: 'folders' });
    expect(answer?.['recent']).toHaveLength(5);
    expect(answer?.['matches']).toHaveLength(50);
    const first = (answer!['matches'] as { path: string }[])[0]!;
    expect(first.path).toHaveLength(200);
    expect(first.path.endsWith('…')).toBe(true);
    expect(JSON.stringify(answer).length).toBeLessThan(64 * 1024);
  });

  it('says it’s locked when the page does, and failed when it doesn’t answer', async () => {
    const { desk, requests } = setup();
    desk.setPageState({ vault: 'unlocked', offline: false });
    const first = connection();
    desk.answer({ v: 1, id: 'a', type: 'folders', query: '' }, first.open);
    const request = requests[0]!;
    if (request.kind !== 'folders') throw new Error('Not a search');
    desk.answerFolders(request.id, null);
    await new Promise((resolve) => setTimeout(resolve));
    expect(first.replies).toEqual([expect.objectContaining({ code: 'locked' })]);
    const second = connection();
    desk.answer({ v: 1, id: 'b', type: 'folders', query: '' }, second.open);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(second.replies).toEqual([expect.objectContaining({ code: 'failed' })]);
  });

  it('is at most 60 a minute', async () => {
    const { desk, requests } = setup();
    desk.setPageState({ vault: 'unlocked', offline: false });
    const replies: Record<string, unknown>[][] = [];
    for (let i = 0; i < 61; i++) {
      const one = connection();
      replies.push(one.replies);
      desk.answer({ v: 1, id: `q${i}`, type: 'folders', query: 'a' }, one.open);
      const request = requests.at(-1);
      if (request?.kind === 'folders') desk.answerFolders(request.id, { recent: [], matches: [] });
    }
    await new Promise((resolve) => setTimeout(resolve));
    expect(requests).toHaveLength(60);
    expect(replies[60]).toEqual([expect.objectContaining({ code: 'busy' })]);
  });
});

describe('show', () => {
  const showMessage = () => {
    const parsed = Message.parse({
      v: 1,
      id: 's',
      type: 'show',
      spaceId: 'space1',
      pageId: 'page1',
    });
    if (parsed.type !== 'show') throw new Error('Not a show');
    return parsed;
  };

  it('opens only a draft clipped this session', () => {
    const { desk, requests, shown } = setup();
    desk.setPageState({ vault: 'unlocked', offline: false });
    const other = connection();
    desk.answer(showMessage(), other.open);
    expect(other.replies).toEqual([expect.objectContaining({ code: 'not-allowed' })]);
    expect(shown).toEqual([]);
    desk.answer(clipMessage(), connection().open);
    const request = requests[0]!;
    if (request.kind !== 'clip') throw new Error('Not a clip');
    desk.done(request.clip.id, SAVED);
    const { open, replies } = connection();
    desk.answer(showMessage(), open);
    expect(replies).toEqual([{ id: 's', type: 'shown' }]);
    expect(shown).toHaveLength(1);
    expect(requests.at(-1)).toEqual({ kind: 'show', spaceId: 'space1', pageId: 'page1' });
  });
});

describe('a clip’s images', () => {
  function heldClip(fields: Record<string, unknown> = {}) {
    const test = setup();
    test.desk.setPageState({ vault: 'unlocked', offline: false });
    test.desk.answer(clipMessage(fields), connection().open);
    const request = test.requests[0]!;
    if (request.kind !== 'clip') throw new Error('Not a clip');
    return { ...test, clipId: request.clip.id };
  }

  it('are fetched only for a clip being saved, for the clip’s page', async () => {
    const { desk, clipId, fetches, allowedFor } = heldClip({ url: 'https://wiki.example/a' });
    expect(await desk.image('someone-else', 'https://cdn.example/a.png')).toEqual({
      ok: false,
      reason: 'refused',
    });
    expect(await desk.image(clipId, 'https://cdn.example/a.png')).toMatchObject({ ok: true });
    await desk.image(clipId, 'https://cdn.example/b.png');
    expect(allowedFor).toEqual(['https://wiki.example/a']);
    expect(fetches.map((fetch) => [fetch.url, fetch.options.page])).toEqual([
      ['https://cdn.example/a.png', 'https://wiki.example/a'],
      ['https://cdn.example/b.png', 'https://wiki.example/a'],
    ]);
    expect(fetches[0]?.options.maxBytes).toBe(24 * 1024 * 1024);
    desk.done(clipId, SAVED);
    expect(fetches[0]?.options.signal?.aborted).toBe(true);
    expect(await desk.image(clipId, 'https://cdn.example/c.png')).toEqual({
      ok: false,
      reason: 'refused',
    });
  });

  it('are at most 50 a clip', async () => {
    const { desk, clipId } = heldClip();
    for (let i = 0; i < 50; i++) {
      expect(await desk.image(clipId, `https://cdn.example/${i}.png`)).toMatchObject({ ok: true });
    }
    expect(await desk.image(clipId, 'https://cdn.example/51.png')).toEqual({
      ok: false,
      reason: 'limit',
    });
  });

  it('are at most 100 MiB a clip', async () => {
    const { desk, clipId, fetches, fetchWith } = heldClip();
    const mib = 1024 * 1024;
    fetchWith(async () => ({ ok: true, bytes: new Uint8Array(20 * mib), mediaType: 'image/png' }));
    for (let i = 0; i < 5; i++) await desk.image(clipId, `https://cdn.example/${i}.png`);
    expect(await desk.image(clipId, 'https://cdn.example/x.png')).toEqual({
      ok: false,
      reason: 'limit',
    });
    expect(fetches).toHaveLength(5);
  });

  it('are fetched one at a time, so asking for many at once stays in the clip’s bytes', async () => {
    const { desk, clipId, fetches, fetchWith } = heldClip();
    const mib = 1024 * 1024;
    let running = 0;
    let most = 0;
    fetchWith(async () => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return { ok: true, bytes: new Uint8Array(20 * mib), mediaType: 'image/png' };
    });
    const answers = await Promise.all(
      Array.from({ length: 8 }, (_, i) => desk.image(clipId, `https://cdn.example/${i}.png`)),
    );
    expect(most).toBe(1);
    expect(answers.filter((answer) => answer.ok)).toHaveLength(5);
    expect(fetches).toHaveLength(5);
  });

  it('are fetched within two minutes of the first, in all', async () => {
    const { desk, clipId, tick } = heldClip();
    expect(await desk.image(clipId, 'https://cdn.example/1.png')).toMatchObject({ ok: true });
    tick(119_000);
    expect(await desk.image(clipId, 'https://cdn.example/2.png')).toMatchObject({ ok: true });
    tick(1_001);
    expect(await desk.image(clipId, 'https://cdn.example/3.png')).toEqual({
      ok: false,
      reason: 'limit',
    });
  });

  it('are what’s left of the clip’s bytes, at most', async () => {
    const { desk, clipId, fetches, fetchWith } = heldClip();
    const mib = 1024 * 1024;
    fetchWith(async (_url, options) =>
      options.maxBytes < 24 * mib
        ? { ok: false, reason: 'too-large' }
        : { ok: true, bytes: new Uint8Array(23 * mib), mediaType: 'image/png' },
    );
    for (let i = 0; i < 4; i++) await desk.image(clipId, `https://cdn.example/${i}.png`);
    // 92 MiB taken: the next may be 8 MiB at most, and over that is the clip's limit.
    expect(await desk.image(clipId, 'https://cdn.example/x.png')).toEqual({
      ok: false,
      reason: 'limit',
    });
    expect(fetches.at(-1)?.options.maxBytes).toBe(8 * mib);
  });

  it('are at most 200 a minute across clips', async () => {
    const test = setup();
    test.desk.setPageState({ vault: 'unlocked', offline: false });
    const answers: ClipImage[] = [];
    for (let clip = 0; clip < 5; clip++) {
      test.desk.answer(clipMessage(), connection().open);
      const request = test.requests.at(-1)!;
      if (request.kind !== 'clip') throw new Error('Not a clip');
      for (let i = 0; i < 41; i++) {
        answers.push(await test.desk.image(request.clip.id, `https://cdn.example/${i}.png`));
      }
      test.desk.done(request.clip.id, SAVED);
    }
    expect(answers.filter((answer) => answer.ok)).toHaveLength(200);
    expect(answers.at(-1)).toEqual({ ok: false, reason: 'limit' });
  });
});
