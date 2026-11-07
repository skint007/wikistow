import type { publicLinkOperations } from '@wikistow/client';
import { DIAGRAM_HOST_PAGE } from '@wikistow/contracts';
import type { ThemeToken } from '@wikistow/plugin-sdk';
import { vaultStore } from '../vault/store';

/** How long Mermaid may take to load in a new frame, a 5.5 MB file on a slow line. */
const LOAD_MS = 120_000;
/** How long the frame may take over one diagram before it is replaced. */
const DRAW_MS = 10_000;
/** How long the frame stays once nothing is being drawn, so Mermaid isn't kept loaded. */
const IDLE_MS = 60_000;

/** What the frame says to the app (see `apps/web/public/diagram-host.js`). */
type FrameMessage =
  | { type: 'ready' }
  | { type: 'rendered'; id: number; svg: string }
  | { type: 'failed'; id: number; error: string };

const isFrameMessage = (data: unknown): data is FrameMessage =>
  typeof data === 'object' &&
  data !== null &&
  'type' in data &&
  (data.type === 'ready' ||
    (data.type === 'rendered' && 'id' in data && 'svg' in data && typeof data.svg === 'string') ||
    (data.type === 'failed' && 'id' in data && 'error' in data && typeof data.error === 'string'));

/** A diagram that didn't draw, with Mermaid's reason, or that it took too long. */
export class DiagramError extends Error {}

type Waiting = { resolve: (svg: string) => void; reject: (error: Error) => void };

/**
 * Mermaid's theme variables (its `base` theme) a diagram takes from the
 * theme's tokens. Mermaid works out its other colours from these.
 */
const VARIABLES = {
  // The code block the diagram is drawn on.
  background: '--muted',
  primaryColor: '--primary-soft',
  primaryBorderColor: '--primary',
  primaryTextColor: '--foreground',
  secondaryColor: '--card',
  tertiaryColor: '--background',
  textColor: '--foreground',
  lineColor: '--muted-foreground',
  noteBkgColor: '--note',
  noteTextColor: '--note-foreground',
  noteBorderColor: '--border',
} as const satisfies Record<string, ThemeToken>;

/**
 * The colours a diagram is drawn in: `VARIABLES` as the theme shown sets
 * them, and whether it is dark. Null is Mermaid's own light theme, as a
 * public copy shows it.
 */
export type DiagramLook = {
  dark: boolean;
  variables: Record<keyof typeof VARIABLES, string>;
} | null;

let pixel: CanvasRenderingContext2D | null = null;

/**
 * `colours` painted in turn over white, as one colour in hex: Mermaid reads
 * only plain colours, and works out shades no translucent one could have.
 * One the canvas can't read paints nothing.
 */
function painted(colours: string[]) {
  if (!pixel) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    pixel = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!pixel) return '#ffffff';
  pixel.fillStyle = '#ffffff';
  pixel.fillRect(0, 0, 1, 1);
  for (const colour of colours) {
    pixel.fillStyle = 'transparent';
    pixel.fillStyle = colour;
    pixel.fillRect(0, 0, 1, 1);
  }
  const rgb = pixel.getImageData(0, 0, 1, 1).data.subarray(0, 3);
  return `#${Array.from(rgb, (n) => n.toString(16).padStart(2, '0')).join('')}`;
}

let shown: { key: string; look: DiagramLook } | null = null;

/**
 * The look of the theme shown, the same object until a token it reads
 * changes. Each colour is painted over the code block's, on the page card.
 */
export function diagramLook(): DiagramLook {
  const style = getComputedStyle(document.documentElement);
  const token = (name: ThemeToken) => style.getPropertyValue(name).trim();
  const dark = style.colorScheme === 'dark';
  const ground = [token('--card'), token('--muted')];
  const key = JSON.stringify([dark, ground, Object.values(VARIABLES).map(token)]);
  if (shown?.key !== key) {
    const entries = Object.entries(VARIABLES).map(([name, from]) => [
      name,
      painted([...ground, token(from)]),
    ]);
    shown = { key, look: { dark, variables: Object.fromEntries(entries) } };
  }
  return shown.look;
}

/**
 * The hidden `sandbox="allow-scripts"` frame that draws Mermaid diagrams
 * (ADR 0010). Mermaid needs a document to measure text in and writes
 * styles the app's policy refuses, so it runs there, at an opaque origin
 * with no requests allowed, and hands back each diagram as SVG text. The
 * frame is laid out off screen, not hidden, so text has a size. It is
 * made for the first diagram, which is when Mermaid loads, and removed
 * once idle, when the vault locks, or if it doesn't load or takes too
 * long over a diagram, failing those it hadn't drawn.
 */
