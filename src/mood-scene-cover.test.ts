/**
 * U98 ② — 분위기 반전이 덮고 있는 동안의 씬 이동은 **덮개 뒤 컷**이다.
 *
 * 사용자 지시(03:18) — "분위기 반전 영상 틀어지다가 1단계 대기화면 넘어갈 때 잠깐
 * 중계 영상이 보임."
 *
 * 사고의 정체는 두 시각의 어긋남이었다: `routeMoodSceneActions`가 덮개를 **즉시** 놓는데
 * (`mood/abort`), 같은 배열의 `scene/set`은 씬 페이드로 감싸여 `fadeSec` 뒤에야 씬을 바꿨다.
 * 그 사이 스테이지는 아직 `live`고 덮개는 없다 = 중계 카메라 노출.
 */

// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { createInitialState, reducer, type Action } from './state';
import { routeMoodSceneActions, MOOD_PART1_ASSET_ID } from './mood-routing';
import { routeSceneActionsThroughDefaultTransition } from './scene-routing';
import type { AppState } from './types';

const NOW = 1_788_600_000_000;

function run(state: AppState, ...actions: Action[]): AppState {
  return actions.reduce(reducer, state);
}

/**
 * control의 디스패치 깔때기와 **같은 순서**로 라우팅한다
 * (`control.ts`: `routeMoodSceneActions` → `routeSceneActionsThroughDefaultTransition`).
 * 순서가 뒤집히면 mood 라우팅이 이미 `sceneFade/play`로 바뀐 배열에서 `scene/set`을 못 찾아
 * `mood/abort`를 영영 내지 않는다.
 */
function route(state: AppState, actions: Action[]): Action[] {
  return routeSceneActionsThroughDefaultTransition(state, routeMoodSceneActions(state, actions), NOW);
}

/** 반전 영상이 화면을 덮고 있는 상태 (라이브 위 crossfade 단계) */
function moodCovering(mode: 'black' | 'white' | 'stinger' = 'black'): AppState {
  let s = run(
    createInitialState(),
    { type: 'settings/patch', patch: { sceneTransitionMode: mode } },
    { type: 'p2/unlock' },
    { type: 'scene/set', scene: 'live' },
    { type: 'mood/start', assetId: MOOD_PART1_ASSET_ID },
  );
  const token = s.sceneOpts.moodTransition.token;
  s = run(s, { type: 'mood/blackout', token }, { type: 'mood/crossfade', token });
  expect(s.sceneOpts.moodTransition.phase).toBe('crossfade');
  expect(s.sceneOpts.overlayVideo.active).toBe(true);
  expect(s.scene).toBe('live');
  return s;
}

const STEADY_CUE: Action = {
  type: 'scene/set',
  scene: 'submit',
  opts: { submit: { stageId: 's1', mode: 'steady' } },
};

