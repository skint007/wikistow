/** The largest banner image kept, in pixels, each way. */
export const BANNER_MAX_SIZE = 1600;

/** Files larger than this aren't decoded at all. */
export const BANNER_MAX_UPLOAD = 25 * 1024 * 1024;

/** Nor are images with more pixels than this, however small the file. */
export const BANNER_MAX_PIXELS = 50_000_000;

type Size = { width: number; height: number };

// JPEG's start-of-frame markers, which carry the image's size; not DHT, JPG or DAC.
const JPEG_FRAMES = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

const ascii = (bytes: Uint8Array, at: number, text: string) =>
  bytes.length >= at + text.length &&
  bytes.subarray(at, at + text.length).every((byte, i) => byte === text.charCodeAt(i));

/**
 * The size a PNG, JPEG, WebP or GIF declares in its header, read without
 * decoding it. Null for anything else, or a header cut short.
 */
function imageSize(bytes: Uint8Array): Size | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const has = (end: number) => end <= bytes.length;
  const u16 = (at: number, little = false) => (has(at + 2) ? view.getUint16(at, little) : 0);
  const u24 = (at: number) => u16(at, true) + ((bytes[at + 2] ?? 0) << 16);
  const sized = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : null;

  if (ascii(bytes, 0, '\x89PNG\r\n\x1a\n') && ascii(bytes, 12, 'IHDR') && has(24))
    return sized(view.getUint32(16), view.getUint32(20));
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) {
    // Browsers grow the canvas to fit a first frame larger than the screen
    // the header declares, so walk the blocks to that frame's descriptor.
    // Later frames are cropped to the canvas, so they can't grow it.
    const packed = bytes[10] ?? 0;
    let at = 13 + (packed & 0x80 ? 3 << ((packed & 7) + 1) : 0);
    while (has(at + 2) && bytes[at] === 0x21) {
      // An extension: its label, then data sub-blocks up to an empty one.
      at += 2;
      while (has(at + 1) && bytes[at] !== 0) at += 1 + (bytes[at] ?? 0);
      at += 1;
    }
    if (bytes[at] !== 0x2c || !has(at + 9)) return null;
    return sized(
      Math.max(u16(6, true), u16(at + 1, true) + u16(at + 5, true)),
      Math.max(u16(8, true), u16(at + 3, true) + u16(at + 7, true)),
    );
  }
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) {
    if (ascii(bytes, 12, 'VP8 ')) return sized(u16(26, true) & 0x3fff, u16(28, true) & 0x3fff);
    if (ascii(bytes, 12, 'VP8L') && has(25)) {
      const bits = view.getUint32(21, true);
      return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (ascii(bytes, 12, 'VP8X') && has(30)) return sized(u24(24) + 1, u24(27) + 1);
    return null;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Walk the segments to the first frame header.
    let at = 2;
    while (has(at + 2) && bytes[at] === 0xff) {
      const marker = bytes[at + 1] ?? 0;
      if (JPEG_FRAMES.has(marker)) return sized(u16(at + 7), u16(at + 5));
      // A fill byte, a marker that stands alone, or a segment with its length.
      if (marker === 0xff) at += 1;
      else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) at += 2;
      else at += 2 + u16(at + 2);
    }
  }
  return null;
}

/** The size to draw an image at: within `max` each way, never enlarged, its shape kept. */
function fitWithin({ width, height }: Size, max = BANNER_MAX_SIZE): Size {
  const scale = Math.min(1, max / width, max / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * The format to keep an encoded banner in: WebP, unless the browser wrote
 * something else for it (one that can't encode WebP falls back to PNG),
 * when JPEG keeps it small instead.
 */
const bannerFormat = (written: string | undefined) => (written === 'image/webp' ? 'webp' : 'jpeg');

const toBlob = (canvas: HTMLCanvasElement, type: string) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));

/**
 * An image file made ready for a banner, before it is encrypted: scaled
 * down to `BANNER_MAX_SIZE` and encoded afresh as WebP (or JPEG), which
 * also drops whatever metadata the file carried, a location included.
 */
export async function bannerImage(
  file: Blob,
): Promise<{ name: string; mediaType: string; bytes: Uint8Array }> {
  if (file.size > BANNER_MAX_UPLOAD) throw new Error('Choose an image under 25 MB.');
  const declared = imageSize(new Uint8Array(await file.arrayBuffer()));
  if (!declared) throw new Error('Choose a PNG, JPEG, WebP or GIF image.');
  if (declared.width * declared.height > BANNER_MAX_PIXELS)
    throw new Error('Choose an image under 50 megapixels.');
  // Decoded in full, which the limit above bounds: resizing while decoding
  // would squash a photo that its EXIF orientation turns.
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That file isn’t an image this browser can open.');
  });
  try {
    const size = fitWithin(bitmap);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser can’t resize images.');
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const webp = await toBlob(canvas, 'image/webp');
    const format = bannerFormat(webp?.type);
    const encoded = format === 'webp' ? webp : await toBlob(canvas, 'image/jpeg');
    if (!encoded) throw new Error('This browser can’t resize images.');
    return {
      name: `Banner.${format === 'webp' ? 'webp' : 'jpg'}`,
      mediaType: `image/${format}`,
      bytes: new Uint8Array(await encoded.arrayBuffer()),
    };
  } finally {
    bitmap.close();
  }
}
