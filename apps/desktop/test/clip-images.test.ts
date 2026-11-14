import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { addressKind, type AddressKind } from '../src/clip/addresses.ts';
import { dataImage, imageFetcher, sniffImage } from '../src/clip/images.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe('what an address is', () => {
  it.each<[string, AddressKind]>([
    ['93.184.215.14', 'public'],
    ['8.8.8.8', 'public'],
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['0.0.0.0', 'other'],
    ['0.1.2.3', 'other'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.1', 'public'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['100.127.255.255', 'private'],
    ['100.128.0.1', 'public'],
    ['169.254.169.254', 'link-local'],
    ['198.18.0.1', 'private'],
    ['192.0.2.1', 'other'],
    ['224.0.0.1', 'other'],
    ['255.255.255.255', 'other'],
    ['::', 'other'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:8.8.8.8', 'public'],
    ['::127.0.0.1', 'other'],
    ['64:ff9b::a00:1', 'private'],
    ['64:ff9b::808:808', 'public'],
    ['64:ff9b:1::1', 'private'],
    ['2002:7f00:1::', 'loopback'],
    ['2002:808:808::1', 'public'],
    ['2001::1', 'other'],
    ['2001:db8::1', 'other'],
    ['fd00::1', 'private'],
    ['fc12::1', 'private'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'link-local'],
    ['fec0::1', 'private'],
    ['ff02::1', 'other'],
    ['2606:4700::1111', 'public'],
    ['3fff::1', 'public'],
    ['4000::1', 'other'],
    ['example.com', 'other'],
    ['', 'other'],
  ])('%s is %s', (address, kind) => {
    expect(addressKind(address)).toBe(kind);
  });
});

describe('what reads as an image', () => {
  it('knows the raster types by their bytes, and never SVG', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(Buffer.from('\0\0\0\x1cftypavif\0\0\0\0'))).toBe('image/avif');
    expect(sniffImage(SVG)).toBeNull();
    expect(sniffImage(Buffer.from('<html>'))).toBeNull();
  });

  it('decodes a data: image under the same checks', () => {
    expect(dataImage(`data:image/png;base64,${PNG.toString('base64')}`, 1000)).toEqual({
      ok: true,
      bytes: PNG,
      mediaType: 'image/png',
    });
    const percent = `data:image/gif,${encodeURIComponent('GIF89a\u0001\u0000')}`;
    expect(dataImage(percent, 1000)).toMatchObject({ ok: true, mediaType: 'image/gif' });
    expect(dataImage(`data:image/svg+xml;base64,${SVG.toString('base64')}`, 1000)).toEqual({
      ok: false,
      reason: 'not-image',
    });
    expect(dataImage(`data:text/plain;base64,${PNG.toString('base64')}`, 1000)).toEqual({
      ok: false,
      reason: 'not-image',
    });
    // Only printable ASCII is percent-encoded image bytes.
    expect(dataImage('data:image/gif,GIF89a\u00e9', 1000)).toEqual({
      ok: false,
      reason: 'not-image',
    });
    expect(dataImage(`data:image/gif,${'a'.repeat(3001)}`, 1000)).toEqual({
      ok: false,
      reason: 'too-large',
    });
    // Refused from its length, before it's decoded.
    expect(dataImage(`data:image/png;base64,${'A'.repeat(4000)}`, 1000)).toEqual({
      ok: false,
      reason: 'too-large',
    });
  });
});

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A server on `host`, answering with `handler`, and every request it got. */
async function serve(handler: Handler, host = '127.0.0.1') {
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return { port: (server.address() as AddressInfo).port, requests };
}

const png: Handler = (_request, response) => {
  response.writeHead(200, { 'content-type': 'image/png' });
  response.end(PNG);
};

// The tests' internet: names resolve as the table says, and 127.0.0.1
// counts as public, so a server on it stands for a site; 127.0.0.2 stays
// this computer, and 127.0.0.3 stands for the local network.
const NAMES: Record<string, string[]> = {
  'site.test': ['127.0.0.1'],
  'cdn.test': ['127.0.0.1'],
  'home.test': ['127.0.0.2'],
  'router.test': ['127.0.0.3'],
  'wiki.lan': ['127.0.0.3'],
  nas: ['127.0.0.3'],
  'both.test': ['127.0.0.2', '127.0.0.1'],
  // A site naming a local address beside its own, or only a local one.
  'sneaky.test': ['127.0.0.1', '127.0.0.3'],
  'sneaky.lan': ['127.0.0.1', '127.0.0.3'],
};
const kindOf = (address: string): AddressKind =>
  address === '127.0.0.1' ? 'public' : address === '127.0.0.3' ? 'private' : addressKind(address);
