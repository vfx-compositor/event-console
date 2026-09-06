import { describe, expect, it } from 'vitest';
import { MUSIC_TRACKS, musicProgress, musicProgressFromClientX, musicTimeFromProgress, musicTrack } from './music';
describe('공개 음악 카탈로그', () => {
  it('저작권 음원을 포함하지 않고 빈 상태로 시작한다', () => { expect(MUSIC_TRACKS).toEqual([]); expect(musicTrack(null)).toBeNull(); expect(musicTrack('missing')).toBeNull(); });
  it('scrub geometry는 카탈로그와 독립적으로 동작한다', () => { expect(musicProgress(30, 120)).toBe(0.25); expect(musicProgressFromClientX(250, 100, 600)).toBe(0.25); expect(musicTimeFromProgress(0.25, 120)).toBe(30); });
});
