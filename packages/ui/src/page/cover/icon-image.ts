import { ICON_MAX_BYTES, type IconMediaType } from '@wikistow/client';
import {
  BANNER_MAX_PIXELS,
  BANNER_MAX_UPLOAD,
  fitWithin,
  imageSize,
  toBlob,
  type Size,
} from './banner-image';

/** The largest icon kept, in pixels, each way: twice the 72 px page badge. */
export const ICON_SIZE = 144;

// Tried when the image at full size is over ICON_MAX_BYTES.
const SMALLER_SIZE = 96;

/** The files the Image tab offers. */
export const ICON_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';

const SVG_REFUSED = 'That SVG can’t be used. Try a PNG, or another SVG.';

// An `<img>` draws an SVG without running its scripts or loading what it links to.
async function svgImage(file: Blob) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } catch {
    throw new Error('That file isn’t an image this browser can open.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

// An SVG is drawn to fill ICON_SIZE whatever size it declares, since icon
// sets declare 24 px and browsers make one up for an SVG that declares none.
function fitSvg({ width, height }: Size, max: number): Size {
  if (!(width > 0 && height > 0)) return { width: max, height: max };
  const scale = max / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

const opaque = (context: CanvasRenderingContext2D, { width, height }: Size) => {
  const { data } = context.getImageData(0, 0, width, height);
  for (let at = 3; at < data.length; at += 4) if (data[at] !== 255) return false;
  return true;
};

/**
 * Encode the image at `size`: WebP, or where the browser can't write it,
 * JPEG for an opaque image and PNG for one with transparency, so a logo
 * keeps its clear background on the folder's tint.
 */
async function encode(source: CanvasImageSource, size: Size, svg: boolean) {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser can’t resize images.');
  context.drawImage(source, 0, 0, size.width, size.height);
  try {
    const webp = await toBlob(canvas, 'image/webp');
    if (webp?.type === 'image/webp') return { mediaType: 'image/webp' as const, blob: webp };
    const mediaType = opaque(context, size) ? ('image/jpeg' as const) : ('image/png' as const);
    return { mediaType, blob: await toBlob(canvas, mediaType) };
  } catch (error) {
    // Chromium and WebKit refuse to export a canvas an SVG with <foreignObject> drew on.
    if (svg && error instanceof DOMException && error.name === 'SecurityError') {
      throw new Error(SVG_REFUSED);
    }
    throw error;
  }
}

/**
 * An image file made ready for an icon, before it is stored: drawn to fit
 * `ICON_SIZE`, its shape kept, and encoded afresh, which drops whatever
 * metadata the file carried. An SVG is drawn as pixels, never kept as SVG.
 * Throws a message to show for a file it can't use.
 */
export async function iconImage(
  file: Blob,
): Promise<{ name: string; mediaType: IconMediaType; bytes: Uint8Array }> {
  if (file.size > BANNER_MAX_UPLOAD) throw new Error('Choose an image under 25 MB.');
  const declared = imageSize(new Uint8Array(await file.arrayBuffer()));
  const svg = !declared && file.type === 'image/svg+xml';
  if (!declared && !svg) throw new Error('Choose a PNG, JPEG, WebP, GIF or SVG image.');
  if (declared && declared.width * declared.height > BANNER_MAX_PIXELS)
    throw new Error('Choose an image under 50 megapixels.');
  // createImageBitmap refuses SVG in every engine, so SVG goes through an <img>.
  const source = svg
    ? await svgImage(file)
    : await createImageBitmap(file).catch(() => {
        throw new Error('That file isn’t an image this browser can open.');
      });
  try {
    const natural =
      source instanceof HTMLImageElement
        ? { width: source.naturalWidth, height: source.naturalHeight }
        : source;
    for (const max of [ICON_SIZE, SMALLER_SIZE]) {
      const size = svg ? fitSvg(natural, max) : fitWithin(natural, max);
      const { mediaType, blob } = await encode(source, size, svg);
      if (!blob) throw new Error('This browser can’t resize images.');
      if (blob.size <= ICON_MAX_BYTES) {
        const extension = mediaType.slice('image/'.length).replace('jpeg', 'jpg');
        return {
          name: `Icon.${extension}`,
          mediaType,
          bytes: new Uint8Array(await blob.arrayBuffer()),
        };
      }
    }
    throw new Error('That image has too much detail for an icon. Try a simpler one.');
  } finally {
    if (source instanceof ImageBitmap) source.close();
  }
}
