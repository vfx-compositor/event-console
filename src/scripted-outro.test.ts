// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  FADE_BASE_COLOR,
  normalizeVideoOutro,
  outroRuntime,
  scriptedOutroForAsset,
  scriptedOutroForCueId,
  scriptedOutroForFile,
} from './scripted-outro';
import {
  cueTransitionOf,
  hasCueTransitions,
  lockedCueTransition,
  lockedCueTransitionTip,
  normalizeCueTransitions,
  setCueTransition,
} from './cue-transitions';
import { cueWithVideos } from './cue';
import { shouldStartVideoTail } from './video-hold';
import { tailStartSec } from './fade';
import { createInitialState, deserialize, reducer, serialize } from './state';
import type { AppState, AssetMeta } from './types';

const INTRO_FILE = 'olympic_intro_v001.mp4';
const INTRO_ASSET = `media:${INTRO_FILE}`;
const INTRO_CUE = `video:${INTRO_ASSET}`;
const T0 = 1_700_000_000_000;

/**
 * 실제 manifest와 같은 모양의 올림픽 인트로 에셋.
 *
 * `holdEndFrame: true`가 **일부러** 들어 있다 — 배포된 manifest의 값이고, 이 지시(U87)의 발단이다.
 * 아웃트로가 그 값을 이겨야 꼬리 페이드가 시작된다.
 */
function introAsset(over: Partial<AssetMeta> = {}): AssetMeta {
  return {
    id: INTRO_ASSET,
    name: '올림픽 인트로',
    type: 'video',
    size: 1,
    mime: 'video/mp4',
    playMode: 'full',
    nextScene: 'standby',
    cueAfter: 'pre-mission',
    holdEndFrame: true,
    order: 1,
    ...over,
  };
}

describe('대본 아웃트로 표 (U87)', () => {
  it('올림픽 인트로는 5초 · 화이트 · 대기 화면 · 2초 페이드 인이다', () => {
    const outro = scriptedOutroForFile(INTRO_FILE);
    expect(outro).toMatchObject({
      fadeSec: 5,
      color: '#ffffff',
      nextScene: 'standby',
      revealSec: 2,
      boundaryMode: 'white',
    });
  });

  it('에셋 id·큐 id 어느 쪽으로도 같은 값을 찾는다', () => {
    expect(scriptedOutroForAsset(INTRO_ASSET)).toBe(scriptedOutroForFile(INTRO_FILE));
    expect(scriptedOutroForCueId(INTRO_CUE)).toBe(scriptedOutroForFile(INTRO_FILE));
  });

  it('대본에 없는 영상은 null — 아무 영상에나 화이트 아웃이 붙지 않는다', () => {
    expect(scriptedOutroForFile('260831_pt2_v001.mp4')).toBeNull();
    expect(scriptedOutroForAsset('media:intro_curling.mp4')).toBeNull();
    expect(scriptedOutroForAsset(null)).toBeNull();
    // 큐 id가 아닌 문자열(씬 큐)은 접두사가 달라 걸리지 않는다
    expect(scriptedOutroForCueId('open')).toBeNull();
    expect(scriptedOutroForCueId(null)).toBeNull();
  });

  it('기본 페이드 색은 검정이다 — 아웃트로가 없으면 지금까지 그대로다', () => {
    expect(FADE_BASE_COLOR).toBe('#000000');
  });

  describe('저장본 복원', () => {
    it('세 값이 다 성하면 그대로 살린다', () => {
      const runtime = outroRuntime(scriptedOutroForFile(INTRO_FILE)!);
      expect(normalizeVideoOutro(runtime)).toEqual(runtime);
    });

    it('한 값이라도 깨지면 통째로 버린다 — 반쯤 살아난 아웃트로가 더 위험하다', () => {
      expect(normalizeVideoOutro({ fadeSec: 5, revealSec: 2 })).toBeNull();
      expect(normalizeVideoOutro({ fadeSec: 5, color: '', revealSec: 2 })).toBeNull();
      expect(normalizeVideoOutro({ fadeSec: -1, color: '#fff', revealSec: 2 })).toBeNull();
      expect(normalizeVideoOutro({ fadeSec: Number.NaN, color: '#fff', revealSec: 2 })).toBeNull();
      expect(normalizeVideoOutro({ fadeSec: 5, color: '#fff', revealSec: 'x' })).toBeNull();
      expect(normalizeVideoOutro(null)).toBeNull();
      expect(normalizeVideoOutro([])).toBeNull();
      expect(normalizeVideoOutro('white')).toBeNull();
    });
  });
});

