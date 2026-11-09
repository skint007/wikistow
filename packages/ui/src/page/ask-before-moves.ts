import { deviceSwitch, useDeviceSwitch } from '../shell/device-switch';

/**
 * Whether a drop opens Move to… or Copy to… on the place dropped on, for
 * one press of Move or Copy, instead of moving at once with Undo (#376).
 * Off by default; Settings turns it on. Kept on the device as
 * `wikistow.askBeforeMoves`, `true` while on. A device that turned the old
 * confirmation off kept `false`, which reads as off too.
 */
export const askBeforeMoves = deviceSwitch('wikistow.askBeforeMoves', false);

export const useAskBeforeMoves = () => useDeviceSwitch(askBeforeMoves);
