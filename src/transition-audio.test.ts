/**
 * 스팅어 오디오 정책 (U102) — 2026-09-05 04:08 사용자 지시.
 *
 * > "게임 소개 영상들에 왜 소리 꺼졌어??? 전체적으로 소리 다 켜줘. 미디어 자료들은 소리 다
 * > 켜는게 맞아. 스팅어도 소리 넣어서 다시 줄거야. 스팅어의 경우는 깔리고있는 오디오 위에
 * > 사운드가 겹쳐져서 나야하고 (그쪽은 효과음 위주라) 다른 꼭지들은 해당 미디어의 사운드만
 * > 재생되는 게 메인인 셈임."
 *
 * 세 가지가 **동시에** 참이어야 한다.
 *  1. 볼륨은 다른 출력과 같은 축을 탄다 — 미디어 볼륨 × 마스터 × 암전(U95), 별도 축 없음.
 *  2. `muted` 는 세 축(모니터·창 음소거·에셋) 하나의 판정이고, 그러면서도 **겹친다** —
 *     덕킹도 카메라 파킹도 꼬리 페이드도 붙지 않는다.
 *  3. 소리가 막혀도 **그림은 나간다** — 거부를 분류해 무음으로 강등하고 다시 튼다.
 *
 * 셋 다 실제 값을 넣고 돌린다(리뷰 m6). display 원문 스캔은 "이 판정들이 display 에 실제로
 * 꽂혀 있다"를 확인하는 배선 검사 둘만 남긴다 — 계산 자체는 아래에서 진짜로 돌아간다.
 */

// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  blackoutAudioAxis,
  idleTrack,
  outputMuted,
  stepGain,
  trackVolume,
  type GainTrack,
} from './audio-gain';
import { videoAudioOwnsOutput } from './music-duck';
import { createInitialState, reducer } from './state';
import {
  normalizeTransitionPlayback,
  playTransitionWithAudioFallback,
  TRANSITION_STINGER_GAIN,
  type TransitionPlayHandlers,
} from './transition-video';
import type { AssetMeta } from './types';

const display = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');

