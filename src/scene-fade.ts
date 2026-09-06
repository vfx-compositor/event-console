export interface SceneFadeFrame {
  opacity: number;
  event: 'switch' | 'finish' | null;
}

export function sceneFadeFrame(elapsedSec: number, durationSec: number, switched: boolean): SceneFadeFrame {
  const duration = Math.max(0, durationSec);
  if (duration === 0) return switched ? { opacity: 0, event: 'finish' } : { opacity: 1, event: 'switch' };
  if (!switched) {
    const opacity = Math.min(1, Math.max(0, elapsedSec / duration));
    return { opacity, event: elapsedSec >= duration ? 'switch' : null };
  }
  const opacity = Math.max(0, 1 - Math.max(0, elapsedSec - duration) / duration);
  return { opacity, event: elapsedSec >= duration * 2 ? 'finish' : null };
}
