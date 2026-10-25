import type { AttachmentRef } from '@wikistow/client';
import type { PluginRuntime } from '../../../plugins/runtime';
import type { AttachmentAssist, LinkAssist } from '../surface';
import type { QueryResults } from './query-results';

/**
 * What the visual editor's node views know of the page, always the latest:
 * the session's link help and attachments. Views that show either redraw
 * when they change.
 */
export type VisualHost = {
  links(): LinkAssist;
  attachments(): AttachmentAssist;
  /** Views showing what `links` or `attachments` say, redrawn when those change. */
  readonly live: Set<{ redraw(): void }>;
  /** The page edited, or null in an editor nobody sees, which draws no plugin blocks. */
  page(): { spaceId: string; pageId: string } | null;
  /** The plugins whose blocks it draws: the app's, or the workshop's in its preview. */
  plugins(): PluginRuntime | null;
  /** Where query blocks' results go, which the surface draws; none where nobody sees them. */
  queries?: QueryResults;
};

/** A host for an editor nobody sees, such as the fidelity check's: no pages, no attachments. */
export const inertHost = (): VisualHost => ({
  links: () => ({
    pages: null,
    targets: () => null,
    selfId: '',
    table: new Map(),
    headings: async () => [],
    ownHeadings: async () => [],
    create: () => {},
    pick: () => {},
    choose: () => {},
  }),
  attachments: () => ({ list: [], url: async () => null }),
  live: new Set(),
  page: () => null,
  plugins: () => null,
});

/** The attachment `attachment:<id>` names, if the page has it. */
export const attachmentById = (host: VisualHost, id: string): AttachmentRef | undefined =>
  host.attachments().list.find((a) => a.id === id);
