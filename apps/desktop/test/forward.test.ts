import { describe, expect, it } from 'vite-plus/test';
import { cookieChange, forward } from '../src/forward.ts';

const SERVER = 'https://wiki.example.com';
const COOKIE = '__Secure-better-auth.session_token=abc.def';

describe('forward', () => {
  it('notes a new session the server sets', async () => {
    const reply = new Response('{"ok":true}', {
      status: 201,
      headers: [
        ['set-cookie', '__Secure-better-auth.session_token=new.sig; Path=/; HttpOnly'],
        ['set-cookie', 'other=1'],
        ['content-type', 'application/json'],
      ],
    });
    const send: typeof fetch = async () => reply;
    const { response, cookie } = await forward(
      new Request('app://wikistow/api/me'),
      { origin: SERVER, cookie: COOKIE },
      send,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ ok: true });
    expect(cookie).toBe('__Secure-better-auth.session_token=new.sig; other=1');
  });
});

describe('cookieChange', () => {
  const name = '__Secure-better-auth.session_token';

  it('drops what the server clears, and notices when nothing changed', () => {
    expect(cookieChange(COOKIE, [`${name}=; Max-Age=0; Path=/`])).toBeNull();
    expect(cookieChange(COOKIE, [])).toBeUndefined();
  });
});
