import { CryptoError, PageTooLarge } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { errorMessage } from '../errors';
import { sharingMessage } from '../sharing/messages';

// The server's refusals of a move. A move is all or nothing, so a refusal
// always means nothing moved.
const MOVE_REFUSED: Partial<Record<ApiError['code'], string>> = {
  'stale-head':
    'It moved, or something in it changed, since you looked, so nothing moved. Look at the move again.',
  'permission-version':
    'Who has access here changed while you were looking, so nothing moved. Look at the move again.',
  'key-version': 'The folder’s keys changed while you were looking, so nothing moved. Try again.',
  forbidden:
    'You can’t move it there, so nothing moved. You need to be able to edit where it is and where it goes, and only an owner of the space moves things into or out of a shared folder.',
  'share-nesting': 'A shared folder can’t go inside another shared folder, so nothing moved.',
  'too-deep': 'That would put something more than 256 folders deep, so nothing moved.',
  'not-found': 'That page or folder, or where it was going, isn’t there any more.',
  'binding-mismatch':
    'The server turned the move down as not matching what is there, so nothing moved. Look at the move again.',
};

// A move across a share carries new keys for every saved version, so a big one can't go at once.
const TOO_BIG = {
  folder:
    'This folder has too many saved versions to move across a share at once, so nothing moved. Move its subfolders one at a time instead.',
  page: 'This page has too many saved versions to move across a share at once, so nothing moved.',
};

// What this app refused before sending a move.
const MOVE_STOPPED: Partial<Record<CryptoError['code'], string>> = {
  // Honest changes meanwhile come back as stale-head, so this one is unexplained.
  'binding-mismatch':
    'What the server sent doesn’t match what you were shown, and its own list of what’s here doesn’t explain why, so nothing moved. This could be an attack.',
  'region-mismatch':
    'The server says this is somewhere other than where this app found it, so nothing moved. This could be an attack.',
};

/** A short message for a failed move of a folder or page: this app's own words, never the server's. */
export function moveMessage(error: unknown, kind: 'folder' | 'page'): string {
  if (error instanceof ApiError && error.code === 'payload-too-large') return TOO_BIG[kind];
  if (error instanceof ApiError) return MOVE_REFUSED[error.code] ?? sharingMessage(error);
  if (error instanceof CryptoError) return MOVE_STOPPED[error.code] ?? sharingMessage(error);
  return sharingMessage(error);
}

/**
 * The pages a copy's refusal names, by source ID, or null for any other
 * failure: pages published here from other pages, which their publishers
 * detach first (ADR 0007, decision 3), or pages with neither a draft nor a
 * published version, which have nothing to copy. Both are `forbidden`;
 * the source's tree tells them apart (`PagesRefused`).
 */
export function namedPages(error: unknown): string[] | null {
  if (!(error instanceof ApiError) || error.code !== 'forbidden') return null;
  const nodeIds = error.detail?.nodeIds;
  return nodeIds && nodeIds.length > 0 ? nodeIds : null;
}

/** A copy refused for the pages it names (`namedPages`), and why. */
export class PagesRefused extends Error {
  readonly reason: 'published-elsewhere' | 'nothing-to-copy';
  readonly pageIds: string[];
  constructor(reason: PagesRefused['reason'], pageIds: string[]) {
    super(reason);
    this.name = 'PagesRefused';
    this.reason = reason;
    this.pageIds = pageIds;
  }
}

