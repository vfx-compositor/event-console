import { describe, expect, it, vi } from 'vitest';

vi.mock('./music', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./music')>();
  const fixture = await import('./test-music-fixture');
  return {
    ...actual,
    MUSIC_TRACKS: fixture.SYNTHETIC_MUSIC_TRACKS,
    musicTrack: fixture.syntheticMusicTrack,
  };
});

import {
  MUSIC_REPEAT_LABEL,
  musicAdvanceActions,
  MUSIC_REPEAT_MARK,
  MUSIC_REPEAT_MODES,
  MUSIC_REPEAT_TIP,
  isMusicRepeatMode,
  nextTrackId,
} from './music-autoplay';
import { MUSIC_TRACKS, type MusicTrack } from './music';
import { createInitialState, deserialize, promoteLegacyDefaults, reducer, serialize } from './state';

const T = (id: string, section: string): MusicTrack => ({
  id,
  section,
  label: id,
  src: `./${id}.mp3`,
  durationSec: 10,
});

const LIST: MusicTrack[] = [
  T('a1', 'A'),
  T('a2', 'A'),
  T('b1', 'B'),
  // 섹션이 목록에서 흩어져 있는 경우 — 실제 catalog도 섹션이 인접하지 않을 수 있다
  T('a3', 'A'),
];

describe('자동 이어재생 다음 곡 (U49)', () => {
  it('off는 이어재생하지 않는다', () => {
    expect(nextTrackId('off', 'a1', LIST)).toBeNull();
  });

  it('one은 같은 곡을 다시 건다', () => {
    expect(nextTrackId('one', 'a2', LIST)).toBe('a2');
  });

  it('section은 같은 섹션 안에서만 넘어가고 구간 끝에서 그 구간 처음으로 감는다', () => {
    expect(nextTrackId('section', 'a1', LIST)).toBe('a2');
    // a2 다음은 목록상 b1이지만 섹션이 다르므로 같은 섹션의 a3로 간다
    expect(nextTrackId('section', 'a2', LIST)).toBe('a3');
    expect(nextTrackId('section', 'a3', LIST)).toBe('a1');
  });

  it('곡이 하나뿐인 구간도 멈추지 않는다 — 멈추면 off와 구별되지 않는다', () => {
    expect(nextTrackId('section', 'b1', LIST)).toBe('b1');
  });

  it('all은 전체 목록을 돌고 끝에서 처음으로 감는다', () => {
    expect(nextTrackId('all', 'a1', LIST)).toBe('a2');
    expect(nextTrackId('all', 'b1', LIST)).toBe('a3');
    expect(nextTrackId('all', 'a3', LIST)).toBe('a1');
  });

  it('곡이 없거나 목록에 없으면 이어재생하지 않는다', () => {
    expect(nextTrackId('all', null, LIST)).toBeNull();
    expect(nextTrackId('all', 'no-such', LIST)).toBeNull();
  });

  it('실제 catalog에서도 네 모드가 모두 답을 낸다', () => {
    const first = MUSIC_TRACKS[0].id;
    expect(nextTrackId('off', first)).toBeNull();
    expect(nextTrackId('one', first)).toBe(first);
    expect(nextTrackId('section', first)).not.toBeNull();
    expect(nextTrackId('all', first)).not.toBeNull();
  });

  it('U119 — 승리 음악(48, 05_승리 1곡 구간)도 section 모드에서 스스로에게 감긴다', () => {
    expect(nextTrackId('section', '48')).toBe('48');
    expect(nextTrackId('one', '48')).toBe('48');
    // 목록 순서상 앞은 43(1부게임), 뒤는 51(U133 미스터리 배경음) — all 모드는 그 경계도 그냥 넘어간다
    expect(nextTrackId('all', '48')).toBe('51');
  });

  it('모드 목록·라벨·기호·설명이 모두 짝을 이룬다', () => {
    expect(MUSIC_REPEAT_MODES).toEqual(['off', 'one', 'section', 'all']);
    for (const mode of MUSIC_REPEAT_MODES) {
      expect(MUSIC_REPEAT_LABEL[mode]).toBeTruthy();
      expect(MUSIC_REPEAT_MARK[mode]).toBeTruthy();
      expect(MUSIC_REPEAT_TIP[mode]).toBeTruthy();
    }
    expect(isMusicRepeatMode('section')).toBe(true);
    expect(isMusicRepeatMode('loop')).toBe(false);
  });
});

