/**
 * U101 — 분위기 반전이 도는 중에 다른 컷으로 넘어갈 때 **오버레이 소리가 뚝 끊긴다.**
 *
 * 사용자 신고(04:06) — "파트1 글리치+분위기반전영상에서 다른 컷 넘어가면 오디오가 툭 끊김.
 * 여기만 페이드가 적용이 안 돼 있어."
 *
 * ## 어긋남의 정체
 * `mood/abort`는 `moodTransition.active`와 `overlayVideo.active`를 **같은 프레임에** 내린다.
 * display의 `paint()`는 그 프레임에서
 *
 *   1. `updateMoodVisual()` — `moodOwnsOverlay()`가 false가 됐으므로 `#overlay-video`를
 *      **그 자리에서 `muted = true`로 만들고**,
 *   2. `ensureOverlayVideo()` — 오버레이가 꺼졌으므로 `clearOverlayVideo()` →
 *      `requestAudioTeardown(overlayMedia, 'release')`로 `audioCutFadeSec` 램프를 건다
 *
 * 를 이 순서로 한다. 램프는 정상적으로 돌지만 **이미 음소거된 엘리먼트 위에서** 돈다 —
 * 들리는 것은 하드 컷이고, 페이드는 아무도 듣지 못한 채 끝난다.
 *
 * 카메라는 정확히 같은 사고를 U27 D5-3에서 겪고 `cameraMuted()`로 막아 두었다("치웠다는
 * 사실만으로 끄지 않는다 — 실제로 끄는 것은 게인이 0에 닿았을 때뿐이다"). 오버레이에는
 * 그 방어가 없었다. 그래서 `overlayMuted()`가 같은 자리에 같은 규칙으로 들어간다.
 */

// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { idleTrack, overlayMuted, rampGain, stepGain, type GainTrack } from './audio-gain';
import { moodOwnsOverlay } from './mood-visual';
import { MOOD_PART1_ASSET_ID, routeMoodSceneActions } from './mood-routing';
import { routeSceneActionsThroughDefaultTransition } from './scene-routing';
import { createInitialState, reducer, type Action } from './state';
import type { AppState } from './types';

const NOW = 1_788_600_000_000;

function run(state: AppState, ...actions: Action[]): AppState {
  return actions.reduce(reducer, state);
}

/** control의 디스패치 깔때기와 **같은 순서** (`mood-scene-cover.test.ts`와 동일) */
function route(state: AppState, actions: Action[]): Action[] {
  return routeSceneActionsThroughDefaultTransition(state, routeMoodSceneActions(state, actions), NOW);
}

/** 반전 영상이 소리를 내며 도는 상태를 만든다 */
function moodPlaying(phase: 'glitch' | 'blackout' | 'crossfade'): AppState {
  let s = run(
    createInitialState(),
    { type: 'p2/unlock' },
    { type: 'scene/set', scene: 'live' },
    { type: 'mood/start', assetId: MOOD_PART1_ASSET_ID },
  );
  const token = s.sceneOpts.moodTransition.token;
  if (phase !== 'glitch') s = run(s, { type: 'mood/blackout', token });
  if (phase === 'crossfade') s = run(s, { type: 'mood/crossfade', token });
  expect(s.sceneOpts.moodTransition.phase).toBe(phase);
  expect(s.sceneOpts.overlayVideo.assetId).toBe(MOOD_PART1_ASSET_ID);
  return s;
}

/**
 * display의 매 프레임 오버레이 음소거 정책을 흉내 낸다.
 *
 * `policy: 'legacy'`는 U101 이전의 display 그대로다(`!moodOwnsOverlay(...)`) — 이 분기가
 * 남아 있는 한 테스트는 하드 컷을 그대로 재현한다. `'managed'`가 새 판정이다.
 */