class DiagramFrame {
  readonly #iframe = document.createElement('iframe');
  #ready = false;
  readonly #queue: { id: number; source: string; look: DiagramLook }[] = [];
  readonly #waiting = new Map<number, Waiting>();
  #next = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #listen = (event: MessageEvent<unknown>) => {
    if (event.source !== this.#iframe.contentWindow || !isFrameMessage(event.data)) return;
    const message = event.data;
    if (message.type === 'ready') {
      this.#ready = true;
      for (const queued of this.#queue.splice(0)) this.#post(queued);
    } else {
      const waiting = this.#waiting.get(message.id);
      this.#waiting.delete(message.id);
      if (message.type === 'rendered') waiting?.resolve(message.svg);
      else waiting?.reject(new DiagramError(message.error));
    }
    this.#arm();
  };

  constructor() {
    this.#iframe.setAttribute('sandbox', 'allow-scripts');
    this.#iframe.setAttribute('aria-hidden', 'true');
    this.#iframe.tabIndex = -1;
    this.#iframe.className = 'invisible fixed top-0 -left-[10000px] h-[1000px] w-[1000px]';
    this.#iframe.src = DIAGRAM_HOST_PAGE;
    window.addEventListener('message', this.#listen);
    document.body.append(this.#iframe);
    this.#arm();
  }

  draw(source: string, look: DiagramLook): Promise<string> {
    const id = this.#next++;
    const drawn = new Promise<string>((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject });
    });
    if (!this.#ready) this.#queue.push({ id, source, look });
    else {
      this.#post({ id, source, look });
      // The frame draws one at a time: one already going keeps its time.
      if (this.#waiting.size === 1) this.#arm();
    }
    return drawn;
  }

  #post(message: { id: number; source: string; look: DiagramLook }) {
    this.#iframe.contentWindow?.postMessage({ type: 'render', ...message }, '*');
  }

  /**
   * Time what the frame is doing now: loading, the diagram it is on, from
   * when it started it, or nothing, before it goes.
   */
  #arm() {
    clearTimeout(this.#timer);
    if (!this.#ready) {
      this.#timer = setTimeout(() => this.remove('Mermaid didn’t load.'), LOAD_MS);
    } else if (this.#waiting.size > 0) {
      this.#timer = setTimeout(() => this.remove('The diagram took too long to draw.'), DRAW_MS);
    } else {
      this.#timer = setTimeout(() => this.remove(), IDLE_MS);
    }
  }

  /** Removed, failing whatever it hadn't drawn with `reason`. */
  remove(reason = 'The diagram couldn’t be drawn.') {
    clearTimeout(this.#timer);
    window.removeEventListener('message', this.#listen);
    this.#iframe.remove();
    for (const { reject } of this.#waiting.values()) reject(new DiagramError(reason));
    this.#waiting.clear();
    if (frame === this) frame = null;
  }
}

let frame: DiagramFrame | null = null;

// Removed when the vault locks, so no page's diagram outlives the keys.
vaultStore.subscribe(() => {
  if (vaultStore.get().status === 'locked') frame?.remove('The vault is locked.');
});

/**
 * Draw the Mermaid diagram `source` in `look`'s colours: its SVG text,
 * sized to its own width and height, for an image (`diagramUrl`). Rejects
 * with a `DiagramError` saying why it didn't draw.
 */
export const drawDiagram = (source: string, look: DiagramLook): Promise<string> =>
  (frame ??= new DiagramFrame()).draw(source, look);

/** A diagram's SVG as an image's address. Revoke it when the image goes. */
export const diagramUrl = (svg: string) =>
  URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));

/** Each pixel of a diagram drawn as a PNG, so it is sharp on a dense screen. */
const PNG_SCALE = 2;

/**
 * The diagram `source` as a PNG, in the light theme on a white ground, as
 * a public copy shows it (ADR 0010), and the width it shows at; or null if
 * it doesn't draw.
 */
export async function diagramPng(
  source: string,
): Promise<publicLinkOperations.DrawnDiagram | null> {
  let url: string | undefined;
  try {
    url = diagramUrl(await drawDiagram(source, null));
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(image.naturalWidth * PNG_SCALE);
    canvas.height = Math.ceil(image.naturalHeight * PNG_SCALE);
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    return png ? { png: new Uint8Array(await png.arrayBuffer()), width: image.naturalWidth } : null;
  } catch {
    return null;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}
