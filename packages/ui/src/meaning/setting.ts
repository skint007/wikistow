import { useQuery } from '@tanstack/react-query';
import type { Device } from '@wikistow/plugin-sdk/manifest';
import { desktop } from '../desktop';
import { keepEveryPage } from '../data/keeper';
import { keptStore } from '../data/kept-store';
import { deviceSwitch, useDeviceSwitch, type DeviceSwitch } from '../shell/device-switch';
import { usePhoneLayout } from '../shell/phone-layout';
import { meaningProgress, type MeaningStatus } from './meaning-index';

/**
 * **Search by meaning** on this device (ADR 0016, decision 5): on by
 * default in the desktop app, off in a browser until the person turns it
 * on. A device setting, kept on the device and not synced, as **Keep for
 * offline** is, since the cost is the device's. It applies only where it is
 * offered (`meaningOffer`).
 */
export const searchByMeaning = (): DeviceSwitch =>
  (setting ??= deviceSwitch('wikistow.searchByMeaning', desktop !== null));
let setting: DeviceSwitch | null = null;

/**
 * Whether search by meaning is offered here, or what it needs: **Keep for
 * offline** on Every page, as vectors made afresh each session would cost
 * minutes each time, and in the desktop app a trusted keyring, without
 * which nothing is kept between launches. Not on phones (the phone
 * layout) yet: a phone's processor hasn't been measured.
 */
export type MeaningOffer = 'offered' | 'phone' | 'keyring' | 'every-page';

export function meaningOffer({
  device,
  onDisk,
  everyPage,
}: {
  device: Device;
  /** Pages are kept between launches: always in a browser, with a trusted keyring in the desktop app. */
  onDisk: boolean;
  everyPage: boolean;
}): MeaningOffer {
  if (device === 'phone') return 'phone';
  if (!onDisk) return 'keyring';
  if (!everyPage) return 'every-page';
  return 'offered';
}

/** Whether it is offered here (`meaningOffer`), or null until the device's store is known. */
export function useMeaningOffer(): MeaningOffer | null {
  const phone = usePhoneLayout();
  const everyPage = useDeviceSwitch(keepEveryPage());
  const { data: onDisk } = useQuery({
    queryKey: ['kept-on-disk'],
    queryFn: async () => (await keptStore()).onDisk,
  });
  if (onDisk === undefined) return null;
  const device: Device = desktop ? 'desktop' : phone ? 'phone' : 'browser';
  return meaningOffer({ device, onDisk, everyPage });
}

/** What Settings says of it: how far it has got, what it does, or what it needs. */
export function meaningSettingState(
  offer: MeaningOffer,
  { on, desktop, status }: { on: boolean; desktop: boolean; status: MeaningStatus | null },
): string {
  switch (offer) {
    case 'phone':
      return 'Not on phones yet.';
    case 'keyring':
      return 'Needs Keep for offline on Every page, which needs a keyring here.';
    case 'every-page':
      return 'Needs Keep for offline on Every page: indexing again each session would take minutes.';
    case 'offered': {
      const does =
        'Finds pages close in meaning to what you search for, below the pages with its words.';
      if (!on && !desktop) {
        return `${does} Downloads 26 MB once, then indexes your pages in the background on this device.`;
      }
      const progress = on ? meaningProgress(status) : null;
      return [
        progress && `${progress}.`,
        does,
        'Nothing you search for or write leaves this device.',
      ]
        .filter(Boolean)
        .join(' ');
    }
  }
}
