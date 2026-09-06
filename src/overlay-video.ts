import type { DisplayEvent } from './sync';

export function overlayEndEvent(token: number, holdEndFrame: boolean): DisplayEvent {
  return holdEndFrame ? `overlay-held:${token}` : `overlay-ended:${token}`;
}
