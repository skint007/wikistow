import { deviceSwitch, useDeviceSwitch } from '../shell/device-switch';

/**
 * Whether a move stops on its confirmation step, where the person sees who
 * gains and loses access, before it goes ahead. **Don't ask again** there
 * turns it off, and Settings turns it back on. Kept on the device as
 * `wikistow.askBeforeMoves`, `false` while off.
 */
export const askBeforeMoves = deviceSwitch('wikistow.askBeforeMoves', true);

export const useAskBeforeMoves = () => useDeviceSwitch(askBeforeMoves);