describe('꼬리 페이드 계획 (U87)', () => {
  const DURATION = 63;

  it('꼬리는 duration − 5초에서 시작한다 — 전역 페이드(0.5초)가 아니다', () => {
    expect(tailStartSec(DURATION, 5)).toBe(58);
    expect(tailStartSec(DURATION, 0.5)).toBe(62.5);
  });

  it('5초 앞에서는 아직 꼬리에 들어가지 않고, 5초 지점부터 들어간다', () => {
    const at = (t: number) => shouldStartVideoTail(false, false, t, DURATION, 5);
    expect(at(57.9)).toBe(false);
    expect(at(58)).toBe(true);
    expect(at(DURATION)).toBe(true);
  });

  it('holdEndFrame이 남아 있으면 꼬리가 영영 열리지 않는다 — 그래서 상태에서 끈다', () => {
    expect(shouldStartVideoTail(true, true, DURATION, DURATION, 5)).toBe(false);
  });
});

describe('올림픽 인트로 재생 — 상태 머신 (U87)', () => {
  function playing(): AppState {
    const before = createInitialState();
    before.assets = [introAsset()];
    const covering = reducer(before, {
      type: 'video/playFull',
      assetId: INTRO_ASSET,
      // 큐가 무엇을 넘기든 아웃트로가 이긴다 — 일부러 엉뚱한 씬을 넘겨 본다
      nextScene: 'score',
      now: T0,
    });
    return reducer(covering, { type: 'video/covered', token: 1 });
  }

  it('playFull은 아웃트로를 싣고, holdEndFrame과 nextScene을 대본 값으로 덮는다', () => {
    const before = createInitialState();
    before.assets = [introAsset()];
    const covering = reducer(before, {
      type: 'video/playFull',
      assetId: INTRO_ASSET,
      nextScene: 'score',
      now: T0,
    });
    expect(covering.sceneOpts.video).toMatchObject({
      phase: 'covering',
      // manifest가 true인데도 false다 — 아웃트로가 끝을 책임진다
      holdEndFrame: false,
      nextScene: 'standby',
      outro: { fadeSec: 5, color: '#ffffff', revealSec: 2 },
    });
    // 들어가는 페이드 길이는 전역 그대로 — 아웃트로는 끝만 정한다
    expect(covering.sceneOpts.video.fadeSec).toBe(0.5);
  });

  it('covering → playing → revealing 을 거쳐 대기 화면(main)에 내린다', () => {
    const play = playing();
    expect(play.scene).toBe('video');
    expect(play.sceneOpts.video.phase).toBe('playing');

    const revealing = reducer(play, { type: 'video/tail', token: 1 });
    expect(revealing.scene).toBe('standby');
    expect(revealing.sceneOpts.standby.mode).toBe('main');
    expect(revealing.sceneOpts.video.phase).toBe('revealing');
    // 걷는 동안에도 색이 남아 있어야 화이트에서 페이드 인이 된다
    expect(revealing.sceneOpts.video.outro?.color).toBe('#ffffff');

    const idle = reducer(revealing, { type: 'video/revealed', token: 1 });
    expect(idle.scene).toBe('standby');
    expect(idle.sceneOpts.video.phase).toBe('idle');
  });

  it('holding으로 새지 않는다 — video/held는 holdEndFrame이 꺼져 무시된다', () => {
    const play = playing();
    expect(reducer(play, { type: 'video/held', token: 1 })).toBe(play);
  });

  it('아웃트로가 없는 영상은 지금까지 그대로 — outro는 null이고 holdEndFrame은 살아난다', () => {
    const before = createInitialState();
    before.assets = [
      { id: 'media:hold.mp4', name: '홀드', type: 'video', size: 1, mime: 'video/mp4', holdEndFrame: true },
    ];
    const covering = reducer(before, {
      type: 'video/playFull',
      assetId: 'media:hold.mp4',
      nextScene: 'score',
      now: T0,
    });
    expect(covering.sceneOpts.video.outro).toBeNull();
    expect(covering.sceneOpts.video.holdEndFrame).toBe(true);
    expect(covering.sceneOpts.video.nextScene).toBe('score');
  });

  it('sceneOpts/patch로는 아웃트로를 덮을 수 없다 (런타임 필드)', () => {
    const play = playing();
    const patched = reducer(play, {
      type: 'sceneOpts/patch',
      patch: { video: { outro: { fadeSec: 0, color: '#000000', revealSec: 0 } } },
    });
    expect(patched.sceneOpts.video.outro).toEqual({ fadeSec: 5, color: '#ffffff', revealSec: 2 });
  });

  it('직렬화 라운드트립에서 살아남고, 이 필드가 없던 옛 저장본은 null로 내려앉는다', () => {
    const play = playing();
    expect(deserialize(serialize(play)).sceneOpts.video.outro).toEqual({
      fadeSec: 5,
      color: '#ffffff',
      revealSec: 2,
    });

    const legacy = JSON.parse(serialize(play)) as Record<string, unknown>;
    const sceneOpts = legacy.sceneOpts as Record<string, Record<string, unknown>>;
    delete sceneOpts.video.outro;
    expect(deserialize(JSON.stringify(legacy)).sceneOpts.video.outro).toBeNull();
  });
});

