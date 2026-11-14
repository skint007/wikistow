// Screenshots (ADR 0017, decision 5, step 6): the browser's own of the
// visible area (`tabs.captureVisibleTab`), or the part of it the person
// dragged out over the page (area.ts), cut here, in the background, from
// the visible area's. The area is in the tab's CSS pixels; the image is in
// the screen's, so the cut is scaled by the two's ratio, measured from the
// image itself, which covers high-DPI screens and the browser's zoom alike.

/** A rectangle in the tab's CSS pixels, from its top left as shown, whatever it's scrolled. */
export type Area = { x: number; y: number; width: number; height: number };
/** The tab's size in CSS pixels as the area was chosen: `innerWidth` and `innerHeight`. */
export type ViewSize = { width: number; height: number };

/** What the overlay tells the background once the person has dragged out an area, or stopped. */
export type AreaMessage = {
  type: 'wikistow-area';
  nonce: string;
  /** Null when the person stopped, with Escape, or the overlay gave up waiting. */
  area: Area | null;
  view: ViewSize;
};

const finite = (value: unknown, min = 0): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min;

/** Whether `message` reads as an `AreaMessage`, every number in it a real one. */
export function isAreaMessage(message: unknown): message is AreaMessage {
  if (typeof message !== 'object' || message === null) return false;
  const { type, nonce, area, view } = message as Record<string, unknown>;
  if (type !== 'wikistow-area' || typeof nonce !== 'string' || nonce.length > 100) return false;
  if (typeof view !== 'object' || view === null) return false;
  const { width, height } = view as Record<string, unknown>;
  if (!finite(width, 1) || !finite(height, 1)) return false;
  if (area === null) return true;
  if (typeof area !== 'object') return false;
  const box = area as Record<string, unknown>;
  return finite(box['x']) && finite(box['y']) && finite(box['width']) && finite(box['height']);
}

/**
 * The image's pixels under `area`, chosen in a tab of `view`'s size: each
 * edge scaled by the image's pixels per CSS pixel, rounded to the nearest
 * pixel, and kept within the image. At least one pixel each way.
 */
export function cropBox(area: Area, view: ViewSize, image: { width: number; height: number }) {
  const perX = image.width / view.width;
  const perY = image.height / view.height;
  const clamp = (value: number, max: number) => Math.min(Math.max(Math.round(value), 0), max);
  const left = clamp(area.x * perX, image.width - 1);
  const top = clamp(area.y * perY, image.height - 1);
  const right = Math.max(clamp((area.x + area.width) * perX, image.width), left + 1);
  const bottom = Math.max(clamp((area.y + area.height) * perY, image.height), top + 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** A data URL's bytes, if it is base64 of `mediaType`. */
export function dataBytes(url: string, mediaType: string): Uint8Array | null {
  const prefix = `data:${mediaType};base64,`;
  if (!url.startsWith(prefix)) return null;
  const binary = atob(url.slice(prefix.length));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Bytes as standard base64, a chunk at a time, as an image can be tens of megabytes. */
export function base64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(binary);
}

/** The part of a PNG under `area`, as a PNG, cut in the background (`OffscreenCanvas`). */
export async function cropPng(png: Uint8Array, area: Area, view: ViewSize): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  try {
    const box = cropBox(area, view, bitmap);
    const canvas = new OffscreenCanvas(box.width, box.height);
    const drawn = canvas.getContext('2d');
    if (!drawn) throw new Error('No canvas to cut the screenshot on');
    drawn.drawImage(bitmap, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}