describe('자동 이어재생 설정 (U49)', () => {
  /**
   * 사용자 지시 원문: "음악은 자동으로 이어서 진행되게 해줘. 한 곡 끝나더라도."
   * 그래서 기본이 **켜져 있어야** 한다. 전체(`all`)가 아니라 구간(`section`)인 이유는
   * 섹션이 곧 행사 구간이라, 개회식 음악이 끝나고 1부 게임 음악으로 저절로 넘어가면
   * 그게 더 놀라운 사고이기 때문이다. 끄고 싶으면 [설정]에서 [없음]을 고른다.
   */
  it('기본은 section — 사용자가 요청한 자동 이어재생이 켜져 있어야 한다', () => {
    expect(createInitialState().settings.musicRepeat).toBe('section');
  });

  it('저장본의 알 수 없는 모드는 기본값으로 되돌린다', () => {
    const raw = JSON.parse(serialize(createInitialState()));
    raw.settings.musicRepeat = 'shuffle';
    expect(deserialize(JSON.stringify(raw)).settings.musicRepeat).toBe('section');
    delete raw.settings.musicRepeat;
    expect(deserialize(JSON.stringify(raw)).settings.musicRepeat).toBe('section');
    raw.settings.musicRepeat = 'all';
    expect(deserialize(JSON.stringify(raw)).settings.musicRepeat).toBe('all');
  });

  it('끄는 선택은 그대로 살아남는다 — 기본이 켬이어도 [없음]은 유효한 값이다', () => {
    const off = reducer(createInitialState(), { type: 'settings/patch', patch: { musicRepeat: 'off' } });
    expect(deserialize(serialize(off)).settings.musicRepeat).toBe('off');
  });

  it('모드를 바꿔도 재생 중인 곡은 건드리지 않는다 — 다음 곡부터 적용이다', () => {
    const playing = reducer(createInitialState(), { type: 'music/play', trackId: '01', now: 0 });
    const next = reducer(playing, { type: 'settings/patch', patch: { musicRepeat: 'all' } });
    expect(next.music.trackId).toBe('01');
    expect(next.music.playing).toBe(true);
    expect(next.music.commandToken).toBe(playing.music.commandToken);
  });
});

/**
 * 옛 기본값(`off`) → `section` 1회 승격 (U49 정정).
 *
 * 사용자 원문이 "자동으로 이어서 진행되게 해줘"라 기본이 켜짐이어야 하는데, 첫 판이 `off`로
 * 나갔다. 그 사이에 저장된 상태에는 `off`가 **명시적으로** 박혀 있어 migrate만으로는 못 고친다
 * (키가 있으니 기본값이 안 먹는다). 다른 승격과 같은 자리·같은 규칙으로 한 번만 올린다.
 */
