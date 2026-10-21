import { ALERTS, type AlertType } from '@wikistow/client/reader';
import {
  Info,
  Lightbulb,
  MessageSquareWarning,
  OctagonAlert,
  TextQuote,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';

/** GitHub's icons for its alerts, as lucide draws them. */
export const ALERT_ICONS = {
  note: Info,
  tip: Lightbulb,
  important: MessageSquareWarning,
  warning: TriangleAlert,
  caution: OctagonAlert,
} satisfies Record<AlertType, unknown>;

/** The kinds of quote the visual editor offers: an ordinary quote (null), then GitHub's alerts. */
export const QUOTE_KINDS: { kind: AlertType | null; label: string; icon: LucideIcon }[] = [
  { kind: null, label: 'Quote', icon: TextQuote },
  ...(Object.keys(ALERTS) as AlertType[]).map((kind) => ({
    kind,
    label: ALERTS[kind],
    icon: ALERT_ICONS[kind],
  })),
];

const PREFIX = 'markdown-alert-';

/** The type an element's classes give an alert, `markdown-alert-<type>`; else null. */
export function alertClass(className: string | undefined): AlertType | null {
  const names = className?.split(' ') ?? [];
  const type = names.find((name) => name.startsWith(PREFIX))?.slice(PREFIX.length);
  return type && Object.hasOwn(ALERTS, type) ? (type as AlertType) : null;
}

/** An alert's icon and label, as the reader and the visual editor show them. */
export function AlertTitle({ type }: { type: AlertType }) {
  const Icon = ALERT_ICONS[type];
  return (
    <>
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {ALERTS[type]}
    </>
  );
}
