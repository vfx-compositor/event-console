import { describe, expect, it } from 'vitest';
import {
  classifyMusicPlayRejection,
  musicEndedTrackId,
  musicFadePlan,
  musicPlaybackCommand,
} from './music-playback';
import type { MusicState } from './types';

const stopped: MusicState = { trackId: null, playing: false, positionSec: 0, commandToken: 0, ducked: false, bookmarks: {}, fadeIn: true };

describe('display 음악 명령 해석', () => {
  it('새 곡은 소스를 바꾸고 지정 위치에서 재생한다', () => {
    const next: MusicState = { trackId: '23', playing: true, positionSec: 0, commandToken: 10, ducked: false, bookmarks: {}, fadeIn: true };
    expect(musicPlaybackCommand(stopped, next)).toEqual({
      trackId: '23',
      load: true,
      seekTo: 0,
      play: true,
      pause: false,
      fadeIn: true,
    });
  });

  it('fadeIn:false인 상태는 명령에도 그대로 실린다 (U122)', () => {
    const next: MusicState = { trackId: '48', playing: true, positionSec: 0, commandToken: 10, ducked: false, bookmarks: {}, fadeIn: false };
    expect(musicPlaybackCommand(stopped, next)).toMatchObject({ fadeIn: false });
  });

  it('같은 곡의 seek 토큰만 바뀌면 소스 reload 없이 이동한다', () => {
    const prev: MusicState = { trackId: '23', playing: true, positionSec: 0, commandToken: 10, ducked: false, bookmarks: {}, fadeIn: true };
    const next: MusicState = { trackId: '23', playing: true, positionSec: 41.5, commandToken: 11, ducked: false, bookmarks: {}, fadeIn: true };
    expect(musicPlaybackCommand(prev, next)).toEqual({
      trackId: '23',
      load: false,
      seekTo: 41.5,
      play: false,
      pause: false,
      fadeIn: true,
    });
  });

  it('일시정지·재개·정지를 각각 한 번만 명령한다', () => {
    const playing: MusicState = { trackId: '23', playing: true, positionSec: 5, commandToken: 10, ducked: false, bookmarks: {}, fadeIn: true };
    const paused: MusicState = { ...playing, playing: false, positionSec: 8 };
    expect(musicPlaybackCommand(playing, paused)).toMatchObject({ pause: true, play: false, load: false });
    expect(musicPlaybackCommand(paused, { ...paused, playing: true })).toMatchObject({ play: true, pause: false });
    expect(musicPlaybackCommand(playing, stopped)).toMatchObject({ trackId: null, pause: true, load: false });
    expect(musicPlaybackCommand(paused, paused)).toEqual(null);
  });

  it('실제 현재 곡의 ended만 전달하고 교체 직전 곡의 queued ended는 무시한다', () => {
    expect(musicEndedTrackId(true, '23', '23')).toBe('23');
    expect(musicEndedTrackId(false, '24', '24')).toBeNull();
    expect(musicEndedTrackId(true, '23', '24')).toBeNull();
    expect(musicEndedTrackId(true, null, '24')).toBeNull();
  });

  it('play rejection은 stale/Abort를 무시하고 NotAllowed만 autoplay lock으로 분류한다', () => {
    expect(classifyMusicPlayRejection({ name: 'NotAllowedError' }, 10, 11)).toBe('ignore');
    expect(classifyMusicPlayRejection({ name: 'AbortError' }, 11, 11)).toBe('ignore');
    expect(classifyMusicPlayRejection({ name: 'NotAllowedError' }, 11, 11)).toBe('autoplay-lock');
    expect(classifyMusicPlayRejection({ name: 'NotSupportedError' }, 11, 11)).toBe('playback-error');
    expect(classifyMusicPlayRejection(new Error('network'), 11, 11)).toBe('playback-error');
  });
});

