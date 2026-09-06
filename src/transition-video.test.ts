import { describe, expect, it } from 'vitest';
import {
  fullVideoWatchdogDeadlineMs,
  isTransitionSwitchDue,
  normalizeTransitionPlayback,
  pickTransitionPreloadAssetId,
  preloadTransitionVideo,
  shouldRepeatTransitionEnd,
  transitionAmbientPresentation,
  transitionWatchdogDeadlineMs,
  transitionWatchdogPhase,
} from './transition-video';
import type { SceneOpts } from './types';

function transition(
  patch: Partial<SceneOpts['transitionVideo']> = {},
): SceneOpts['transitionVideo'] {
  return {
    active: true,
    assetId: 'sting-b',
    nextScene: 'score',
    switchAtSec: 0.5,
    restartToken: 2,
    switched: false,
    nextStandbyMode: null,
    ...patch,
  };
}

describe('영상 전환 재생 가드', () => {
  it('이전 디버그·브라우저 상태와 무관하게 항상 원속도 단발 재생으로 초기화한다', () => {
    const video = {
      playbackRate: 0.25,
      defaultPlaybackRate: 0.25,
      loop: true,
      autoplay: true,
    };

    normalizeTransitionPlayback(video);

    expect(video).toEqual({
      playbackRate: 1,
      defaultPlaybackRate: 1,
      loop: false,
      // 재생은 언제나 명시 play()로만 시작한다 — autoplay가 남으면 예열이 곧 재생이 된다
      autoplay: false,
    });
  });

  /**
   * U102: 스팅어는 효과음 레이어가 되었고 `muted`의 주인은 `display.ts`의 `setOutputMuted()`
   * 하나다(모니터 · 창 음소거 · 에셋 판정 세 축). 이 함수가 다시 `muted`를 쓰기 시작하면
   * **예열이 재생의 음소거를 되돌리는** 자리가 생기므로, 손대지 않는 것 자체를 잠근다.
   */
  it('muted에는 손대지 않는다 — 소리 판정의 주인은 setOutputMuted 하나다 (U102)', () => {
    const audible = {
      playbackRate: 1,
      defaultPlaybackRate: 1,
      loop: false,
      autoplay: false,
      muted: false,
    };
    normalizeTransitionPlayback(audible);
    expect(audible.muted).toBe(false);

    const silent = { ...audible, muted: true };
    normalizeTransitionPlayback(silent);
    expect(silent.muted).toBe(true);
  });

  it('예열은 디코딩 준비만 하고 재생을 시작하지 않는다', () => {
    const loads: { autoplay: boolean; src: string }[] = [];
    const video = {
      src: 'blob:previous',
      playbackRate: 0.25,
      defaultPlaybackRate: 0.25,
      loop: true,
      // display가 이전에 켜 두었던 autoplay가 남아 있는 상황
      autoplay: true,
      muted: false,
      load() {
        loads.push({ autoplay: video.autoplay, src: video.src });
      },
    };

    preloadTransitionVideo(video, 'blob:sting');

    expect(video.src).toBe('blob:sting');
    // load() 시점에 autoplay가 켜져 있으면 hidden 상태로 통째로 디코딩된다 (고스트 재생)
    expect(loads).toEqual([{ autoplay: false, src: 'blob:sting' }]);
  });

  it('출력창 부팅 시 첫 정상 전환 영상을 백그라운드 예열 대상으로 고른다', () => {
    expect(
      pickTransitionPreloadAssetId([
        { id: 'full', type: 'video', playMode: 'full' },
        { id: 'broken', type: 'video', playMode: 'transition', probeFailed: true },
        { id: 'image', type: 'image', playMode: 'transition' },
        { id: 'sting', type: 'video', playMode: 'transition' },
      ]),
    ).toBe('sting');
  });

  it('새 전환을 로드하는 동안 이전 영상 재생 시간으로 씬을 바꾸지 않는다', () => {
    expect(
      isTransitionSwitchDue(transition(), {
        boundAssetId: 'sting-a',
        boundToken: 1,
        currentTime: 1.5,
        reportedToken: -1,
      }),
    ).toBe(false);
  });

  it('현재 영상과 토큰이 실제 재생에 바인딩된 후에만 교체 시점을 보고한다', () => {
    expect(
      isTransitionSwitchDue(transition(), {
        boundAssetId: 'sting-b',
        boundToken: 2,
        currentTime: 0.5,
        reportedToken: -1,
      }),
    ).toBe(true);
    expect(
      isTransitionSwitchDue(transition(), {
        boundAssetId: 'sting-b',
        boundToken: 2,
        currentTime: 0.8,
        reportedToken: 2,
      }),
    ).toBe(false);
  });

  it('스코어보드는 스팅어 종료 0.5초 전부터 underlying scene 애니메이션을 시작한다', () => {
    const current = transition({ nextScene: 'score', switchAtSec: 0.2 });
    const playback = {
      boundAssetId: 'sting-b',
      boundToken: 2,
      durationSec: 1.966,
      reportedToken: -1,
    };

    expect(isTransitionSwitchDue(current, { ...playback, currentTime: 1.465 })).toBe(false);
    expect(isTransitionSwitchDue(current, { ...playback, currentTime: 1.466 })).toBe(true);
  });

  it('스코어보드 외 장면은 기존 스팅어 switch marker를 유지한다', () => {
    expect(
      isTransitionSwitchDue(transition({ nextScene: 'live', switchAtSec: 0.2 }), {
        boundAssetId: 'sting-b',
        boundToken: 2,
        currentTime: 0.2,
        durationSec: 1.966,
        reportedToken: -1,
      }),
    ).toBe(true);
  });

  it('표시창이 종료를 즉시 숨긴 후에도 control이 복구될 때까지 종료 보고를 재전송한다', () => {
    const current = transition();
    expect(shouldRepeatTransitionEnd(current, 2, 3_000, 1_900)).toBe(true);
    expect(shouldRepeatTransitionEnd(current, 2, 2_500, 1_900)).toBe(false);
    expect(shouldRepeatTransitionEnd(current, 1, 3_000, 1_900)).toBe(false);
    expect(shouldRepeatTransitionEnd(transition({ active: false }), 2, 3_000, 1_900)).toBe(false);
  });

  it('이전 전환의 재생 시작 보고를 새 전환의 것으로 오판하지 않는다', () => {
    // 새 전환은 아직 로딩 중인데 bound로 보면 짧은 마감이 걸려 정상 재생을 끊는다
    expect(transitionWatchdogPhase({ switched: false, restartToken: 7 }, 6)).toBe('loading');
    expect(transitionWatchdogPhase({ switched: false, restartToken: 7 }, -1)).toBe('loading');
    expect(transitionWatchdogPhase({ switched: false, restartToken: 7 }, 7)).toBe('bound');
    // 교체가 끝난 뒤에는 bound 보고 유무와 무관하게 꼬리 재생 구간이다
    expect(transitionWatchdogPhase({ switched: true, restartToken: 7 }, 6)).toBe('switched');
    expect(transitionWatchdogPhase({ switched: true, restartToken: 7 }, 7)).toBe('switched');
  });

  it('재생 시작 보고 전에는 왕복·로딩 여유를 최소 4초 준다', () => {
    // control의 dispatch 시점부터 재는 구간 — display 왕복 + IndexedDB 로드 + play()가 남았다.
    // 여기서 (switchAt + 1.5초)만 주면 큰 스팅어의 정상 로딩을 stall로 오판해 하드컷을 때린다.
    expect(transitionWatchdogDeadlineMs({ switchAtSec: 0.5, durationSec: 3.2 }, 'loading')).toBe(4_000);
    expect(transitionWatchdogDeadlineMs({ switchAtSec: 4 }, 'loading')).toBe(5_500);
  });

  it('재생이 실제로 시작된 뒤에는 교체 시점 + 1.5초만 기다린다', () => {
    expect(transitionWatchdogDeadlineMs({ switchAtSec: 0.5, durationSec: 3.2 }, 'bound')).toBe(2_000);
    expect(transitionWatchdogDeadlineMs({ switchAtSec: 4 }, 'bound')).toBe(5_500);
  });

  it('스코어보드 bound watchdog은 종료 0.5초 전 교체 시점에 1.5초 여유를 더한다', () => {
    expect(
      transitionWatchdogDeadlineMs(
        { switchAtSec: 0.2, durationSec: 1.966, nextScene: 'score' },
        'bound',
      ),
    ).toBe(2_966);
    expect(
      transitionWatchdogDeadlineMs(
        { switchAtSec: 0.2, durationSec: 12, nextScene: 'score' },
        'bound',
      ),
    ).toBe(13_000);
  });

  it('스코어보드 duration이 비정상이면 watchdog도 기존 marker로 fallback한다', () => {
    for (const durationSec of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(
        transitionWatchdogDeadlineMs(
          { switchAtSec: 0.2, durationSec, nextScene: 'score' },
          'bound',
        ),
      ).toBe(1_700);
    }
  });

  it('0.5초보다 짧거나 0 이하인 finite duration은 즉시 교체 threshold와 1.5초 watchdog으로 조인다', () => {
    for (const durationSec of [0.3, 0, -2]) {
      expect(
        transitionWatchdogDeadlineMs(
          { switchAtSec: 0.2, durationSec, nextScene: 'score' },
          'bound',
        ),
      ).toBe(1_500);
    }
  });

  it('스코어보드 외 목적지는 duration과 무관하게 기존 watchdog marker를 유지한다', () => {
    expect(
      transitionWatchdogDeadlineMs(
        { switchAtSec: 0.2, durationSec: 12, nextScene: 'live' },
        'bound',
      ),
    ).toBe(1_700);
  });

  it('교체 후에는 전체 재생 예상 길이 + 1.5초로 재무장한다', () => {
    expect(transitionWatchdogDeadlineMs({ switchAtSec: 0.5, durationSec: 3.2 }, 'switched')).toBe(4_700);
    // 길이를 못 뽑은 에셋은 교체 시점 + 3초를 재생 길이로 가정한다
    expect(transitionWatchdogDeadlineMs({ switchAtSec: 0.5 }, 'switched')).toBe(5_000);
    // 이미 씬이 바뀐 뒤라 상한이 없다 — 긴 영상의 꼬리를 8초에 잘라내면 안 된다
    expect(transitionWatchdogDeadlineMs({ switchAtSec: 0.5, durationSec: 120 }, 'switched')).toBe(121_500);
  });

  it('교체 전 구간은 상한 8초, 모든 구간은 하한 1초로 조인다', () => {
    expect(transitionWatchdogDeadlineMs({ switchAtSec: 30 }, 'loading')).toBe(8_000);
    expect(transitionWatchdogDeadlineMs({ switchAtSec: 30 }, 'bound')).toBe(8_000);
    // probe 실패로 값이 깨져 들어와도 유한한 마감이 나와야 한다
    expect(transitionWatchdogDeadlineMs({ switchAtSec: Number.NaN }, 'bound')).toBe(2_000);
    expect(transitionWatchdogDeadlineMs({ switchAtSec: -5 }, 'bound')).toBe(1_500);
    expect(transitionWatchdogDeadlineMs({}, 'bound')).toBe(2_000);
    expect(transitionWatchdogDeadlineMs({ switchAtSec: -5, durationSec: Number.NaN }, 'switched')).toBe(4_500);
  });

  it('알파 전환 중에는 screen 합성 앰비언트를 숨기고 정지 모드로 내린다', () => {
    expect(transitionAmbientPresentation('score', true)).toEqual({
      scene: 'video',
      hidden: true,
    });
    expect(transitionAmbientPresentation('score', false)).toEqual({
      scene: 'score',
      hidden: false,
    });
  });

  it('이미지 전용 기본 대기에서는 전역 앰비언트도 숨기고 정지한다', () => {
    expect(transitionAmbientPresentation('standby', false)).toEqual({
      scene: 'video',
      hidden: true,
    });
  });
});

