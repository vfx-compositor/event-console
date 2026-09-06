import { describe, expect, it } from 'vitest';
import { victoryOutputActions, victoryMusicOf } from './cue';
import { victoryMusicHint } from './control/tab-settings';
import { createInitialState } from './state';
describe('공개본 승리 음악 경계', () => {
  it('기본값은 미지정이며 영상만 출력할 수 있다', () => { const state = createInitialState(); expect(victoryMusicOf(state)).toEqual({ trackId: null, startSec: 0 }); expect(victoryMusicHint(null, {})).toContain('영상만'); expect(victoryOutputActions('t1', [], 1, { trackId: null, startSec: 0 })).toEqual([]); });
});