describe('음악 페이드 계획 (U18)', () => {
  const cmd = (over: Partial<ReturnType<typeof musicPlaybackCommand>> = {}) => ({
    trackId: '23',
    load: false,
    seekTo: null,
    play: false,
    pause: false,
    fadeIn: true,
    ...(over as object),
  }) as NonNullable<ReturnType<typeof musicPlaybackCommand>>;

  it('정지는 곧바로 끊지 않고 페이드 아웃이 끝난 뒤 소스를 해제한다', () => {
    expect(musicFadePlan(cmd({ trackId: null, pause: true }), true)).toEqual({
      swapDeck: false,
      outgoing: 'release',
      incoming: 'none',
    });
  });

  it('일시정지는 페이드 아웃 뒤 pause — 소스는 그대로 남긴다', () => {
    expect(musicFadePlan(cmd({ pause: true }), true)).toEqual({
      swapDeck: false,
      outgoing: 'pause',
      incoming: 'none',
    });
  });

  it('재생·재개는 현재 볼륨에서 페이드 인만 건다', () => {
    expect(musicFadePlan(cmd({ play: true }), false)).toEqual({
      swapDeck: false,
      outgoing: 'none',
      incoming: 'fade-in',
    });
  });

  it('울리는 중의 곡 교체는 덱을 바꿔 크로스페이드한다', () => {
    expect(musicFadePlan(cmd({ load: true, play: true }), true)).toEqual({
      swapDeck: true,
      outgoing: 'release',
      incoming: 'fade-in',
    });
  });

  it('소리가 없던 상태의 곡 교체는 크로스할 대상이 없으므로 같은 덱에 싣는다', () => {
    expect(musicFadePlan(cmd({ load: true, play: true }), false)).toEqual({
      swapDeck: false,
      outgoing: 'none',
      incoming: 'fade-in',
    });
  });

  it('바뀔 것이 없는 명령은 아무 램프도 걸지 않는다', () => {
    expect(musicFadePlan(cmd({ seekTo: 12 }), true)).toEqual({
      swapDeck: false,
      outgoing: 'none',
      incoming: 'none',
    });
  });
});

describe('인커밍 컷 (U122) — fadeIn:false는 크로스페이드 없이 즉시 목표로 올린다', () => {
  const cmd = (over: Partial<ReturnType<typeof musicPlaybackCommand>> = {}) => ({
    trackId: '23',
    load: false,
    seekTo: null,
    play: false,
    pause: false,
    fadeIn: false,
    ...(over as object),
  }) as NonNullable<ReturnType<typeof musicPlaybackCommand>>;

  it('재생·재개는 incoming이 cut-in이다 — outgoing은 fadeIn과 무관하게 그대로', () => {
    expect(musicFadePlan(cmd({ play: true }), false)).toEqual({
      swapDeck: false,
      outgoing: 'none',
      incoming: 'cut-in',
    });
  });

  it('울리는 중의 곡 교체도 크로스는 걸되(옛 덱은 그대로 페이드아웃) 새 덱은 컷으로 올라온다', () => {
    expect(musicFadePlan(cmd({ load: true, play: true }), true)).toEqual({
      swapDeck: true,
      outgoing: 'release', // 아웃고잉 곡의 musicFadeSec 페이드아웃은 attack과 무관하게 유지
      incoming: 'cut-in',
    });
  });

  it('소리가 없던 상태의 곡 교체도 같은 덱에 컷으로 싣는다', () => {
    expect(musicFadePlan(cmd({ load: true, play: true }), false)).toEqual({
      swapDeck: false,
      outgoing: 'none',
      incoming: 'cut-in',
    });
  });

  it('정지·일시정지는 fadeIn과 무관하다 — incoming이 없으므로 attack이 관여할 자리가 없다', () => {
    expect(musicFadePlan(cmd({ trackId: null, pause: true }), true)).toEqual({
      swapDeck: false,
      outgoing: 'release',
      incoming: 'none',
    });
    expect(musicFadePlan(cmd({ pause: true }), true)).toEqual({
      swapDeck: false,
      outgoing: 'pause',
      incoming: 'none',
    });
  });
});
