export const DISPLAY_SCALE_MIN = 0.75;
export const DISPLAY_SCALE_MAX = 1.5;
export const DISPLAY_SCALE_STEP = 0.05;

function clampDisplayScale(value: number): number {
  return Math.max(DISPLAY_SCALE_MIN, Math.min(DISPLAY_SCALE_MAX, Math.round(value * 100) / 100));
}

export function displayScaleForShortcut(
  current: number,
  event: Pick<KeyboardEvent, 'metaKey' | 'code'>,
): number | null {
  if (!event.metaKey) return null;
  if (event.code === 'Equal') return clampDisplayScale(current + DISPLAY_SCALE_STEP);
  if (event.code === 'Minus') return clampDisplayScale(current - DISPLAY_SCALE_STEP);
  return null;
}

export function fitDisplayScale(width: number, height: number, userScale: number): number {
  return Math.min(width / 1920, height / 1080) * clampDisplayScale(userScale);
}