const lookups: string[] = [];
const fetcher = (timeoutMs?: number) =>
  imageFetcher({
    resolve: async (host) => {
      lookups.push(host);
      const found = NAMES[host];
      if (!found) throw new Error(`No address for ${host}`);
      return found.map((address) => ({ address, family: 4 }));
    },
    kindOf,
    userAgent: 'WikiStow test',
    ...(timeoutMs && { timeoutMs }),
  });

async function get(url: string, page = 'https://site.test/article', maxBytes = 1_000_000) {
  const { allowedFor, fetchImage } = fetcher();
  return fetchImage(url, { allowed: await allowedFor(page), page, maxBytes });
}

describe('the image fetcher', () => {
  it('fetches an image with no cookies, the page’s origin as Referer, and its own address', async () => {
    const { port, requests } = await serve(png);
    expect(await get(`http://cdn.test:${port}/a/photo.png?w=2`)).toEqual({
      ok: true,
      bytes: PNG,
      mediaType: 'image/png',
    });
    const [request] = requests;
    expect(request?.url).toBe('/a/photo.png?w=2');
    expect(request?.headers).toMatchObject({
      host: `cdn.test:${port}`,
      'user-agent': 'WikiStow test',
    });
    expect(request?.headers.cookie).toBeUndefined();
    expect(request?.headers.authorization).toBeUndefined();
    // From https to http, no Referer, as a browser sends none.
    expect(request?.headers.referer).toBeUndefined();
    await get(`http://cdn.test:${port}/b.png`, 'http://site.test/deep/article?x=1');
    expect(requests[1]?.headers.referer).toBe('http://site.test/');
  });

  it('never sends a user name or password the address holds', async () => {
    const { port, requests } = await serve(png);
    expect(await get(`http://me:secret@cdn.test:${port}/a.png`)).toMatchObject({ ok: true });
    expect(requests[0]?.headers.authorization).toBeUndefined();
  });

  it('refuses this computer and the local network, by name or address, and connects to nothing', async () => {
    const local = await serve(png, '127.0.0.2');
    const network = await serve(png, '127.0.0.3');
    for (const url of [
      `http://home.test:${local.port}/a.png`,
      `http://127.0.0.2:${local.port}/a.png`,
      `http://[::ffff:127.0.0.2]:${local.port}/a.png`,
      `http://router.test:${network.port}/a.png`,
      `http://127.0.0.3:${network.port}/a.png`,
      `http://0.0.0.0:${local.port}/a.png`,
    ]) {
      expect(await get(url), url).toEqual({ ok: false, reason: 'refused' });
    }
    expect(local.requests.length + network.requests.length).toBe(0);
  });

  it('connects to the address it checked, not another the name has', async () => {
    const { port, requests } = await serve(png);
    expect(await get(`http://both.test:${port}/a.png`)).toMatchObject({ ok: true });
    expect(requests).toHaveLength(1);
  });

  it('takes the local network’s images for a page on it, as an intranet page', async () => {
    const network = await serve(png, '127.0.0.3');
    const local = await serve(png, '127.0.0.2');
    const intranet = `http://wiki.lan/wiki`;
    expect(await get(`http://router.test:${network.port}/a.png`, intranet)).toMatchObject({
      ok: true,
    });
    expect(await get(`http://127.0.0.3:${network.port}/a.png`, 'http://nas/')).toMatchObject({
      ok: true,
    });
    expect(await get(`http://127.0.0.3:${network.port}/a.png`, 'http://127.0.0.3/')).toMatchObject({
      ok: true,
    });
    // Only what the page is on: not this computer.
    expect(await get(`http://home.test:${local.port}/a.png`, intranet)).toEqual({
      ok: false,
      reason: 'refused',
    });
  });

  it('takes no local image for a page whose name the site answers for, whatever it answers', async () => {
    const network = await serve(png, '127.0.0.3');
    const image = `http://127.0.0.3:${network.port}/admin?reboot=1`;
    // Its own address beside a local one, a local one alone (as rebinding
    // answers), or both under a local name.
    for (const page of ['http://sneaky.test/', 'http://router.test/', 'http://sneaky.lan/']) {
      expect(await get(image, page), page).toEqual({ ok: false, reason: 'refused' });
    }
    expect(network.requests).toHaveLength(0);
  });

  it('follows five redirects at most, each checked again', async () => {
    const local = await serve(png, '127.0.0.2');
    let hops = 0;
    const { port } = await serve((request, response) => {
      const to = new URL(request.url ?? '/', 'http://x');
      const left = Number(to.searchParams.get('left'));
      if (to.pathname === '/local') {
        response.writeHead(302, { location: `http://home.test:${local.port}/a.png` });
        return response.end();
      }
      if (to.pathname === '/file') {
        response.writeHead(302, { location: 'file:///etc/passwd' });
        return response.end();
      }
      if (left > 0) {
        hops++;
        response.writeHead(307, { location: `/r?left=${left - 1}` });
        return response.end();
      }
      png(request, response);
    });
    expect(await get(`http://cdn.test:${port}/r?left=5`)).toMatchObject({ ok: true });
    expect(hops).toBe(5);
    expect(await get(`http://cdn.test:${port}/r?left=6`)).toEqual({ ok: false, reason: 'failed' });
    expect(await get(`http://cdn.test:${port}/local`)).toEqual({ ok: false, reason: 'refused' });
    expect(local.requests).toHaveLength(0);
    expect(await get(`http://cdn.test:${port}/file`)).toEqual({ ok: false, reason: 'refused' });
  });

  it('takes only what says it is an image and reads as one', async () => {
    const { port } = await serve((request, response) => {
      if (request.url === '/html') {
        response.writeHead(200, { 'content-type': 'text/html' });
        return response.end('<html>');
      }
      if (request.url === '/lies') {
        response.writeHead(200, { 'content-type': 'image/png' });
        return response.end('<html>');
      }
      if (request.url === '/svg') {
        response.writeHead(200, { 'content-type': 'image/svg+xml' });
        return response.end(SVG);
      }
      if (request.url === '/gone') {
        response.writeHead(404, { 'content-type': 'image/png' });
        return response.end(PNG);
      }
      // A JPEG called a PNG is still the JPEG it reads as.
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    });
    expect(await get(`http://cdn.test:${port}/html`)).toEqual({ ok: false, reason: 'not-image' });
    expect(await get(`http://cdn.test:${port}/lies`)).toEqual({ ok: false, reason: 'not-image' });
    expect(await get(`http://cdn.test:${port}/svg`)).toEqual({ ok: false, reason: 'not-image' });
    expect(await get(`http://cdn.test:${port}/gone`)).toEqual({ ok: false, reason: 'failed' });
    expect(await get(`http://cdn.test:${port}/jpeg`)).toMatchObject({
      ok: true,
      mediaType: 'image/jpeg',
    });
  });

  it('stops at the size given, as declared or as it arrives, compressed or not', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(5000)]);
    const { port } = await serve((request, response) => {
      if (request.url === '/declared') {
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': big.length });
        return response.end(big);
      }
      if (request.url === '/gzip') {
        // Small on the wire, past the limit once undone.
        response.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip' });
        return response.end(gzipSync(Buffer.concat([PNG, Buffer.alloc(1_000_000)])));
      }
      if (request.url === '/small-gzip') {
        response.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip' });
        return response.end(gzipSync(PNG));
      }
      response.writeHead(200, { 'content-type': 'image/png' });
      response.write(big.subarray(0, 2000));
      response.end(big.subarray(2000));
    });
    const limit = 4000;
    for (const path of ['declared', 'chunked', 'gzip']) {
      expect(await get(`http://cdn.test:${port}/${path}`, undefined, limit), path).toEqual({
        ok: false,
        reason: 'too-large',
      });
    }
    expect(await get(`http://cdn.test:${port}/small-gzip`, undefined, limit)).toEqual({
      ok: true,
      bytes: PNG,
      mediaType: 'image/png',
    });
  });

  it('gives up on a site too slow to answer', async () => {
    const { port } = await serve(() => {});
    const { allowedFor, fetchImage } = fetcher(200);
    const page = 'https://site.test/';
    expect(
      await fetchImage(`http://cdn.test:${port}/a.png`, {
        allowed: await allowedFor(page),
        page,
        maxBytes: 1000,
      }),
    ).toEqual({ ok: false, reason: 'failed' });
  });

  it('refuses addresses it doesn’t fetch', async () => {
    for (const url of [
      'blob:https://site.test/1',
      'ftp://cdn.test/a.png',
      'not a url',
      'javascript:1',
    ]) {
      expect(await get(url), url).toEqual({ ok: false, reason: 'refused' });
    }
    // A name with no address is refused too, once looked up.
    lookups.length = 0;
    expect(await get('http://nowhere.test/a.png')).toEqual({ ok: false, reason: 'refused' });
    expect(lookups).toContain('nowhere.test');
  });
});