// A copy or move between spaces is undone in full when it fails: the
// server, or the app, deletes what it made. The words differ only in the verb.
const copyRefused = (
  nothing: string,
): Partial<Record<ApiError['code'] | CryptoError['code'], string>> => ({
  'stale-head': `Something in it changed while it was going, so ${nothing}. Look at it again.`,
  'permission-version': `Who has access changed while you were looking, so ${nothing}. Look at it again.`,
  'key-version': `The keys where it was going changed meanwhile, so ${nothing}. Look at it again.`,
  'not-found': `That page or folder, or where it was going, isn’t there any more, so ${nothing}.`,
  'binding-mismatch': `It can’t go inside itself, so ${nothing}.`,
  'too-deep': `That would put something more than 256 folders deep, so ${nothing}.`,
  'page-limit': `That would make more pages than your account may have, so ${nothing}.`,
  'folder-limit': `That would make more folders than your account may have, so ${nothing}.`,
  'storage-full': `Your storage is full, so ${nothing}. Free up some space, or ask your administrator for more.`,
  'missing-blob': `An attachment didn’t arrive, so ${nothing}. Try again.`,
  'rate-limited': `The server is busy, so ${nothing}. Try again in a moment.`,
  'region-mismatch': `The server says that place is somewhere other than where this app found it, so ${nothing}. This could be an attack.`,
  'missing-key': `This app can’t open something in it, so ${nothing}.`,
  'unsupported-format': `Something in it was saved by a newer version of WikiStow, so ${nothing}. Update the app to copy it.`,
});
const COPY_REFUSED = copyRefused('nothing was copied');
const MOVE_ACROSS_REFUSED = copyRefused('nothing moved');

/**
 * A short message for a failed copy, or move into another space (`copy`
 * false): this app's own words, never the server's. A refusal for the
 * pages it names (`PagesRefused`) is said here; the dialog lists them.
 */
export function copyMessage(error: unknown, copy: boolean): string {
  const nothing = copy ? 'nothing was copied' : 'nothing moved';
  if (error instanceof PagesRefused) {
    return error.reason === 'published-elsewhere'
      ? `Some pages in it were published here from other pages, so ${nothing}. Someone who can publish each one detaches it first, with Detach to edit…`
      : `Some pages in it have neither a draft nor a published version, so ${nothing}. Someone who can publish each one publishes or restores a version of it first.`;
  }
  if (error instanceof ApiError && error.code === 'forbidden') {
    return copy
      ? 'You can’t copy it there, so nothing was copied. You need to be able to edit everything in it, and to make pages where it goes.'
      : 'You can’t move it there, so nothing moved. Only an owner of this space moves things into another space, and they need to be able to make pages where it goes.';
  }
  if (error instanceof PageTooLarge) {
    return `${error.message} ${copy ? 'Nothing was copied.' : 'Nothing moved.'}`;
  }
  const refused = copy ? COPY_REFUSED : MOVE_ACROSS_REFUSED;
  if (error instanceof ApiError || error instanceof CryptoError) {
    return refused[error.code] ?? sharingMessage(error);
  }
  return sharingMessage(error);
}

const UNPUBLISH_REFUSED: Partial<Record<ApiError['code'], string>> = {
  'stale-head':
    'Someone published or unpublished this page since you opened it, so nothing changed. Look again.',
  'permission-version':
    'Who has access to this page changed since you opened it, so nothing changed. Look again.',
  forbidden: 'Only someone who can publish here can unpublish this page.',
  'not-found': 'This page isn’t there any more.',
};

/** A short message for a failed unpublish. */
export function unpublishMessage(error: unknown): string {
  if (error instanceof ApiError) return UNPUBLISH_REFUSED[error.code] ?? sharingMessage(error);
  return sharingMessage(error);
}

// The server's refusals of a publication into another space. Each request
// is all or nothing; one that opened the destination leaves nothing anyone
// sees, and the next try picks it up.
const PUBLICATION_REFUSED: Partial<Record<ApiError['code'], string>> = {
  'stale-head':
    'Someone published this page there since you looked, so nothing was published. Look again.',
  'permission-version':
    'Who can read it there changed since you looked, so nothing was published. Look again.',
  'key-version': 'The folder’s keys there changed while you were looking. Try again.',
  forbidden:
    'You can’t publish it there, so nothing was published. You need to be able to publish where it goes, and to send a draft, or a version readers here no longer see, you need to be able to publish this page too.',
  'not-found':
    'This version, or where it was going, isn’t there any more, or you can no longer read it. Look again.',
  'too-deep': 'That would put the page more than 256 folders deep, so nothing was published.',
  'storage-full':
    'Your storage is full, so nothing was published. Free up some space, or ask your administrator for more.',
  'missing-blob': 'An attachment didn’t arrive, so nothing was published. Try again.',
  // Someone held the source page, as a delete or draft retention does.
  'rate-limited':
    'Someone is changing the source page, so nothing was published. Try again in a moment.',
};