describe('fullVideoWatchdogDeadlineMs', () => {
  it('covering/revealing은 (fadeSec + 1.5초)를 하한 1.5초·상한 8초로 조인다', () => {
    expect(fullVideoWatchdogDeadlineMs('covering', 0.5, undefined)).toBe(2_000);
    expect(fullVideoWatchdogDeadlineMs('revealing', 0.5, undefined)).toBe(2_000);
    // fadeSec이 매우 작아도 하한 1.5초
    expect(fullVideoWatchdogDeadlineMs('covering', 0, undefined)).toBe(1_500);
    // fadeSec이 커도 상한 8초
    expect(fullVideoWatchdogDeadlineMs('covering', 30, undefined)).toBe(8_000);
    expect(fullVideoWatchdogDeadlineMs('revealing', 30, undefined)).toBe(8_000);
  });

  it('playing은 durationSec을 알면 (durationSec + fadeSec + 2)초로 상한 없이 재무장한다', () => {
    expect(fullVideoWatchdogDeadlineMs('playing', 0.5, 10)).toBe(12_500);
    // 아주 긴 설명 영상도 끊기지 않는다
    expect(fullVideoWatchdogDeadlineMs('playing', 0.5, 3_600)).toBe(3_602_500);
  });

  it('playing은 durationSec을 모르면 워치독을 무장하지 않는다(null)', () => {
    expect(fullVideoWatchdogDeadlineMs('playing', 0.5, undefined)).toBeNull();
    expect(fullVideoWatchdogDeadlineMs('playing', 0.5, Number.NaN)).toBeNull();
  });

  it('fadeSec이 음수·NaN이어도 유한한 마감이 나온다', () => {
    expect(fullVideoWatchdogDeadlineMs('covering', -5, undefined)).toBe(1_500);
    expect(fullVideoWatchdogDeadlineMs('covering', Number.NaN, undefined)).toBe(1_500);
  });
});
