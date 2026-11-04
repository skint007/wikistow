import { describe, expect, it } from 'vite-plus/test';
import { handoffCode, linkArgument, signOutSession } from '../src/sign-in.ts';

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
  it('takes only its own app’s link, so the beta and stable apps never take each other’s', () => {
    expect(handoffCode(`wikistow-beta://signed-in?code=${code}`, 'beta')).toBe(code);
    expect(handoffCode(`wikistow-beta://signed-in?code=${code}`)).toBeNull();
    expect(handoffCode(`wikistow://signed-in?code=${code}`, 'beta')).toBeNull();
  });
});

describe('linkArgument', () => {
  const stable = 'wikistow://signed-in?code=x';
  const beta = 'wikistow-beta://signed-in?code=x';
  it('finds the link in its own app’s scheme among the launch arguments', () => {
    expect(linkArgument(['/usr/lib/wikistow-desktop/app.asar', stable])).toBe(stable);
    expect(linkArgument(['/usr/lib/wikistow-desktop-beta/app.asar', beta], 'beta')).toBe(beta);
    expect(linkArgument(['--safe-mode'], 'beta')).toBeUndefined();
  });
  it('leaves the other app’s link alone', () => {
    expect(linkArgument([beta])).toBeUndefined();
    expect(linkArgument([stable], 'beta')).toBeUndefined();
  });
});
