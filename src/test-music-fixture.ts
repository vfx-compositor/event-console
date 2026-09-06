import type { MusicTrack } from './music';

/** 저작권 음원 없이 음악 동작을 검증하는 테스트 전용 catalog. */
export const SYNTHETIC_MUSIC_TRACKS: readonly MusicTrack[] = [
  { id: '01', section: 'opening', label: 'Synthetic 01', src: '/test-audio/01.mp3', durationSec: 120 },
  { id: '02', section: 'opening', label: 'Synthetic 02', src: '/test-audio/02.mp3', durationSec: 120 },
  { id: '03', section: 'ceremony', label: 'Synthetic 03', src: '/test-audio/03.mp3', durationSec: 120 },
  { id: '04', section: 'ceremony', label: 'Synthetic 04', src: '/test-audio/04.mp3', durationSec: 120 },
  { id: '05', section: 'ceremony', label: 'Synthetic 05', src: '/test-audio/05.mp3', durationSec: 120 },
  { id: '20', section: 'game-a', label: 'Synthetic 20', src: '/test-audio/20.mp3', durationSec: 120 },
  { id: '23', section: 'game-b', label: 'Synthetic 23', src: '/test-audio/23.mp3', durationSec: 120 },
  { id: '24', section: 'game-b', label: 'Synthetic 24', src: '/test-audio/24.mp3', durationSec: 120 },
  { id: '48', section: 'victory', label: 'Synthetic 48', src: '/test-audio/48.mp3', durationSec: 120 },
  { id: '51', section: 'mystery', label: 'Synthetic 51', src: '/test-audio/51.mp3', durationSec: 120 },
];

export function syntheticMusicTrack(id: string | null): MusicTrack | null {
  return SYNTHETIC_MUSIC_TRACKS.find((track) => track.id === id) ?? null;
}
