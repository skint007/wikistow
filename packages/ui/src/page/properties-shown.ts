import type { PageId, SpaceId } from '@wikistow/client';
import { useCallback } from 'react';
import { z } from 'zod';
import { deviceSwitch, useDeviceSwitch } from '../shell/device-switch';
import { deviceStore } from '../shell/device-store';

/**
 * Whether a page's properties start open, the **Show properties** switch in
 * Settings: off, collapsed to one line, by default. Kept on the device as
 * `wikistow.showProperties`, `true` while on.
 */
export const showProperties = deviceSwitch('wikistow.showProperties', false);

export const useShowProperties = () => useDeviceSwitch(showProperties);

const NONE: Readonly<Record<string, boolean>> = {};

// Each page whose box the person opened or closed against the default, by ID.
const useKept = deviceStore('wikistow.properties.', z.record(z.string(), z.boolean()), NONE);

/**
 * Whether `page`'s properties are open on this device, and a setter: what
 * the person last chose there, else the **Show properties** default. Kept
 * per server, account and space (`deviceStore`), only for the pages that
 * differ from the default when chosen, so the list stays small.
 */
export function usePropertiesShown(page: { spaceId: SpaceId; pageId: PageId }) {
  const byDefault = useShowProperties();
  const [kept, keep] = useKept(page.spaceId);
  const { pageId } = page;
  const set = useCallback(
    (shown: boolean) =>
      keep((current) => {
        const { [pageId]: _was, ...others } = current;
        return shown === showProperties.get() ? others : { ...others, [pageId]: shown };
      }),
    [keep, pageId],
  );
  return [kept[pageId] ?? byDefault, set] as const;
}