function traceCut(state: AppState, policy: 'legacy' | 'managed', fadeSec: number) {
  const mood = state.sceneOpts.moodTransition;
  const overlay = state.sceneOpts.overlayVideo;
  const moodOwned = moodOwnsOverlay(mood, overlay.assetId);
  // 반전이 놓은 뒤에도 남는 사실 — 이 엘리먼트에 물려 있는 소스가 반전이 튼 것인가
  let moodSource = true;

  // `clearOverlayVideo()` → `requestAudioTeardown(overlayMedia, 'release', now)`
  let track: GainTrack = rampGain(idleTrack(1), 0, fadeSec, 0, 'release');
  const frames: { gain: number; muted: boolean }[] = [];
  const after: { gain: number; muted: boolean }[] = [];
  let released = false;

  for (let frame = 0; frame <= 200; frame += 1) {
    const stepped = stepGain(track, frame * 16);
    track = stepped.track;
    if (stepped.finish === 'release') {
      released = true;
      moodSource = false; // overlayMedia.finish
    }
    const muted =
      policy === 'legacy'
        ? !moodOwned
        : overlayMuted({
            moodOwned,
            policyBlocked: false,
            moodSource,
            // 반전 영상은 매니페스트상 `mode: 'full'`이라 오버레이 에셋 축에는 걸리지 않는다 —
            // 이 갈래를 지키는 것은 `moodOwned`·`moodSource` 둘뿐이다.
            assetAudio: false,
            gain: track.gain,
          });
    (released ? after : frames).push({ gain: track.gain, muted });
  }
  return { during: frames, after, released };
}

