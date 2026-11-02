import { describe, expect, it } from 'vite-plus/test';
import { handoffCode, signOutSession } from '../src/sign-in.ts';

describe('signOutSession', () => {
  it('asks the server to end the session in JSON, which Better Auth requires', async () => {
    const sent: Request[] = [];
    const send: typeof fetch = async (input, init) => {
      sent.push(new Request(input, init));
      return new Response(null);
    };
    await signOutSession('https://wiki.example.com', 'session=1', undefined, send);
    const [request] = sent;
    expect(request?.url).toBe('https://wiki.example.com/api/auth/sign-out');
    expect(request?.method).toBe('POST');
    expect(request?.headers.get('content-type')).toBe('application/json');
    expect(request?.headers.get('cookie')).toBe('session=1');
    expect(request?.headers.get('origin')).toBe('https://wiki.example.com');
    expect(await request?.json()).toEqual({});
  });
});

describe('handoffCode', () => {
  const code = 'a'.repeat(43);
  it('reads the link as the browser sends it, and as Windows hands it over', () => {
    expect(handoffCode(`wikistow://signed-in?code=${code}`)).toBe(code);
    expect(handoffCode(`wikistow://signed-in/?code=${code}`)).toBe(code);
    expect(handoffCode(`wikistow://signed-in/other?code=${code}`)).toBeNull();
  });
});