describe('반전이 덮고 있는 동안의 씬 이동 (U98)', () => {
  it('씬 페이드를 걸지 않고 컷으로 간다 — 덮개가 없는 채로 옛 씬이 남는 구간을 만들지 않는다', () => {
    const list = route(moodCovering('black'), [STEADY_CUE]);

    expect(list.map((a) => a.type)).toEqual(['mood/abort', 'scene/set']);
    // 이 둘이 화면을 또 덮으면 컷 시점이 그만큼 밀리고, 그 구간에 중계가 드러난다
    expect(list.some((a) => a.type === 'sceneFade/play')).toBe(false);
    expect(list.some((a) => a.type === 'transition/play')).toBe(false);
  });

  it('전환 방식이 무엇이든 같다 (블랙·화이트·스팅어)', () => {
    for (const mode of ['black', 'white', 'stinger'] as const) {
      const types = route(moodCovering(mode), [STEADY_CUE]).map((a) => a.type);
      expect(types).toEqual(['mood/abort', 'scene/set']);
    }
  });

  it('한 배열이 끝나면 씬 교체와 덮개 해체가 모두 끝나 있다 (방송 1회)', () => {
    const before = moodCovering('black');
    const after = run(before, ...route(before, [STEADY_CUE]));

    expect(after.scene).toBe('submit');
    expect(after.sceneOpts.submit).toEqual({ stageId: 's1', mode: 'steady' });
    // 덮개 셋이 전부 내려가 있다 — 다음 프레임까지 남는 것이 없다
    expect(after.sceneOpts.moodTransition.active).toBe(false);
    expect(after.sceneOpts.moodTransition.phase).toBe('idle');
    expect(after.sceneOpts.overlayVideo.active).toBe(false);
    expect(after.sceneOpts.overlayVideo.assetId).toBeNull();
    // 씬 페이드가 남아 있으면 방금 그린 대기화면을 검정이 다시 덮는다
    expect(after.sceneOpts.sceneFade.active).toBe(false);
    expect(after.sceneOpts.transitionVideo.active).toBe(false);
  });

  it('반전이 없으면 지금까지대로 씬 페이드를 건다 (규칙이 반전 중에만 적용됨을 증명)', () => {
    const live = run(
      createInitialState(),
      { type: 'settings/patch', patch: { sceneTransitionMode: 'black' } },
      { type: 'p2/unlock' },
      { type: 'scene/set', scene: 'live' },
    );
    const types = route(live, [STEADY_CUE]).map((a) => a.type);
    expect(types).toContain('sceneFade/play');
    expect(types).not.toContain('mood/abort');
  });

  it('글리치 초입(덮개가 아직 얇을 때)에도 컷이다 — 페이드를 걸면 오히려 완전히 드러난다', () => {
    let s = run(
      createInitialState(),
      { type: 'settings/patch', patch: { sceneTransitionMode: 'black' } },
      { type: 'p2/unlock' },
      { type: 'scene/set', scene: 'live' },
      { type: 'mood/start', assetId: MOOD_PART1_ASSET_ID },
    );
    expect(s.sceneOpts.moodTransition.phase).toBe('glitch');
    const list = route(s, [STEADY_CUE]);
    expect(list.map((a) => a.type)).toEqual(['mood/abort', 'scene/set']);
    s = run(s, ...list);
    expect(s.scene).toBe('submit');
    expect(s.sceneOpts.moodTransition.active).toBe(false);
  });

  it('반전 영상의 자연 종료도 같은 모양이다 — 씬 교체와 덮개 해체가 한 액션에 있다', () => {
    const before = moodCovering('black');
    const after = run(before, {
      type: 'mood/finish',
      token: before.sceneOpts.moodTransition.token,
    });
    expect(after.scene).toBe('suspects');
    expect(after.sceneOpts.moodTransition.active).toBe(false);
    expect(after.sceneOpts.overlayVideo.active).toBe(false);
    // 페이드로 감싸지 않는다 — `mood/finish`는 `scene/set`이 아니라 라우팅을 타지 않는다
    expect(after.sceneOpts.sceneFade.active).toBe(false);
  });

  it('운영자 중단(mood/abort 단독)도 덮개를 놓을 뿐 씬을 옮기지 않는다', () => {
    const before = moodCovering('black');
    const after = run(before, { type: 'mood/abort', token: before.sceneOpts.moodTransition.token });
    expect(after.scene).toBe('live'); // 씬은 그대로 — 덮개만 걷힌다
    expect(after.sceneOpts.moodTransition.active).toBe(false);
    expect(after.sceneOpts.overlayVideo.active).toBe(false);
  });

  it('낡은 토큰의 mood/abort는 무시된다 (늦게 도착한 사건이 새 반전을 끊지 못한다)', () => {
    const before = moodCovering('black');
    const stale = before.sceneOpts.moodTransition.token - 1;
    expect(run(before, { type: 'mood/abort', token: stale }).sceneOpts.moodTransition.active).toBe(true);
  });
});

describe('display 프레임 순서 계약 (U98)', () => {
  const display = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');
  const paint = display.slice(display.indexOf('function paint(): void {'));
  const at = (needle: string) => {
    const i = paint.indexOf(needle);
    expect(i, `${needle} 를 paint() 안에서 찾지 못했다`).toBeGreaterThan(-1);
    return i;
  };

  it('새 씬을 먼저 그리고 반전 덮개를 그 뒤에 해체한다', () => {
    const render = at('renderScene(vis, stage, scene)');
    expect(render).toBeLessThan(at('updateMoodVisual();'));
    expect(render).toBeLessThan(at('void ensureOverlayVideo();'));
  });

  it('순서 계약이 소스에 근거로 적혀 있다 (다음 사람이 뒤집지 않도록)', () => {
    expect(display).toContain('순서 계약 (U98)');
  });
});