describe('분위기 반전 오버레이의 컷 오디오 (U101)', () => {
  const fadeSec = createInitialState().settings.audioCutFadeSec;

  it('다음 큐는 반전이 도는 어느 단계에서든 `mood/abort`로 오버레이를 끈다', () => {
    for (const phase of ['glitch', 'blackout', 'crossfade'] as const) {
      const state = moodPlaying(phase);
      const routed = route(state, [{ type: 'scene/set', scene: 'standby' }]);
      expect(routed[0]).toEqual({ type: 'mood/abort', token: state.sceneOpts.moodTransition.token });
      const next = routed.reduce(reducer, state);
      // 오버레이·반전이 같은 프레임에 함께 꺼진다 — 소리의 주인이 여기서 사라진다
      expect(next.sceneOpts.moodTransition.active).toBe(false);
      expect(next.sceneOpts.overlayVideo.active).toBe(false);
      expect(moodOwnsOverlay(next.sceneOpts.moodTransition, next.sceneOpts.overlayVideo.assetId)).toBe(false);
    }
  });

  /**
   * 반전 오버레이의 소리를 끊을 수 있는 **모든 입구**가 같은 모양으로 수렴하는지 본다.
   * 하나라도 다른 모양이면 그 경로만 페이드를 잃는다(U101이 바로 그 형태였다).
   */
  it('설명 영상 전환도 같은 자리로 수렴한다 — 오버레이·반전이 함께 꺼진다', () => {
    const state = moodPlaying('blackout');
    const token = state.sceneOpts.moodTransition.token;

    // ① 설명 영상 전환 — `routeMoodSceneActions`가 같은 배열 앞에 `mood/abort`를 넣는다 (D2)
    const full = routeMoodSceneActions(state, [
      { type: 'video/playFull', assetId: 'media:x.mp4', nextScene: null, now: NOW },
    ]);
    expect(full[0]).toEqual({ type: 'mood/abort', token });

    // ② 씬 교체는 라우팅의 `mood/abort` 없이도 `resetRuntimeVideoPhase`가 같은 자리에서 끊는다
    for (const actions of [full, [{ type: 'scene/set', scene: 'standby' } as const]]) {
      const next = (actions as Action[]).reduce(reducer, state);
      expect(next.sceneOpts.moodTransition.active).toBe(false);
      expect(next.sceneOpts.overlayVideo.active).toBe(false);
      expect(moodOwnsOverlay(next.sceneOpts.moodTransition, next.sceneOpts.overlayVideo.assetId)).toBe(false);
    }
  });

  /**
   * `video/abort`(⏭ 스킵)는 **혼자서는 반전을 끊지 않는다** — 설명 영상 단계가 `idle`이라
   * 리듀서가 그 자리에서 되돌아 나간다. 끊는 것은 스킵이 이어 내는 `scene/set`이고,
   * 그래서 스킵도 결국 위의 한 경로로 수렴한다. 이 사실이 뒤집히면(스킵이 반전만 끄고
   * 씬을 안 바꾸게 되면) 소리의 주인이 둘로 갈리므로 여기서 잡는다.
   */
  it('`video/abort` 단독은 반전을 건드리지 않는다 — 끊는 것은 뒤따르는 `scene/set`이다', () => {
    const state = moodPlaying('blackout');
    expect(state.sceneOpts.video.phase).toBe('idle');
    const onlyAbort = reducer(state, { type: 'video/abort' });
    expect(onlyAbort.sceneOpts.moodTransition.active).toBe(true);
    expect(onlyAbort.sceneOpts.overlayVideo.active).toBe(true);
    const withScene = route(onlyAbort, [{ type: 'scene/set', scene: 'standby' }]).reduce(
      reducer,
      onlyAbort,
    );
    expect(withScene.sceneOpts.moodTransition.active).toBe(false);
    expect(withScene.sceneOpts.overlayVideo.active).toBe(false);
  });

  /** **재현.** U101 이전 정책은 컷 첫 프레임부터 muted다 — 램프가 안 들린다. */
  it('옛 정책(`!moodOwnsOverlay`)은 첫 프레임부터 음소거라 페이드가 들릴 자리가 없다', () => {
    const state = run(moodPlaying('glitch'), { type: 'mood/abort', token: 1 });
    const { during } = traceCut(state, 'legacy', fadeSec);
    expect(during.length).toBeGreaterThan(30);
    // 게인은 멀쩡히 내려가는데(램프는 돈다) 전 구간이 muted다 = 하드 컷
    expect(during[0].gain).toBeGreaterThan(0);
    expect(during.every((f) => f.muted)).toBe(true);
  });

  it('새 정책은 램프가 도는 동안 실제로 들린다 — 매 프레임 unmuted이고 볼륨이 단조 하강한다', () => {
    const state = run(moodPlaying('glitch'), { type: 'mood/abort', token: 1 });
    const { during } = traceCut(state, 'managed', fadeSec);
    expect(during.length).toBeGreaterThan(30);
    for (const f of during) {
      expect(f.muted).toBe(false);
      expect(f.gain).toBeGreaterThan(0);
    }
    for (let i = 1; i < during.length; i += 1) {
      expect(during[i].gain).toBeLessThanOrEqual(during[i - 1].gain + 1e-9);
    }
    expect(during[during.length - 1].gain).toBeLessThan(during[0].gain);
  });

  it('0에 닿은 뒤에는 muted로 잠기고 다시 열리지 않는다', () => {
    const state = run(moodPlaying('crossfade'), { type: 'mood/abort', token: 1 });
    const { after, released } = traceCut(state, 'managed', fadeSec);
    expect(released).toBe(true);
    expect(after.length).toBeGreaterThanOrEqual(60);
    for (const f of after) {
      expect(f.gain).toBe(0);
      expect(f.muted).toBe(true);
    }
  });

  it('반전이 주인인 동안에는 언제나 열려 있다 (게인·소스 판정과 무관)', () => {
    const base = { policyBlocked: false, assetAudio: false } as const;
    expect(overlayMuted({ ...base, moodOwned: true, moodSource: true, gain: 1 })).toBe(false);
    expect(overlayMuted({ ...base, moodOwned: true, moodSource: false, gain: 0 })).toBe(false);
  });

  it('반전도 아니고 소리도 없는 오버레이는 음소거다 (무음 파일 · 승리 영상)', () => {
    expect(
      overlayMuted({ moodOwned: false, policyBlocked: false, moodSource: false, assetAudio: false, gain: 1 }),
    ).toBe(true);
  });

  it('자동재생 정책에 막힌 창은 무엇보다 먼저 음소거다', () => {
    const base = { moodSource: true, assetAudio: true, gain: 1 } as const;
    expect(overlayMuted({ ...base, moodOwned: true, policyBlocked: true })).toBe(true);
    expect(overlayMuted({ ...base, moodOwned: false, policyBlocked: true })).toBe(true);
  });

  it('페이드 길이를 0으로 둔 운영자는 컷을 고른 것이다 — 즉시 0이고 즉시 muted', () => {
    const state = run(moodPlaying('glitch'), { type: 'mood/abort', token: 1 });
    const { during, after } = traceCut(state, 'managed', 0);
    expect(during).toHaveLength(0);
    expect(after[0]).toEqual({ gain: 0, muted: true });
  });

  /** **계약 잠금.** display가 이 판정을 실제로 거치는지 소스로 고정한다. */
  describe('display 배선', () => {
    const display = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');

    it('`#overlay-video`의 muted는 `overlayMuted()`를 거친 단일 자리에서만 정해진다', () => {
      expect(display).toContain('function applyOverlayMute(): void {');
      expect(display).toContain('overlayMuted({');
      // 인라인 `!moodOwnsOverlay(...)`로 곧장 muted를 심던 옛 배선이 남아 있으면 안 된다
      expect(display).not.toMatch(/setOutputMuted\(\s*overlayVideoEl,\s*!moodOwned/);
      expect(display).not.toMatch(/setOutputMuted\(\s*overlayVideoEl,\s*\n?\s*!moodOwnsOverlay/);
    });

    it('반전이 튼 소스라는 사실을 붙일 때 기록하고 정리에서 지운다', () => {
      expect(display).toContain('overlayMoodSource = moodOwned;');
      expect(display).toContain('overlayMoodSource = false;');
    });

    it('컷 정리는 예전 그대로 매니저의 `release` 램프다 — 새 페이드 축을 만들지 않았다', () => {
      expect(display).toContain("requestAudioTeardown(overlayMedia, 'release', Date.now());");
    });
  });
});

/**
 * 소리 있는 오버레이 (U101b · 리뷰 C1) — 매치 영상 v003.
 *
 * U101은 "반전이 튼 소스가 아니면 음소거"로 닫았다. 그 시점에는 이 슬롯의 손님(매치 6 ·
 * 승리 4)이 전부 무음 파일이라 결과가 같았지만, 04:49에 매치 영상이 Opus 트랙이 있는
 * v003으로 교체되면서 **소리가 있는데 영영 안 들리는** 자리가 됐다.
 *
 * 반전과 **같은 수준**으로 고정한다: 붙는 순간의 진입 램프 인과 컷의 꼬리 페이드가 매 프레임
 * 실제로 들려야 한다(U27 전역 계약 — 들리는 매체는 어떤 경로로도 곡선 없이 끊기지 않는다).
 */
describe('소리 있는 오버레이의 램프 (U101b)', () => {
  const fadeSec = createInitialState().settings.audioCutFadeSec;
  /** display의 진입 램프: `rampGain(idleTrack(0), 1, MOOD_AUDIO_RAMP_SEC, now)` */
  const RAMP_IN_SEC = 0.6;

  /** 소리 있는 매치 오버레이 한 편의 매 프레임 (gain, muted) — 붙는 순간부터 */
  function traceEnter(assetAudio: boolean) {
    let track: GainTrack = assetAudio
      ? rampGain(idleTrack(0), 1, RAMP_IN_SEC, 0)
      : idleTrack(1);
    const frames: { gain: number; muted: boolean }[] = [];
    for (let frame = 0; frame <= 200; frame += 1) {
      track = stepGain(track, frame * 16).track;
      frames.push({
        gain: track.gain,
        muted: overlayMuted({
          moodOwned: false,
          policyBlocked: false,
          moodSource: false,
          assetAudio,
          gain: track.gain,
        }),
      });
    }
    return frames;
  }

  /** 같은 오버레이의 컷 꼬리 — `requestAudioTeardown(overlayMedia, 'release')` */
  function traceOverlayCut(assetAudio: boolean) {
    let track: GainTrack = rampGain(idleTrack(1), 0, fadeSec, 0, 'release');
    let sourceAudio = assetAudio;
    const during: { gain: number; muted: boolean }[] = [];
    const after: { gain: number; muted: boolean }[] = [];
    let released = false;
    for (let frame = 0; frame <= 200; frame += 1) {
      const stepped = stepGain(track, frame * 16);
      track = stepped.track;
      if (stepped.finish === 'release') {
        released = true;
        sourceAudio = false; // overlayMedia.finish
      }
      const muted = overlayMuted({
        moodOwned: false,
        policyBlocked: false,
        moodSource: false,
        assetAudio: sourceAudio,
        gain: track.gain,
      });
      (released ? after : during).push({ gain: track.gain, muted });
    }
    return { during, after, released };
  }

  it('진입은 0에서 1로 올라오고 그동안 내내 열려 있다 — 붙는 순간의 클릭이 없다', () => {
    const frames = traceEnter(true);
    expect(frames[0].gain).toBeLessThan(0.2);
    for (const f of frames) expect(f.muted).toBe(false);
    for (let i = 1; i < frames.length; i += 1) {
      expect(frames[i].gain).toBeGreaterThanOrEqual(frames[i - 1].gain - 1e-9);
    }
    expect(frames[frames.length - 1].gain).toBe(1);
  });

  it('무음 파일은 램프 없이 바로 붙고 계속 음소거다 — 올릴 소리가 없다', () => {
    const frames = traceEnter(false);
    for (const f of frames) {
      expect(f.muted).toBe(true);
      expect(f.gain).toBe(1);
    }
  });

  it('컷 꼬리가 매 프레임 실제로 들린다 — 단조 하강 · 전 구간 unmuted', () => {
    const { during } = traceOverlayCut(true);
    expect(during.length).toBeGreaterThan(30);
    for (const f of during) {
      expect(f.muted).toBe(false);
      expect(f.gain).toBeGreaterThan(0);
    }
    for (let i = 1; i < during.length; i += 1) {
      expect(during[i].gain).toBeLessThanOrEqual(during[i - 1].gain + 1e-9);
    }
    expect(during[during.length - 1].gain).toBeLessThan(during[0].gain);
  });

  it('꼬리가 끝나면 muted로 잠기고 다시 열리지 않는다', () => {
    const { after, released } = traceOverlayCut(true);
    expect(released).toBe(true);
    expect(after.length).toBeGreaterThanOrEqual(60);
    for (const f of after) {
      expect(f.gain).toBe(0);
      expect(f.muted).toBe(true);
    }
  });

  /** **재현.** U101b 이전 판정(`assetAudio` 축 없음)은 이 오버레이를 통째로 음소거했다. */
  it('옛 판정에는 에셋 축이 없어 소리 있는 매치 영상이 영영 안 들렸다', () => {
    const legacyMuted = (moodSource: boolean, gain: number): boolean => !(moodSource && gain > 0);
    for (const gain of [1, 0.5, 0.01]) expect(legacyMuted(false, gain)).toBe(true);
    // 같은 자리에서 새 판정은 열려 있다
    expect(
      overlayMuted({ moodOwned: false, policyBlocked: false, moodSource: false, assetAudio: true, gain: 1 }),
    ).toBe(false);
  });

  describe('display 배선 (U101b)', () => {
    const display = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');

    it('에셋 축은 덕킹과 **같은 함수**로 판정한다', () => {
      expect(display).toContain("import { overlayPlaysAudio } from './music-duck';");
      expect(display).toContain('assetAudio: overlaySourceAudio,');
      expect(display).toContain('overlaySourceAudio = overlayPlaysAudio(');
    });

    it('소리 있는 오버레이도 반전과 같은 진입 램프를 탄다', () => {
      expect(display).toContain('moodOwned || overlaySourceAudio');
      expect(display).toContain('rampGain(idleTrack(0), 1, MOOD_AUDIO_RAMP_SEC, Date.now())');
    });

    it('재생 중에는 상태의 에셋 플래그를 매 프레임 다시 읽는다 (운영자 토글 즉시 반영)', () => {
      expect(display).toContain('overlay.assetId === overlayAssetId');
    });
  });

  describe('에셋 카드 배선 (U101b)', () => {
    const sections = readFileSync(new URL('./control/asset-sections.ts', import.meta.url), 'utf8');
    const tab = readFileSync(new URL('./control/tab-assets.ts', import.meta.url), 'utf8');

    it('소리 배지는 영상 모드 전부에 붙는다 — overlay만 빠지면 안 된다', () => {
      expect(sections).not.toMatch(/audio:\s*\n?\s*mode === 'full' \|\| mode === 'transition'/);
      expect(sections).toContain("audio: mode ? (asset.audio === false ? '무음' : '소리 켬') : null,");
    });

    it('소리 토글도 영상 모드 전부에 붙고 오버레이 전용 안내가 있다', () => {
      expect(tab).not.toMatch(/mode === 'full' \|\| mode === 'transition'\s*\n\s*\? el\('button'/);
      expect(tab).toContain("mode === 'overlay'");
      expect(tab).toContain('매치·승리 오버레이는 제 소리를 냅니다');
    });
  });
});