describe('올림픽 인트로 큐 항목 (U87)', () => {
  const item = () => cueWithVideos([introAsset()]).find((c) => c.id === INTRO_CUE);

  it('사전미션 다음 자리에 그대로 있고, 끝나는 자리는 대기 화면이다', () => {
    const cue = item();
    expect(cue).toBeDefined();
    expect(cue!.videoNextScene).toBe('standby');
  });

  it('힌트가 실제 동작을 말한다 — 5초 오디오 페이드 · 화이트 · 대본 고정', () => {
    const hint = item()!.hint;
    expect(hint).toContain('5초');
    expect(hint).toContain('화이트');
    expect(hint).toContain('대본 고정');
  });

  it('큐 항목의 holdEndFrame도 꺼져 있다 — 상태와 화면이 같은 말을 해야 한다', () => {
    expect(item()!.holdEndFrame).toBe(false);
  });
});

describe('큐 경계 잠금 (U87)', () => {
  it('올림픽 인트로 경계는 화이트로 고정이고, 다른 경계는 잠기지 않는다', () => {
    expect(lockedCueTransition(INTRO_CUE)).toBe('white');
    expect(lockedCueTransition('open')).toBeNull();
    expect(lockedCueTransition(null)).toBeNull();
    expect(lockedCueTransitionTip(INTRO_CUE)).toContain('5초');
    expect(lockedCueTransitionTip('open')).toBeNull();
  });

  it('저장본에 무엇이 들어 있어도 해석 결과는 화이트다', () => {
    for (const stored of ['black', 'stinger', 'white'] as const) {
      expect(cueTransitionOf({ [INTRO_CUE]: stored }, INTRO_CUE)).toBe('white');
    }
    // 잠기지 않은 경계는 지금까지 그대로 저장본을 따른다
    expect(cueTransitionOf({ open: 'black' }, 'open')).toBe('black');
  });

  it('setCueTransition은 잠긴 경계에 아무것도 쓰지 않는다', () => {
    const map = { open: 'black' } as const;
    expect(setCueTransition(map, INTRO_CUE, 'stinger')).toBe(map);
    expect(setCueTransition(map, INTRO_CUE, null)).toBe(map);
  });

  it('복원할 때 잠긴 경계의 옛 지정은 버린다 — 죽은 키가 [전부 전역으로]를 켜지 않는다', () => {
    const restored = normalizeCueTransitions({ [INTRO_CUE]: 'stinger' });
    expect(restored).toEqual({});
    expect(hasCueTransitions(restored)).toBe(false);
  });

  it('리듀서를 거쳐도 잠긴 경계에는 값이 쌓이지 않는다', () => {
    const after = reducer(createInitialState(), {
      type: 'cueTransitions/set',
      cueId: INTRO_CUE,
      mode: 'black',
    });
    expect(after.cueTransitions[INTRO_CUE]).toBeUndefined();
  });
});

/**
 * **계약 잠금.** 아웃트로의 소리는 게인 매니저를 통해서만 움직여야 하고, 잠긴 경계는 화면에서
 * 이유와 함께 막혀 있어야 한다. 코드에서 그 자리를 직접 훑는다 (vitest 환경이 node라 DOM 없음).
 */
describe('아웃트로 구현 계약 (U87)', () => {
  const display = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');
  const cuesheet = readFileSync(new URL('./control/cuesheet.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./styles/control.css', import.meta.url), 'utf8');

  it('꼬리 구간의 오디오는 setGain(볼륨 매니저)으로만 움직인다', () => {
    const tail = display.slice(display.indexOf("if (v.phase === 'playing') {"));
    const branch = tail.slice(0, tail.indexOf("if (v.phase === 'holding')"));
    expect(branch).toContain('videoMedia.track = setGain(videoMedia.track, volumeForOpacity(opacity))');
    // 이 구간이 엘리먼트 볼륨을 직접 만지면 매니저의 정리 예약이 무시된다
    expect(branch).not.toMatch(/videoEl\.volume\s*=/);
  });

  it('꼬리·되드러냄 길이는 videoFadeMs로 나오고, 들어가는 페이드는 언제나 검정이다', () => {
    expect(display).toContain("videoFadeMs(v, 'tail')");
    expect(display).toContain("videoFadeMs(v, 'reveal')");
    const covering = display.slice(display.indexOf("if (v.phase === 'covering') {"));
    expect(covering.slice(0, 300)).toContain('setFadeColor(FADE_BASE_COLOR)');
  });

  it('큐시트는 잠긴 경계를 aria-disabled로 막고 이유를 툴팁으로 단다', () => {
    expect(cuesheet).toContain('lockedCueTransitionTip(item.id)');
    expect(cuesheet).toContain("'aria-disabled': 'true'");
    expect(cuesheet).toContain('cue-boundary--locked');
    expect(cuesheet).toContain(' is-locked');
    // `disabled`로 막으면 hover·포커스가 죽어 툴팁이 뜨지 않는다
    expect(cuesheet).not.toMatch(/cue-boundary__btn[\s\S]{0,400}disabled:\s*true/);
  });

  it('내보내는 클래스마다 CSS 규칙이 있다', () => {
    expect(css).toContain('.cue-boundary--locked');
    expect(css).toContain('.cue-boundary__btn.is-locked');
  });
});
