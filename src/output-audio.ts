export function clampOutputVolume(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

export function outputVolume(masterVolume: number, gain = 1): number {
  return clampOutputVolume(clampOutputVolume(masterVolume) * clampOutputVolume(gain));
}

export function volumePercent(masterVolume: number): number {
  return Math.round(clampOutputVolume(masterVolume) * 100);
}
