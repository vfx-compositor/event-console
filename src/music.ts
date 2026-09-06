/** 기본 음원은 포함하지 않는다. 사용할 곡을 MUSIC_TRACKS에 지정하고 파일을 배치한 뒤 빌드한다. */
export interface MusicTrack {
  id: string;
  section: string;
  label: string;
  src: string;
  durationSec: number;
  warning?: string;
}

export const MUSIC_TRACKS: readonly MusicTrack[] = [];

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** display telemetry와 scrub handle/fill이 함께 읽는 단 하나의 진행률. */
export function musicProgress(currentTime: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime)) return 0;
  return clamp01(currentTime / duration);
}

/** Dashboard meetings transport와 같은 rail rect 역함수. */
export function musicProgressFromClientX(clientX: number, left: number, width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  return clamp01((clientX - left) / width);
}

export function musicTimeFromProgress(progress: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return clamp01(progress) * duration;
}

export function formatMusicTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export function musicTrack(id: string | null): MusicTrack | null {
  return MUSIC_TRACKS.find((track) => track.id === id) ?? null;
}
