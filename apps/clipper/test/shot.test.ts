// A screenshot's area is cut from the visible area's image in the
// screen's pixels, scaled from the tab's CSS pixels (shot.ts), and the
// overlay's message is taken only as it reads.
import { describe, expect, test } from 'vite-plus/test';
import { base64, cropBox, dataBytes, isAreaMessage } from '../src/shot.ts';

describe('cutting an area', () => {
  const view = { width: 1000, height: 800 };

  test('scales by the image’s pixels per CSS pixel: a high-DPI screen, or the browser’s zoom', () => {
    const area = { x: 100, y: 200, width: 300, height: 150 };
    expect(cropBox(area, view, { width: 1000, height: 800 })).toEqual(area);
    expect(cropBox(area, view, { width: 2000, height: 1600 })).toEqual({
      x: 200,
      y: 400,
      width: 600,
      height: 300,
    });
    // 125% on a 1.5 screen: 1.875 pixels to each CSS pixel, the edges rounded.
    expect(cropBox(area, view, { width: 1875, height: 1500 })).toEqual({
      x: 188,
      y: 375,
      width: 562,
      height: 281,
    });
  });

  test('stays within the image, and is at least a pixel', () => {
    expect(
      cropBox({ x: -50, y: 700, width: 2000, height: 500 }, view, { width: 1000, height: 800 }),
    ).toEqual({ x: 0, y: 700, width: 1000, height: 100 });
    expect(
      cropBox({ x: 1000, y: 800, width: 0, height: 0 }, view, { width: 1000, height: 800 }),
    ).toEqual({ x: 999, y: 799, width: 1, height: 1 });
  });
});

describe('the overlay’s message', () => {
  const message = {
    type: 'wikistow-area',
    nonce: 'n',
    area: { x: 1, y: 2, width: 3, height: 4 },
    view: { width: 10, height: 10 },
  };

  test('is taken only as it reads', () => {
    expect(isAreaMessage(message)).toBe(true);
    expect(isAreaMessage({ ...message, area: null })).toBe(true);
    for (const wrong of [
      null,
      'wikistow-area',
      { ...message, type: 'other' },
      { ...message, nonce: 1 },
      { ...message, nonce: 'n'.repeat(101) },
      { ...message, view: { width: 0, height: 10 } },
      { ...message, view: undefined },
      { ...message, area: { ...message.area, x: Number.NaN } },
      { ...message, area: { ...message.area, width: -1 } },
      { ...message, area: { ...message.area, y: '2' } },
      { ...message, area: { ...message.area, height: Infinity } },
    ]) {
      expect(isAreaMessage(wrong)).toBe(false);
    }
  });
});

describe('a screenshot’s bytes', () => {
  test('come from a data URL of the type asked for, and go back as base64', () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 256);
    const encoded = base64(bytes);
    expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
    expect(dataBytes(`data:image/png;base64,${encoded}`, 'image/png')).toEqual(bytes);
    expect(dataBytes(`data:image/jpeg;base64,${encoded}`, 'image/png')).toBeNull();
  });
});
