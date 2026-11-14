// Saving a clip from the browser as a draft (ADR 0017, decision 5), with
// the page writer's steps, so a clip made offline waits in the queue with
// its images as any new page does: the page with its text first, its
// images' links pointing at their sites (`newPageDraft`), then each image
// main fetched attached to it (`attach`), then the text pointing at them
// (`draft`). A clip that stops partway still leaves its text.
import {
  ApiError,
  newPayload,
  PageTooLarge,
  linkSpans,
  type AttachmentRef,
  type LinkSpans,
  type PageId,
  type SpaceId,
  type PageWriter,
  type RevisionId,
} from '@wikistow/client';
import type { ClipImage, ClipOutcome, DesktopClip } from '@wikistow/contracts';
import {
  clipFrontmatter,
  clipParts,
  clipTitle,
  fitsPage,
  imageName,
  mayFit,
  planImages,
} from './clip-page';
import { samePlace, type ClipPlace } from './clip-places';

/** HTML and its text as the Markdown pasting them writes (`htmlMarkdown`). */
export type Convert = (
  html: string,
  text: string,
) => Promise<{ markdown: string; faithful: boolean }>;

/** Where the person can make pages now, and the spaces whose trees couldn't be read, as offline. */
export type Places = { places: ClipPlace[]; unread: ReadonlySet<string> };

export type SaveClipDeps = {
  writer: PageWriter;
  places: () => Promise<Places>;
  convert: Convert;
  /** Where the Markdown's links are (`linkSpans`), as the app reads it, in a worker. */
  spans?: (markdown: string) => Promise<LinkSpans>;
  /** Tell main the clip's page is made, so a reload finishes it rather than making another. */
  made?: (page: { spaceId: SpaceId; pageId: PageId; path: string }) => Promise<void>;
  /** Main's fetch of one of the clip's images (`DesktopBridge.clipImage`). */
  image: (url: string) => Promise<ClipImage>;
  /** Today, as `clipped` says it. */
  today: string;
  /**
   * For a clip that waited, whose folder can't take it any more: where the
   * person puts it instead, or null if they let it go.
   */
  choose: (clip: DesktopClip, title: string) => Promise<ClipPlace | null>;
};

/** How saving went, and where it went. */
export type Saved = { outcome: ClipOutcome; place: ClipPlace | null };

const failed = (code: Exclude<ClipOutcome, { ok: true }>['code'], message: string): Saved => ({
  outcome: { ok: false, code, message },
  place: null,
});

const TOO_LONG =
  'This is too long for one page. Try Article, or select part of it and clip the selection.';

const savedTo = (path: readonly string[]) => path.join(' / ');

/** Save `clip` as a new draft. Never throws: a failure is an outcome, said in the app's words. */
export async function saveClip(clip: DesktopClip, deps: SaveClipDeps): Promise<Saved> {
  const title = clipTitle(clip);
  // Made before a reload cut it short: its text is saved, so it's done.
  if (clip.made) {
    const { spaceId, pageId, path } = clip.made;
    return {
      outcome: {
        ok: true,
        spaceId,
        pageId,
        title,
        path,
        images: { saved: 0, skipped: 0 },
        faithful: true,
      },
      place: null,
    };
  }
  let place: ClipPlace | null;
  try {
    const { places, unread } = await deps.places();
    place = places.find((one) => samePlace(one, clip.folder)) ?? null;
    // A space not kept for offline: its folder can't be checked here, so
    // the page waits on this device, and the server checks it once sent.
    if (!place && unread.has(clip.folder.spaceId)) place = { ...clip.folder, path: [] };
    if (!place && clip.waited) place = await deps.choose(clip, title);
  } catch {
    return failed('failed', 'WikiStow couldn’t load your folders.');
  }
  if (!place) {
    return clip.waited
      ? failed('no-folder', 'The clip wasn’t saved: no folder was chosen.')
      : failed('no-folder', 'That folder is gone, or you can’t add pages to it. Choose another.');
  }

  let body = '';
  let faithful = true;
  try {
    for (const part of clipParts(clip)) {
      const written = await deps.convert(part.html, part.text);
      if (!written.markdown.trim()) continue;
      body += (body ? '\n' : '') + written.markdown;
      faithful &&= written.faithful;
    }
  } catch {
    return failed('failed', 'WikiStow couldn’t read this clip.');
  }
  let markdown: string;
  try {
    markdown = clipFrontmatter(clip, deps.today) + body;
  } catch {
    return failed('failed', 'This clip’s address or tags can’t be written as its properties.');
  }
  if (!mayFit(markdown)) return failed('too-large', TOO_LONG);
  let plan: ReturnType<typeof planImages>;
  try {
    plan = planImages(markdown, await (deps.spans ?? (async (text) => linkSpans(text)))(markdown));
  } catch {
    return failed('too-large', TOO_LONG);
  }
  const first = plan.written(new Map());
  if (!fitsPage(first)) return failed('too-large', TOO_LONG);

  const { spaceId, folderId } = place;
  let made: { pageId: PageId; revisionId: RevisionId };
  try {
    made = await deps.writer.newPageDraft({
      spaceId,
      parentId: folderId,
      title,
      markdown: first,
    });
  } catch (error) {
    if (error instanceof PageTooLarge) return failed('too-large', TOO_LONG);
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      return failed('not-allowed', 'You can’t add pages to that folder any more. Choose another.');
    }
    return failed('failed', 'WikiStow couldn’t save the clip. Try again.');
  }
  const page = { spaceId, pageId: made.pageId };
  await deps.made?.({ spaceId, pageId: made.pageId, path: savedTo(place.path) }).catch(() => {});

  // Images, one at a time, each kept only once attached.
  const attached = new Map<string, string>();
  const refs: AttachmentRef[] = [];
  for (const url of plan.fitsAttached ? plan.fetch : []) {
    const image = await deps.image(url).catch((): ClipImage => ({ ok: false, reason: 'failed' }));
    if (!image.ok) continue;
    try {
      const ref = await deps.writer.attach(page, {
        name: imageName(url, image.mediaType),
        mediaType: image.mediaType,
        bytes: image.bytes,
      });
      attached.set(url, ref.id);
      refs.push(ref);
    } catch {
      // Over the server's upload limit, say: it stays a link.
    }
  }
  if (refs.length > 0) {
    try {
      const drafts = deps.writer.draft(page, { seen: null });
      const basedOn = (await drafts.waitingHead()) ?? made.revisionId;
      await drafts.save({
        basedOn,
        payload: { ...newPayload({ title, markdown: plan.written(attached) }), attachments: refs },
      });
    } catch {
      // The page keeps its text, its images as links.
      attached.clear();
      refs.length = 0;
    }
  }
  return {
    outcome: {
      ok: true,
      spaceId,
      pageId: made.pageId,
      title,
      path: savedTo(place.path),
      images: { saved: refs.length, skipped: plan.count - refs.length },
      faithful,
    },
    place,
  };
}
