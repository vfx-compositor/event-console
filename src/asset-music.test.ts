import { describe, expect, it } from 'vitest';
import { INTRO_MUSIC_DEFAULTS, assetMusicTrackId, introMusicDefaultForAsset, introMusicDefaultForFile } from './asset-music';
import { defaultHoldEndFrame } from './control/tab-assets';
describe('공개 미디어 음악 경계', () => {
  it('공개본은 행사별 기본 곡을 자동 연결하지 않는다', () => { expect(INTRO_MUSIC_DEFAULTS).toEqual({}); expect(introMusicDefaultForFile('intro.mp4')).toBeNull(); expect(introMusicDefaultForAsset('media:intro.mp4')).toBeNull(); });
  it('곡이 없어도 영상 홀드 기본값은 유지한다', () => { expect(assetMusicTrackId({ id: 'upload', type: 'video', size: 1, mime: 'video/mp4', name: 'upload' })).toBeNull(); expect(defaultHoldEndFrame('full')).toBe(true); expect(defaultHoldEndFrame('overlay')).toBe(true); expect(defaultHoldEndFrame('transition')).toBe(false); });
});