const stinger = (over: Partial<AssetMeta> = {}): AssetMeta => ({
  id: 'sting',
  name: '브릿지 스팅어',
  type: 'video',
  size: 1,
  mime: 'video/webm',
  playMode: 'transition',
  switchAtSec: 0.2,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. 볼륨 — 다른 출력과 **같은 축**을 탄다
// ─────────────────────────────────────────────────────────────────────────────

describe('스팅어 볼륨 = 미디어 볼륨 × 마스터 × 암전 (U102)', () => {
  /** 게인 매니저가 매 프레임 element 에 심는 값 (`tickAudioGains` 의 합성과 같은 식) */
  const heard = (mediaVolume: number, blackoutAxis: number, track: GainTrack): number =>
    trackVolume(mediaVolume * blackoutAxis, track);

  it('스팅어는 설명 영상의 0.4배로 나온다 — U116 0.8 → U129 절반, 게인 상수만큼만 깎인다', () => {
    expect(TRANSITION_STINGER_GAIN).toBe(0.4);
    const full = idleTrack(1);
    const transition = idleTrack(TRANSITION_STINGER_GAIN);
    for (const mediaVolume of [0, 0.25, 0.5, 1]) {
      expect(heard(mediaVolume, 1, transition)).toBeCloseTo(
        heard(mediaVolume, 1, full) * TRANSITION_STINGER_GAIN,
        10,
      );
    }
  });

  it('암전 축은 곱으로 걸린다 — 그림이 절반 어두워지면 스팅어도 절반이다 (U95)', () => {
    const track = idleTrack(TRANSITION_STINGER_GAIN);
    const full = heard(0.8, 1, track);
    expect(heard(0.8, 0.5, track)).toBeCloseTo(full * 0.5, 10);
    expect(heard(0.8, 0, track)).toBe(0);
  });

  it('암전 서술자에서 나온 실제 축 값을 그대로 쓴다 (별도 곡선 없음)', () => {
    const blackout = { active: true, startedAt: 1_000, fromOpacity: 0 };
    const track = idleTrack(1);
    // 시작 순간에는 아직 안 어둡다 → 소리도 그대로
    expect(heard(1, blackoutAudioAxis(blackout, 4, 1_000), track)).toBeCloseTo(1, 10);
    // 다 덮인 뒤에는 완전 무음
    expect(heard(1, blackoutAudioAxis(blackout, 4, 9_000), track)).toBe(0);
    // 도중에는 그 사이 어딘가 — 화면과 같은 서술자에서 나온 값이므로 단조 감소한다
    const mid = heard(1, blackoutAudioAxis(blackout, 4, 3_000), track);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('마스터 볼륨 0이면 스팅어도 무음이다 (창 음소거와 별개 축)', () => {
    expect(heard(0, 1, idleTrack(TRANSITION_STINGER_GAIN))).toBe(0);
  });

  /**
   * 스팅어 트랙은 **램프를 걸지 않는다** — 1.5초 컷이라 내릴 꼬리가 없다.
   * 램프가 없으므로 정리(`finish`)도 영영 나오지 않고, 게인은 만점 그대로 유지된다.
   * 여기서 램프가 생기면 매 전환마다 효과음이 페이드로 뭉개진다.
   */
  it('시간이 흘러도 게인이 1에서 움직이지 않고 정리도 나오지 않는다', () => {
    let track = idleTrack(1);
    const finishes: string[] = [];
    for (let now = 0; now <= 3_000; now += 50) {
      const stepped = stepGain(track, now);
      track = stepped.track;
      if (stepped.finish !== 'none') finishes.push(stepped.finish);
    }
    expect(track.gain).toBe(1);
    expect(track.ramp).toBeNull();
    expect(finishes).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. muted — 세 축 하나의 판정, 그러면서도 겹친다
// ─────────────────────────────────────────────────────────────────────────────

describe('스팅어 muted = outputMuted({monitor,userMuted,assetMuted}) (U102)', () => {
  /** display 의 `setOutputMuted(transitionVideoEl, asset?.audio === false)` 와 같은 판정 */
  const muted = (
    asset: AssetMeta | undefined,
    axes: { monitor: boolean; userMuted: boolean },
  ): boolean => outputMuted({ ...axes, assetMuted: asset?.audio === false });

  const OPEN = { monitor: false, userMuted: false };

  it('소리 있는 스팅어는 출력 창에서 소리를 낸다', () => {
    expect(muted(stinger(), OPEN)).toBe(false);
    expect(muted(stinger({ audio: true }), OPEN)).toBe(false);
  });

  it('운영자가 무음으로 눌러 둔 스팅어는 꺼진다', () => {
    expect(muted(stinger({ audio: false }), OPEN)).toBe(true);
  });

  it('소스를 아직 못 찾았으면 소리를 내지 않을 이유가 없다 (기본 켬)', () => {
    // `audio` 키가 없는 에셋 = 판정 전. `?? true` 폴백을 흐리지 않는다.
    expect(muted(stinger(), OPEN)).toBe(false);
  });

  it('PGM 모니터와 창 음소거는 에셋 판정과 무관하게 이긴다', () => {
    expect(muted(stinger(), { monitor: true, userMuted: false })).toBe(true);
    expect(muted(stinger(), { monitor: false, userMuted: true })).toBe(true);
    // 축이 걷히면 그대로 돌아온다 — 게인·램프에는 손대지 않으므로
    expect(muted(stinger(), OPEN)).toBe(false);
  });

  it('normalizeTransitionPlayback 은 muted 를 건드리지 않는다 (예열이 재생을 되돌리면 안 된다)', () => {
    const audible = { playbackRate: 0.5, defaultPlaybackRate: 0.5, loop: true, autoplay: true, muted: false };
    normalizeTransitionPlayback(audible);
    expect(audible.muted).toBe(false);
    expect(audible.autoplay).toBe(false);

    const silent = { ...audible, muted: true, autoplay: true };
    normalizeTransitionPlayback(silent);
    expect(silent.muted).toBe(true);
  });
});

describe('스팅어는 겹친다 — 덕킹·파킹이 붙지 않는다 (U102)', () => {
  it('전환이 도는 동안에도 videoAudioOwnsOutput 은 거짓이다 (음악이 안 내려간다)', () => {
    const state = createInitialState();
    state.assets = [stinger()];
    const playing = reducer(state, {
      type: 'transition/play',
      assetId: 'sting',
      nextScene: null,
      switchAtSec: 0.2,
      now: 1_000,
    });

    // 전환은 실제로 돌고 있다 (판정이 상태를 못 읽어 거짓인 것이 아니다)
    expect(playing.sceneOpts.transitionVideo.active).toBe(true);
    expect(playing.sceneOpts.transitionVideo.assetId).toBe('sting');
    // 그런데 덕킹·복귀 판정에는 잡히지 않는다 — 그 판정은 `sceneOpts.video`만 본다
    expect(videoAudioOwnsOutput(playing)).toBe(false);
    expect(playing.music.ducked).toBe(false);
  });

  it('덕킹 판정 소스에 전환이 섞이지 않는다 (계약 문장)', () => {
    const duck = readFileSync(new URL('./music-duck.ts', import.meta.url), 'utf8');
    expect(duck).toContain('const video = state.sceneOpts.video;');
    expect(duck).not.toMatch(/^(?!.*\*).*transitionVideo/m);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 소리가 막혀도 그림은 나간다 — 재시도 사다리 (리뷰 m5)
// ─────────────────────────────────────────────────────────────────────────────

interface LadderLog {
  demoted: number;
  locks: number;
  normalized: number;
  started: number;
  failed: number;
}

/** 거부 목록을 순서대로 뱉는 가짜 엘리먼트 — `undefined`면 그 시도는 성공이다 */
function fakeVideo(rejections: (unknown | undefined)[]) {
  const attempts: string[] = [];
  let muted = false;
  return {
    attempts,
    get muted() {
      return muted;
    },
    setMuted(value: boolean) {
      muted = value;
    },
    play(): Promise<void> {
      const index = attempts.length;
      attempts.push(muted ? 'muted' : 'audible');
      const rejection = rejections[index];
      return rejection === undefined ? Promise.resolve() : Promise.reject(rejection);
    },
  };
}

function handlers(video: ReturnType<typeof fakeVideo>, log: LadderLog): TransitionPlayHandlers {
  return {
    demoteToMuted: () => {
      log.demoted += 1;
      video.setMuted(true);
    },
    reportAudioLock: () => {
      log.locks += 1;
    },
    normalize: () => {
      log.normalized += 1;
    },
    onStarted: () => {
      log.started += 1;
    },
    onFailed: () => {
      log.failed += 1;
    },
  };
}

const err = (name: string): Error => Object.assign(new Error(name), { name });
const NOT_ALLOWED = err('NotAllowedError');
const ABORT = err('AbortError');

async function runLadder(rejections: (unknown | undefined)[]) {
  const video = fakeVideo(rejections);
  const log: LadderLog = { demoted: 0, locks: 0, normalized: 0, started: 0, failed: 0 };
  await playTransitionWithAudioFallback(video, handlers(video, log));
  return { video, log };
}

describe('재생 사다리 — 소리가 막혀도 전환 그림은 반드시 나간다 (U102 · 리뷰 m5)', () => {
  it('막히지 않으면 소리 있는 첫 재생 그대로 시작한다', async () => {
    const { video, log } = await runLadder([undefined]);
    expect(video.attempts).toEqual(['audible']);
    expect(log).toMatchObject({ started: 1, failed: 0, demoted: 0, locks: 0 });
    expect(video.muted).toBe(false);
  });

  it('NotAllowedError 면 muted 로 강등해 다시 틀고 잠금을 알린다', async () => {
    const { video, log } = await runLadder([NOT_ALLOWED, undefined]);
    // 두 번째 시도는 **무음으로** 나갔다 — 강등이 실제로 걸렸다는 증거
    expect(video.attempts).toEqual(['audible', 'muted']);
    expect(log).toMatchObject({ started: 1, failed: 0, demoted: 1, locks: 1 });
    // 재시도 전에 시각 계약(autoplay·속도)을 다시 세운다
    expect(log.normalized).toBe(1);
  });

  /**
   * **리뷰 m5 가 잡은 구멍의 회귀 테스트.**
   * 첫 거부가 `AbortError`(소스 교체가 밀어냄)라 강등 없이 재시도했는데, 그 재시도가
   * `NotAllowedError` 로 떨어지는 경우. 예전 구현은 여기서 곧장 로컬 종료로 가서
   * **전환 그림이 통째로 스킵**됐다. 지금은 두 번째 거부도 같은 규칙으로 분류한다.
   */
  it('AbortError → NotAllowedError 순서에서도 강등 기회가 온다 (그림이 스킵되지 않는다)', async () => {
    const { video, log } = await runLadder([ABORT, NOT_ALLOWED, undefined]);
    expect(video.attempts).toEqual(['audible', 'audible', 'muted']);
    expect(log).toMatchObject({ started: 1, failed: 0, demoted: 1, locks: 1 });
  });

  it('AbortError 만 이어지면 강등도 잠금 배너도 없다 (거짓 잠금 금지 · U48 후속)', async () => {
    const { video, log } = await runLadder([ABORT, ABORT]);
    expect(video.attempts).toEqual(['audible', 'audible']);
    expect(log).toMatchObject({ demoted: 0, locks: 0, started: 0, failed: 1 });
    expect(video.muted).toBe(false);
  });

  it('무음으로 내려도 안 되면 한 번만 더 시도하고 놓는다 (죽은 전환을 붙잡지 않는다)', async () => {
    const { video, log } = await runLadder([NOT_ALLOWED, NOT_ALLOWED]);
    expect(video.attempts).toEqual(['audible', 'muted']);
    // 강등은 한 번뿐이다 — 이미 무음인데 또 막히면 정책이 아니라 다른 문제다
    expect(log).toMatchObject({ demoted: 1, locks: 1, started: 0, failed: 1 });
  });

  it('시도는 최대 세 번이다 (워치독 마감까지 씬을 붙잡지 않는다)', async () => {
    const { video, log } = await runLadder([ABORT, NOT_ALLOWED, NOT_ALLOWED]);
    expect(video.attempts).toHaveLength(3);
    expect(log).toMatchObject({ started: 0, failed: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 배선 — 위 판정들이 display 에 실제로 꽂혀 있는가 (원문 스캔은 여기 둘뿐)
// ─────────────────────────────────────────────────────────────────────────────

describe('display 배선 (U102)', () => {
  it('전환도 게인 매니저 트랙이고 창 음소거 목록에 들어 있다', () => {
    expect(display).toMatch(
      /const transitionMedia: GatedMedia = \{\s*\n\s*el: transitionVideoEl,\s*\n\s*track: idleTrack\(TRANSITION_STINGER_GAIN\),/,
    );
    expect(display).toContain('gatedMedia.push(transitionMedia);');
    expect(display).toContain(
      'return [musicDecks[0].el, musicDecks[1].el, videoEl, overlayVideoEl, camEl, transitionVideoEl];',
    );
    // `.muted`를 직접 쓰는 우회는 없다 — 판정은 `setOutputMuted` 하나
    expect(display).not.toMatch(/transitionVideoEl\.muted\s*=/);
  });

  it('재생은 사다리를 지나고, 바깥 손잡이 넷이 각자 단일 경로에 꽂혀 있다', () => {
    const call = display.slice(
      display.indexOf('void playTransitionWithAudioFallback(transitionVideoEl, {'),
      display.indexOf('// ---------------------------------------------------------------- 현장 사진 슬라이드쇼'),
    );
    expect(call).toContain('demoteToMuted: () => setOutputMuted(transitionVideoEl, true),');
    expect(call).toContain('needsAudioUnlock = true;');
    expect(call).toContain('reportAudioState();');
    expect(call).toContain('normalize: () => normalizeTransitionPlayback(transitionVideoEl),');
    expect(call).toContain('onStarted: markBound,');
    expect(call).toContain('onFailed: () => finishTransitionLocally(token),');
    // 옛 인라인 catch 사다리가 남아 있으면 주인이 둘이 된다
    expect(display).not.toContain('void transitionVideoEl\n    .play()');
  });
});
