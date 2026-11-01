import type { publicLinkOperations } from '@wikistow/client';
import { DIAGRAM_HOST_PAGE } from '@wikistow/contracts';

/** How long one diagram may take to draw before the frame is replaced. */
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
 * The hidden `sandbox="allow-scripts"` frame that draws Mermaid diagrams
 * (ADR 0010). Mermaid needs a document to measure text in and writes
 * styles the app's policy refuses, so it runs there, at an opaque origin
 * with no requests allowed, and hands back each diagram as SVG text. The
 * frame is laid out off screen, not hidden, so text has a size. It is
 * made for the first diagram, which is when Mermaid loads, and removed
 * once idle, or if a diagram takes too long.
 */
class DiagramFrame {
  readonly #iframe = document.createElement('iframe');
  #ready = false;
  readonly #queue: { id: number; source: string; dark: boolean }[] = [];
  readonly #waiting = new Map<number, Waiting>();
  #next = 0;
  #idle: ReturnType<typeof setTimeout> | undefined;
  readonly #listen = (event: MessageEvent<unknown>) => {
    if (event.source !== this.#iframe.contentWindow || !isFrameMessage(event.data)) return;
    const message = event.data;
    if (message.type === 'ready') {
      this.#ready = true;
      for (const queued of this.#queue.splice(0)) this.#post(queued);
      return;
    }
    const waiting = this.#waiting.get(message.id);
    this.#waiting.delete(message.id);
    if (message.type === 'rendered') waiting?.resolve(message.svg);
    else waiting?.reject(new DiagramError(message.error));
    this.#settle();
  };

  constructor() {
    this.#iframe.setAttribute('sandbox', 'allow-scripts');
    this.#iframe.setAttribute('aria-hidden', 'true');
    this.#iframe.tabIndex = -1;
    this.#iframe.className = 'invisible fixed top-0 -left-[10000px] h-[1000px] w-[1000px]';
    this.#iframe.src = DIAGRAM_HOST_PAGE;
    window.addEventListener('message', this.#listen);
    document.body.append(this.#iframe);
  }

  draw(source: string, dark: boolean): Promise<string> {
    clearTimeout(this.#idle);
    const id = this.#next++;
    const drawn = new Promise<string>((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject });
    });
    if (this.#ready) this.#post({ id, source, dark });
    else this.#queue.push({ id, source, dark });
    return drawn;
  }

  #post(message: { id: number; source: string; dark: boolean }) {
    this.#iframe.contentWindow?.postMessage({ type: 'render', ...message }, '*');
  }

  /** Nothing left to draw: removed after a while. */
  #settle() {
    if (this.#waiting.size > 0) return;
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.remove(), IDLE_MS);
  }

  /** Removed, failing whatever it hadn't drawn. */
  remove(reason = 'The diagram couldn’t be drawn.') {
    clearTimeout(this.#idle);
    window.removeEventListener('message', this.#listen);
    this.#iframe.remove();
    for (const { reject } of this.#waiting.values()) reject(new DiagramError(reason));
    this.#waiting.clear();
    if (frame === this) frame = null;
  }
}

let frame: DiagramFrame | null = null;

/**
 * Draw the Mermaid diagram `source`, in its dark theme if `dark`: its SVG
 * text, sized to its own width and height, for an image (`diagramUrl`).
 * Rejects with a `DiagramError` saying why it didn't draw.
 */
export function drawDiagram(source: string, dark: boolean): Promise<string> {
  const drawing = (frame ??= new DiagramFrame());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      drawing.remove('The diagram took too long to draw.');
      reject(new DiagramError('The diagram took too long to draw.'));
    }, DRAW_MS);
  });
  return Promise.race([drawing.draw(source, dark), late]).finally(() => clearTimeout(timer));
}

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
    url = diagramUrl(await drawDiagram(source, false));
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
