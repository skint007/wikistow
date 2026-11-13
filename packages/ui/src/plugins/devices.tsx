// Which devices a plugin works on (#405): its manifest's `platforms` as
// tags, in the library and the approval dialog, and the device this app
// is running on, which the library can filter by.
import {
  DEVICES,
  ON_DEVICE,
  type Device,
  type PlatformLevel,
  type Platforms,
} from '@wikistow/plugin-sdk/manifest';
import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { desktop } from '../desktop';
import { usePhoneLayout } from '../shell/phone-layout';

/** Each device as a tag names it. */
export const DEVICE_LABELS: Record<Device, string> = {
  desktop: 'Desktop app',
  browser: 'Browser',
  phone: 'Phone',
};

/** The device this app runs on: the desktop app, or by the layout it shows, a phone or a computer's browser. */
export function useDevice(): Device {
  const phone = usePhoneLayout();
  return desktop ? 'desktop' : phone ? 'phone' : 'browser';
}

/**
 * `platforms` as tags: Devices not stated; All devices; one device
 * alone, as Desktop app only; or each device it works on, as Desktop
 * app or Phone partial. A device it doesn't work on gets no tag.
 */
export function deviceTags(platforms: Platforms | undefined): string[] {
  if (!platforms) return ['Devices not stated'];
  const on = DEVICES.filter((device) => platforms[device] !== 'none');
  if (on.length === DEVICES.length && on.every((device) => platforms[device] === 'full'))
    return ['All devices'];
  const tag = (device: Device) =>
    `${DEVICE_LABELS[device]}${platforms[device] === 'partial' ? ' partial' : ''}`;
  const [only] = on;
  if (on.length === 1 && only) return [`${tag(only)} only`];
  return on.length === 0 ? ['No devices'] : on.map(tag);
}

/** Whether a plugin says it works on `device`, fully or partly. Not stated isn't. */
export const worksOn = (platforms: Platforms | undefined, device: Device) =>
  platforms !== undefined && platforms[device] !== 'none';

const HOW: Record<PlatformLevel, string> = { full: 'fully', partial: 'partly', none: 'not' };

/** `platforms` as a sentence: "It says it works fully in the desktop app, partly in …". */
function devicesSentence(platforms: Platforms | undefined) {
  if (!platforms) return 'It doesn’t say which devices it works on.';
  if (DEVICES.every((device) => platforms[device] === 'full'))
    return 'It says it works fully on every device.';
  const parts = DEVICES.map((device) => `${HOW[platforms[device]]} ${ON_DEVICE[device]}`);
  return `It says it works ${new Intl.ListFormat('en', { type: 'conjunction' }).format(parts)}.`;
}

/** A plugin’s device tags, as outline badges. */
export function DeviceTags({ platforms }: { platforms: Platforms | undefined }) {
  return deviceTags(platforms).map((tag) => (
    <Badge
      key={tag}
      variant="outline"
      title={tag.startsWith('Browser') ? 'On a computer' : undefined}
    >
      {tag}
    </Badge>
  ));
}

/** A warning line, in the draft colour, as Settings shows one. */
export function Warning({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-1.5 rounded-row bg-status-draft px-2 py-1 text-status-draft-foreground"
    >
      <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}

/**
 * What the approval dialog says of a plugin's devices: its tags, the
 * sentence they stand for, the author's note, and a warning when it says
 * it doesn't work on the device the person is using. Approving still works.
 */
export function ApprovalDevices({ platforms }: { platforms: Platforms | undefined }) {
  const device = useDevice();
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        <DeviceTags platforms={platforms} />
      </div>
      <p>
        {devicesSentence(platforms)}
        {platforms?.note && ` ${platforms.note}`}
      </p>
      {platforms?.[device] === 'none' && (
        <Warning>
          It says it doesn’t work {ON_DEVICE[device]}, which is what you’re using. You can still go
          ahead.
        </Warning>
      )}
    </>
  );
}