describe('이어재생 기본값 승격 (U49 정정)', () => {
  const saveWith = (over: Record<string, unknown>): string => {
    const raw = JSON.parse(serialize(createInitialState()));
    Object.assign(raw.settings, over);
    return JSON.stringify(raw);
  };

  it('옛 기본값 off가 박힌 저장본은 section으로 한 번 올라간다', () => {
    const revived = deserialize(saveWith({ musicRepeat: 'off', musicRepeatPromoted: false }));
    const promoted = promoteLegacyDefaults(revived);
    expect(promoted.settings.musicRepeat).toBe('section');
    expect(promoted.settings.musicRepeatPromoted).toBe(true);
  });

  it('승격은 한 번뿐 — 그 뒤에 끄면 그 선택이 유지된다', () => {
    const once = promoteLegacyDefaults(deserialize(saveWith({ musicRepeat: 'off', musicRepeatPromoted: false })));
    const turnedOff = reducer(once, { type: 'settings/patch', patch: { musicRepeat: 'off' } });
    // 저장 → 재인수 왕복에도 사용자가 고른 [없음]이 살아남는다
    expect(promoteLegacyDefaults(deserialize(serialize(turnedOff))).settings.musicRepeat).toBe('off');
  });

  it('off가 아닌 값은 승격 대상이 아니다 — 플래그만 선다', () => {
    const promoted = promoteLegacyDefaults(deserialize(saveWith({ musicRepeat: 'all', musicRepeatPromoted: false })));
    expect(promoted.settings.musicRepeat).toBe('all');
    expect(promoted.settings.musicRepeatPromoted).toBe(true);
  });

  it('플래그가 없는 옛 저장본은 승격 후보다', () => {
    const raw = JSON.parse(serialize(createInitialState()));
    raw.settings.musicRepeat = 'off';
    delete raw.settings.musicRepeatPromoted;
    expect(deserialize(JSON.stringify(raw)).settings.musicRepeatPromoted).toBe(false);
  });
});

/**
 * [High 리뷰] 자동 이어재생이 덕킹을 뚫던 자리 (U49 × U44).
 *
 * 실사고 경로: full 영상이 화면을 쥔 동안 곡이 끝난다 → 자동 이어재생이 `music/play`를 낸다
 * → 리듀서가 `ducked: false`를 무조건 쓴다(사람이 누른 곡 교체가 덕킹에 갇히면 안 되므로 **맞는**
 * 동작이다) → 복귀 훅은 `fullVideoOwnsOutput`이 참→거짓으로 **떨어질 때만** 돌아 다시 내려 줄
 * 주인이 없다 → 다음 곡이 영상 소리 위에 100%로 겹친다.
 *
 * 리듀서를 고치면 사람이 누른 교체까지 갇히므로, **호출부에서** 같은 배열에 `music/duck`을 잇는다.
 * dispatch가 배열을 한 번에 리듀스하고 방송을 **한 번만** 내므로 display는 `ducked: false`인
 * 중간 상태를 보지 못한다 — 두 번 나눠 내면 그 사이 한 프레임이 100%로 울린다.
 */
describe('자동 이어재생과 덕킹 (High 리뷰)', () => {
  const base = {
    endedTrackId: '01',
    mode: 'section' as const,
    now: 1000,
    fullVideoOwns: false,
    autoDuck: true,
  };

  it('평상시에는 다음 곡 재생 하나만 낸다', () => {
    const out = musicAdvanceActions(base);
    expect(out.map((a) => a.type)).toEqual(['music/play']);
  });

  it('full 영상이 화면을 쥐고 있으면 재생 뒤에 덕킹을 잇는다', () => {
    const out = musicAdvanceActions({ ...base, fullVideoOwns: true });
    expect(out.map((a) => a.type)).toEqual(['music/play', 'music/duck']);
    // 순서가 뒤집히면 `music/play`의 `ducked:false`가 덕킹을 덮는다
    expect(out[0].type).toBe('music/play');
  });

  it('자동 덕킹을 끈 운영자의 선택은 여기서도 존중한다', () => {
    const out = musicAdvanceActions({ ...base, fullVideoOwns: true, autoDuck: false });
    expect(out.map((a) => a.type)).toEqual(['music/play']);
  });

  it('이어재생할 곡이 없으면 아무 액션도 내지 않는다', () => {
    expect(musicAdvanceActions({ ...base, mode: 'off' })).toEqual([]);
    expect(musicAdvanceActions({ ...base, endedTrackId: 'no-such' })).toEqual([]);
  });

  it('한 배열로 돌려준다 — 두 번 나눠 dispatch하면 그 사이가 100%로 울린다', () => {
    const out = musicAdvanceActions({ ...base, fullVideoOwns: true });
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(2);
  });
});