// What this app refused before publishing anything.
const PUBLICATION_STOPPED: Partial<Record<CryptoError['code'], string>> = {
  'binding-mismatch':
    'What the server says this page was published to there doesn’t match that page, so nothing was published. This could be an attack.',
  'region-mismatch':
    'The server says that place is somewhere other than where this app found it, so nothing was published. This could be an attack.',
  'unsupported-format':
    'This version was saved by a newer version of WikiStow. Update the app to publish it.',
};

/** A short message for a failed publication into another space. */
export function publicationMessage(error: unknown): string {
  if (error instanceof PageTooLarge) return `${error.message} Nothing was published.`;
  if (error instanceof ApiError) return PUBLICATION_REFUSED[error.code] ?? sharingMessage(error);
  if (error instanceof CryptoError) return PUBLICATION_STOPPED[error.code] ?? sharingMessage(error);
  return sharingMessage(error);
}

const END_REFUSED: Partial<Record<ApiError['code'], string>> = {
  forbidden:
    'Only someone who can publish this page can end its copies, and you no longer can, so nothing changed.',
  'not-found': 'This page isn’t there any more, or you can no longer see it.',
};

/** A short message for a failed end of a page's copy in another space. */
export function endMessage(error: unknown): string {
  if (error instanceof ApiError) return END_REFUSED[error.code] ?? sharingMessage(error);
  return sharingMessage(error);
}

const DETACH_REFUSED: Partial<Record<ApiError['code'], string>> = {
  'stale-head': 'This page was detached or changed meanwhile, so nothing changed. Look again.',
  'permission-version':
    'Who has access to this page changed since you opened it, so nothing changed. Look again.',
  forbidden: 'Only someone who can publish here can detach this page.',
  'not-found': 'This page isn’t published from another page any more.',
};

/** A short message for a failed detach. */
export function detachMessage(error: unknown): string {
  if (error instanceof PageTooLarge) return `${error.message} Nothing changed.`;
  if (error instanceof ApiError) return DETACH_REFUSED[error.code] ?? sharingMessage(error);
  return sharingMessage(error);
}

/**
 * A short message for a failed attachment upload. The server answers
 * `rate-limited` when too many uploads run at once or come within a minute,
 * neither of them about attempts, and both clear soon.
 */
export function uploadMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'rate-limited')
    return 'The server is busy with other uploads, so this one didn’t go. Wait a moment and try again.';
  return errorMessage(error);
}

const PUBLIC_LINK_REFUSED: Partial<Record<ApiError['code'], string>> = {
  // Also what an upload gets when the page was published again partway.
  'not-found': 'The page or its public link changed meanwhile. Look again.',
  forbidden: 'Only someone who can publish this page can share it with a public link.',
  'stale-head': 'The page was published again meanwhile. Try again.',
  'payload-too-large': 'The page is too large for a public link.',
  'storage-full':
    'Your storage is full, so the public page wasn’t uploaded. Free up some space, or ask your administrator for more.',
  'request-timeout': 'The server took too long to answer. Look again before you try again.',
  'missing-blob': 'A file didn’t reach the server, so the public page wasn’t uploaded. Try again.',
};

/** A short message for a public link that failed to turn on, off, or update. */
export function publicLinkMessage(error: unknown): string {
  if (error instanceof ApiError) return PUBLIC_LINK_REFUSED[error.code] ?? errorMessage(error);
  if (error instanceof CryptoError && error.code === 'unsupported-format') {
    return 'This page was published by a newer version of WikiStow. Update the app to share it.';
  }
  return errorMessage(error);
}
