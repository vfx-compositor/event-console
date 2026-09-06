import { describe, expect, it } from 'vitest';
// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';
import {
  releaseBlackoutForCue,
  routeReplayThroughStinger,
  routeSceneActionsThroughDefaultTransition,
  shouldUseBuiltInSceneFx,
} from './scene-routing';
import { routeMoodSceneActions } from './mood-routing';
import { CUE, cueActions } from './cue';
import { blackoutAudioAxis } from './audio-gain';
import { blackoutDurationMs, blackoutOpacity, blackoutTarget } from './blackout';
import { sceneEntryAction } from './control/launcher';
import { createInitialState, migrate, P1_EVENT_ORDER, reducer, type Action } from './state';
import type { AppState } from './types';

function withDefaultTransition() {
  const state = createInitialState();
  state.assets = [
    {
      id: 'sting-default',
      name: '기본 알파 전환',
      type: 'video',
      size: 26_729,
      mime: 'video/webm',
      playMode: 'transition',
      switchAtSec: 0.65,
    },
  ];
  return state;
}

function run(state: ReturnType<typeof createInitialState>, actions: Action[]) {
  return actions.reduce(reducer, state);
}

describe('기본 프리렌더 씬 전환 라우팅', () => {
  it.each([
    ['black', '#000000'],
    ['white', '#ffffff'],
  ] as const)('%s 선택은 스팅어 대신 컬러 페이드로 씬을 감싼다', (mode, color) => {
    const state = withDefaultTransition();
    state.settings.sceneTransitionMode = mode;

    expect(
      routeSceneActionsThroughDefaultTransition(
        state,
        [{ type: 'scene/set', scene: 'score', opts: { score: { highlight: 'curling' } } }],
        1234,
      ),
    ).toEqual([
      { type: 'sceneOpts/patch', patch: { score: { highlight: 'curling' } } },
      {
        type: 'sceneFade/play',
        color,
        nextScene: 'score',
        durationSec: state.settings.fadeSec,
        now: 1234,
      },
    ]);
  });

  it('stinger 선택은 등록된 bridge 전환 에셋을 사용한다', () => {
    const state = withDefaultTransition();
    state.settings.sceneTransitionMode = 'stinger';
    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      [{ type: 'scene/set', scene: 'score' }],
      1234,
    );
    expect(routed[0]).toMatchObject({ type: 'transition/play', assetId: 'sting-default' });
  });

  it('씬 버튼·단축키·큐시트가 공유하는 scene/set을 기본 알파 영상으로 감싼다', () => {
    const state = withDefaultTransition();
    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      [
        { type: 'cue/index', index: 3 },
        { type: 'scene/set', scene: 'score', opts: { score: { highlight: 'curling' } } },
      ],
      1234,
    );

    expect(routed).toEqual([
      { type: 'cue/index', index: 3 },
      { type: 'sceneOpts/patch', patch: { score: { highlight: 'curling' } } },
      {
        type: 'transition/play',
        assetId: 'sting-default',
        nextScene: 'score',
        switchAtSec: 0.65,
        now: 1234,
      },
    ]);

    const next = run(state, routed);
    expect(next.scene).toBe('standby');
    expect(next.sceneOpts.score.highlight).toBe('curling');
    expect(next.sceneOpts.transitionVideo).toMatchObject({
      active: true,
      assetId: 'sting-default',
      nextScene: 'score',
    });
  });

  it('전환 영상이 없어도 제거된 CSS 로고 스윕을 되살리지 않고 하드컷한다', () => {
    const state = createInitialState();
    const action: Action = { type: 'scene/set', scene: 'live' };
    const routed = routeSceneActionsThroughDefaultTransition(state, [action], 1234);

    expect(routed).toEqual([action]);
    expect(run(state, routed).scene).toBe('live');
    expect(shouldUseBuiltInSceneFx(state)).toBe(false);
  });

  it('기본 영상이 등록되면 우회 씬 변경에도 기존 로고 스윕을 다시 띄우지 않는다', () => {
    expect(shouldUseBuiltInSceneFx(withDefaultTransition())).toBe(false);
  });

  /**
   * U125 — "재선택"의 기준이 **도착 씬**으로 바뀌었다.
   *
   * 전환이 도는 동안 `state.scene`은 화면이 이미 떠난 씬이다. 예전에는 그 옛 씬을 다시 고르는
   * 것이 "변화 없음"으로 읽혀 맨몸 `scene/set`이 흘러갔고, 그 리듀서의 `cancelTransitionVideo()`가
   * **돌고 있던 스팅어를 화면에서 뜯어냈다** — 애니메이션만 돌고 화면은 그대로 남는 U125 증상이다.
   * 이제 옛 씬은 "바뀌는 것"이므로 제대로 전환으로 감싼다. 진행 중 전환을 끊는 탈출구는
   * 아래 테스트가 지키는 **도착 씬 재선택**이다.
   */
  it('진행 중 전환의 옛 씬을 다시 고르면 뜯지 않고 제대로 감싼다 (U125)', () => {
    const state = reducer(withDefaultTransition(), {
      type: 'transition/play',
      assetId: 'sting-default',
      nextScene: 'score',
      switchAtSec: 0.65,
      now: 1000,
    });
    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      [{ type: 'scene/set', scene: 'standby' }],
      1234,
    );

    expect(routed.some((a) => a.type === 'scene/set')).toBe(false);
    expect(routed).toContainEqual({
      type: 'transition/play',
      assetId: 'sting-default',
      nextScene: 'standby',
      switchAtSec: 0.65,
      now: 1234,
    });
  });

  it('도착 씬 재선택은 영상 재생 없이 옵션 적용·진행 중 전환 취소가 가능하다 (U125 이후 탈출구)', () => {
    const state = reducer(withDefaultTransition(), {
      type: 'transition/play',
      assetId: 'sting-default',
      nextScene: 'score',
      switchAtSec: 0.65,
      now: 1000,
    });
    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      [{ type: 'scene/set', scene: 'score' }],
      1234,
    );

    expect(routed).toEqual([{ type: 'scene/set', scene: 'score' }]);
    const next = run(state, routed);
    expect(next.sceneOpts.transitionVideo.active).toBe(false);
    expect(next.scene).toBe('score');
  });

  it('현재 씬 재선택은 진행 중 컬러 페이드를 취소해 늦은 switch가 새 조작을 덮지 못하게 한다', () => {
    const fading = reducer(createInitialState(), {
      type: 'sceneFade/play',
      color: '#000000',
      nextScene: 'score',
      durationSec: 0.5,
      now: 1000,
    });
    const routed = routeSceneActionsThroughDefaultTransition(
      fading,
      [{ type: 'scene/set', scene: 'standby' }],
      1234,
    );

    const cancelled = run(fading, routed);
    expect(cancelled.scene).toBe('standby');
    expect(cancelled.sceneOpts.sceneFade.active).toBe(false);
    expect(reducer(cancelled, { type: 'sceneFade/switched', token: 1000 })).toBe(cancelled);
  });

  it('출발 씬에 따라 다른 조합 예외 에셋으로 래핑한다', () => {
    const state = createInitialState();
    state.assets = [
      { id: 'from-live', name: '중계발 전환', type: 'video', size: 1, mime: 'video/webm', playMode: 'transition' },
      { id: 'from-roster', name: '명단발 전환', type: 'video', size: 1, mime: 'video/webm', playMode: 'transition' },
    ];
    state.transitionRules = {
      defaultAssetId: null,
      byTo: {},
      pairs: [
        { from: 'live', to: 'score', assetId: 'from-live' },
        { from: 'roster', to: 'score', assetId: 'from-roster' },
      ],
    };

    const fromLive = { ...state, scene: 'live' as const };
    const routedFromLive = routeSceneActionsThroughDefaultTransition(
      fromLive,
      [{ type: 'scene/set', scene: 'score' }],
      1,
    );
    expect(routedFromLive).toEqual([
      { type: 'transition/play', assetId: 'from-live', nextScene: 'score', switchAtSec: 0.5, now: 1 },
    ]);

    const fromRoster = { ...state, scene: 'roster' as const };
    const routedFromRoster = routeSceneActionsThroughDefaultTransition(
      fromRoster,
      [{ type: 'scene/set', scene: 'score' }],
      1,
    );
    expect(routedFromRoster).toEqual([
      { type: 'transition/play', assetId: 'from-roster', nextScene: 'score', switchAtSec: 0.5, now: 1 },
    ]);
  });

  it('한 배치에 scene/set이 둘이면 두 번째의 출발 씬이 첫 번째의 도착 씬이 된다', () => {
    const state = createInitialState();
    state.scene = 'live';
    state.assets = [
      { id: 'live-to-score', name: '중계→스코어', type: 'video', size: 1, mime: 'video/webm', playMode: 'transition' },
      { id: 'score-to-timer', name: '스코어→타이머', type: 'video', size: 1, mime: 'video/webm', playMode: 'transition' },
    ];
    state.transitionRules = {
      defaultAssetId: null,
      byTo: {},
      pairs: [
        { from: 'live', to: 'score', assetId: 'live-to-score' },
        { from: 'score', to: 'timer', assetId: 'score-to-timer' },
      ],
    };

    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      [
        { type: 'scene/set', scene: 'score' },
        { type: 'scene/set', scene: 'timer' },
      ],
      1,
    );

    expect(routed).toEqual([
      { type: 'transition/play', assetId: 'live-to-score', nextScene: 'score', switchAtSec: 0.5, now: 1 },
      { type: 'transition/play', assetId: 'score-to-timer', nextScene: 'timer', switchAtSec: 0.5, now: 1 },
    ]);
  });

  it('video/playFull·transitionRules/* 등 scene/set이 아닌 액션은 래핑하지 않는다', () => {
    const state = withDefaultTransition();
    const actions: Action[] = [
      { type: 'video/playFull', assetId: 'a1', nextScene: 'score', now: 1 },
      { type: 'transitionRules/setDefault', assetId: 'sting-default' },
    ];

    const routed = routeSceneActionsThroughDefaultTransition(state, actions, 1234);
    expect(routed).toEqual(actions);
  });
});

/**
 * 새 씬은 `scene/set`을 쓰므로 대판(전환 영상) 할당이 **자동으로** 적용돼야 한다.
 * 새 진입 액션을 만들면 이 중앙 경계를 우회하게 되므로, 그러지 않았다는 것을 고정한다.
 */
describe('현장 사진 씬도 중앙 경계를 그대로 탄다', () => {
  it('도착 씬 규칙 byTo.photos 가 기본 규칙을 이기고 F6 전환에 쓰인다', () => {
    const state = withDefaultTransition();
    state.assets = [
      ...state.assets,
      {
        id: 'to-photos',
        name: '사진 전용 대판',
        type: 'video',
        size: 1,
        mime: 'video/webm',
        playMode: 'transition',
        switchAtSec: 0.4,
      },
    ];
    state.transitionRules = { defaultAssetId: 'sting-default', byTo: { photos: 'to-photos' }, pairs: [] };

    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      [{ type: 'scene/set', scene: 'photos' }],
      7,
    );
    expect(routed).toEqual([
      { type: 'transition/play', assetId: 'to-photos', nextScene: 'photos', switchAtSec: 0.4, now: 7 },
    ]);

    const next = run(state, routed);
    expect(next.scene).toBe('standby');
    expect(next.sceneOpts.transitionVideo).toMatchObject({ active: true, nextScene: 'photos' });
  });

  it('규칙이 없으면 기본 대판으로 감싸진다', () => {
    const state = withDefaultTransition();
    state.transitionRules = { defaultAssetId: 'sting-default', byTo: {}, pairs: [] };
    expect(
      routeSceneActionsThroughDefaultTransition(state, [{ type: 'scene/set', scene: 'photos' }], 8),
    ).toEqual([
      { type: 'transition/play', assetId: 'sting-default', nextScene: 'photos', switchAtSec: 0.65, now: 8 },
    ]);
  });
});

/**
 * U35 — 팀별 사전미션과 메인 대기 화면은 **같은 `standby` 씬**이고 `sceneOpts.standby.mode`만
 * 다르다. 그래서 "씬이 같다"는 이유로 전환 래핑에서 빠져 스팅어가 재생되지 않았다.
 * 모드가 실제로 바뀌면 씬 변경과 동등하게 다뤄야 한다.
 */
describe('대기 화면 모드 전환 (U35)', () => {
  function standbyState(mode: AppState['sceneOpts']['standby']['mode']) {
    const state = withDefaultTransition();
    state.transitionRules = { defaultAssetId: 'sting-default', byTo: {}, pairs: [] };
    state.sceneOpts.standby = { mode };
    return state;
  }

  it.each([
    ['pre-mission', 'main'],
    ['main', 'pre-mission'],
    // U60 — 선서도 같은 `standby` 씬의 모드다. 화이트리스트에서 빠지면 페이드·스팅어가
    // 이 모드를 조용히 버리고 화면이 개회식 대기로 남는다.
    ['main', 'oath'],
    ['oath', 'main'],
  ] as const)('%s → %s 는 씬이 같아도 스팅어를 입힌다', (from, to) => {
    const state = standbyState(from);
    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      [{ type: 'scene/set', scene: 'standby', opts: { standby: { mode: to } } }],
      55,
    );

    expect(routed).toEqual([
      {
        type: 'transition/play',
        assetId: 'sting-default',
        nextScene: 'standby',
        nextStandbyMode: to,
        switchAtSec: 0.65,
        now: 55,
      },
    ]);
  });

  it('모드를 즉시 패치하지 않고 스팅어가 화면을 덮은 뒤에 넘긴다', () => {
    const state = standbyState('pre-mission');
    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      [{ type: 'scene/set', scene: 'standby', opts: { standby: { mode: 'main' } } }],
      55,
    );
    // 이 배치 안에 즉시 반영되는 sceneOpts/patch 가 있으면 스팅어가 덮기 전에 배경이 바뀐다
    expect(routed.some((a) => a.type === 'sceneOpts/patch')).toBe(false);

    const playing = run(state, routed);
    expect(playing.sceneOpts.standby.mode).toBe('pre-mission');
    expect(playing.sceneOpts.transitionVideo).toMatchObject({
      active: true,
      nextScene: 'standby',
      nextStandbyMode: 'main',
    });

    const token = playing.sceneOpts.transitionVideo.restartToken;
    const switched = reducer(playing, { type: 'transition/switched', token });
    expect(switched.sceneOpts.standby.mode).toBe('main');
    expect(switched.scene).toBe('standby');
  });

  it('switch 이벤트를 놓쳐도 finish에서 모드가 수렴한다', () => {
    const state = standbyState('main');
    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      [{ type: 'scene/set', scene: 'standby', opts: { standby: { mode: 'pre-mission' } } }],
      7,
    );
    const playing = run(state, routed);
    const token = playing.sceneOpts.transitionVideo.restartToken;
    const finished = reducer(playing, { type: 'transition/finish', token });
    expect(finished.sceneOpts.standby.mode).toBe('pre-mission');
  });

  it('같은 모드로의 재진입에는 전환을 걸지 않는다', () => {
    const state = standbyState('main');
    const action: Action = { type: 'scene/set', scene: 'standby', opts: { standby: { mode: 'main' } } };
    expect(routeSceneActionsThroughDefaultTransition(state, [action], 9)).toEqual([action]);
  });

  /**
   * 라우터는 **액션에 적힌 것만** 본다. 목적지 모드가 없으면 "무엇으로 바뀌는지"를 알 수 없어
   * 전환을 걸 수 없다 — 이 통과는 라우터의 결함이 아니라 계약이다. U86의 고침은 여기가 아니라
   * **그런 액션을 만들지 않게 하는 쪽**(`sceneEntryAction`)이고, 그 검사는
   * `control/launcher.test.ts`의 [씬 진입 액션 빌더 (U86)] 절에 있다.
   */
  it('모드를 명시하지 않은 대기 화면 재진입도 그대로 통과한다', () => {
    const state = standbyState('pre-mission');
    const action: Action = { type: 'scene/set', scene: 'standby' };
    expect(routeSceneActionsThroughDefaultTransition(state, [action], 9)).toEqual([action]);
  });

  it('black/white 페이드 모드에서도 대기 모드 전환을 감싼다', () => {
    const state = standbyState('pre-mission');
    state.settings.sceneTransitionMode = 'black';
    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      [{ type: 'scene/set', scene: 'standby', opts: { standby: { mode: 'main' } } }],
      12,
    );
    expect(routed).toEqual([
      {
        type: 'sceneFade/play',
        color: '#000000',
        nextScene: 'standby',
        nextStandbyMode: 'main',
        durationSec: state.settings.fadeSec,
        now: 12,
      },
    ]);

    const playing = run(state, routed);
    expect(playing.sceneOpts.standby.mode).toBe('pre-mission');
    const token = playing.sceneOpts.sceneFade.restartToken;
    expect(reducer(playing, { type: 'sceneFade/switched', token }).sceneOpts.standby.mode).toBe('main');
  });

  it('쓸 전환 에셋이 없으면 예전처럼 즉시 바꾼다', () => {
    const state = standbyState('pre-mission');
    state.assets = [];
    state.transitionRules = { defaultAssetId: null, byTo: {}, pairs: [] };
    const action: Action = { type: 'scene/set', scene: 'standby', opts: { standby: { mode: 'main' } } };
    expect(routeSceneActionsThroughDefaultTransition(state, [action], 9)).toEqual([action]);
  });

  it('대기 화면이 아닌 씬으로 나갈 때의 모드 패치는 예전대로 즉시 반영한다', () => {
    const state = standbyState('pre-mission');
    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      [{ type: 'scene/set', scene: 'roster', opts: { standby: { mode: 'main' } } }],
      3,
    );
    expect(routed).toEqual([
      { type: 'sceneOpts/patch', patch: { standby: { mode: 'main' } } },
      { type: 'transition/play', assetId: 'sting-default', nextScene: 'roster', switchAtSec: 0.65, now: 3 },
    ]);
  });
});

/** 체크포인트 리뷰 수정 — 하드컷 경로에서도 로컬 대기 모드 추적을 갱신한다. */
describe('대기 모드 추적 (리뷰 수정)', () => {
  it('전환 에셋이 없어 하드컷한 뒤에도 같은 배치의 다음 액션이 모드를 옳게 본다', () => {
    const state = createInitialState();
    state.assets = [];
    state.transitionRules = { defaultAssetId: null, byTo: {}, pairs: [] };
    state.sceneOpts.standby = { mode: 'main' };

    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      [
        { type: 'scene/set', scene: 'standby', opts: { standby: { mode: 'pre-mission' } } },
        // 같은 배치의 두 번째 — 추적이 낡아 있으면 '변화 없음'을 '변화'로 잘못 읽는다
        { type: 'scene/set', scene: 'standby', opts: { standby: { mode: 'pre-mission' } } },
      ],
      5,
    );
    expect(routed).toHaveLength(2);
    expect(routed.every((a) => a.type === 'scene/set')).toBe(true);
  });
});

/** 체크포인트 리뷰 수정 — 미뤄 둔 대기 모드도 migrate 화이트리스트를 탄다. */
describe('nextStandbyMode migrate 화이트리스트 (리뷰 수정)', () => {
  it('알 수 없는 값은 null로 접는다', () => {
    const base = createInitialState();
    const dirty = {
      ...base,
      sceneOpts: {
        ...base.sceneOpts,
        transitionVideo: { ...base.sceneOpts.transitionVideo, nextStandbyMode: 'bogus' },
        sceneFade: { ...base.sceneOpts.sceneFade, nextStandbyMode: 42 },
      },
    };
    const after = migrate(dirty as unknown as typeof base);
    expect(after.sceneOpts.transitionVideo.nextStandbyMode).toBeNull();
    expect(after.sceneOpts.sceneFade.nextStandbyMode).toBeNull();
  });

  it('유효한 값은 그대로 통과한다', () => {
    const base = createInitialState();
    const ok = {
      ...base,
      sceneOpts: {
        ...base.sceneOpts,
        transitionVideo: { ...base.sceneOpts.transitionVideo, nextStandbyMode: 'pre-mission' },
        sceneFade: { ...base.sceneOpts.sceneFade, nextStandbyMode: 'main' },
      },
    };
    const after = migrate(ok as unknown as typeof base);
    expect(after.sceneOpts.transitionVideo.nextStandbyMode).toBe('pre-mission');
    expect(after.sceneOpts.sceneFade.nextStandbyMode).toBe('main');
  });

  it('선서 모드도 미뤄 둔 모드 화이트리스트를 통과한다 (U60)', () => {
    const base = createInitialState();
    const ok = {
      ...base,
      sceneOpts: {
        ...base.sceneOpts,
        transitionVideo: { ...base.sceneOpts.transitionVideo, nextStandbyMode: 'oath' },
        sceneFade: { ...base.sceneOpts.sceneFade, nextStandbyMode: 'oath' },
      },
    };
    const after = migrate(ok as unknown as typeof base);
    expect(after.sceneOpts.transitionVideo.nextStandbyMode).toBe('oath');
    expect(after.sceneOpts.sceneFade.nextStandbyMode).toBe('oath');
  });

  it('스팅어가 걷힌 순간 선서 모드가 실제로 적용된다 (조용히 버려지지 않는다)', () => {
    const state = withDefaultTransition();
    state.transitionRules = { defaultAssetId: 'sting-default', byTo: {}, pairs: [] };
    state.sceneOpts.standby = { mode: 'main' };
    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      [{ type: 'scene/set', scene: 'standby', opts: { standby: { mode: 'oath' } } }],
      55,
    );
    let next = routed.reduce(reducer, state);
    // 스팅어가 덮기 전에는 아직 개회식 대기 그대로다
    expect(next.sceneOpts.standby.mode).toBe('main');
    next = reducer(next, {
      type: 'transition/switched',
      token: next.sceneOpts.transitionVideo.restartToken,
    });
    expect(next.sceneOpts.standby.mode).toBe('oath');
  });
});

/**
 * U51 — "매치 영상에서 출전명단 넘어갈 때 스팅어가 없다".
 *
 * 매치 큐는 씬을 바꾸지 않고 오버레이만 얹으므로, 그 다음 `roster` 큐는 `game → roster`
 * 씬 변경이다. 오버레이가 홀드 중이라는 이유로 전환 래핑이 빠지면 안 된다. 아래는 실제
 * 큐 순서를 그대로 재현해 네 종목 모두에서 스팅어가 발화하는지 고정한다.
 */
describe('매치 오버레이 홀드 중 씬 전환 (U51)', () => {
  const stinger = {
    id: 'media:bridge_stinger_short.webm',
    name: '스팅어',
    type: 'video',
    size: 1,
    mime: 'video/webm',
    playMode: 'transition',
    switchAtSec: 0.2,
    order: 0,
  };
  const matchAsset = {
    id: 'media:match_blue_red.webm',
    name: '매치',
    type: 'video',
    size: 1,
    mime: 'video/webm',
    playMode: 'overlay',
    holdEndFrame: true,
    order: 1,
  };

  function afterMatch(eventId: string) {
    let s = createInitialState();
    s = { ...s, assets: [stinger, matchAsset] as never };
    const runtime = {
      versus: ['t2', 't3'] as ['t2', 't3'],
      assets: [stinger, matchAsset],
      scene: 'game' as const,
      gameEventId: eventId as never,
    };
    // 게임 대기화면 → 매치 영상 (씬은 game 그대로, 오버레이만 홀드)
    s = {
      ...s,
      scene: 'game',
      sceneOpts: {
        ...s.sceneOpts,
        game: { eventId: eventId as never, mode: 'standby' as const, winner: null },
      },
    };
    const match = CUE.findIndex((c) => c.id === `match-${eventId}`);
    for (const a of cueActions(CUE[match], match, 2, runtime)) s = reducer(s, a);
    s = reducer(s, { type: 'overlay/held', token: s.sceneOpts.overlayVideo.restartToken });
    return { state: s, runtime };
  }

  it.each(P1_EVENT_ORDER.filter((id) => CUE.some((c) => c.id === `match-${id}`)))(
    '%s — 오버레이 홀드 중에도 game → roster 전환에 스팅어가 붙는다',
    (eventId) => {
      const { state, runtime } = afterMatch(eventId);
      expect(state.scene).toBe('game');
      expect(state.sceneOpts.overlayVideo).toMatchObject({ active: true, held: true });

      const roster = CUE.findIndex((c) => c.id === `roster-${eventId}`);
      const routed = routeSceneActionsThroughDefaultTransition(
        state,
        cueActions(CUE[roster], roster, 3, { ...runtime, scene: state.scene }),
        3,
      );
      const play = routed.find((a) => a.type === 'transition/play');
      expect(play).toMatchObject({ assetId: stinger.id, nextScene: 'roster' });
      expect(routed.some((a) => a.type === 'scene/set')).toBe(false);
    },
  );

  it('스팅어가 화면을 덮은 순간 홀드된 매치 오버레이가 함께 정리된다', () => {
    const { state, runtime } = afterMatch('curling');
    const roster = CUE.findIndex((c) => c.id === 'roster-curling');
    let next = state;
    for (const a of routeSceneActionsThroughDefaultTransition(
      state,
      cueActions(CUE[roster], roster, 3, { ...runtime, scene: state.scene }),
      3,
    )) {
      next = reducer(next, a);
    }
    // 스팅어가 도는 동안에는 홀드 프레임이 남아 있다 (씬도 아직 game)
    expect(next.scene).toBe('game');
    expect(next.sceneOpts.overlayVideo.active).toBe(true);

    const token = next.sceneOpts.transitionVideo.restartToken;
    const switched = reducer(next, { type: 'transition/switched', token });
    expect(switched.scene).toBe('roster');
    expect(switched.sceneOpts.overlayVideo.active).toBe(false);
  });

  it('switch를 놓쳐도 finish에서 오버레이가 남지 않는다', () => {
    const { state, runtime } = afterMatch('curling');
    const roster = CUE.findIndex((c) => c.id === 'roster-curling');
    let next = state;
    for (const a of routeSceneActionsThroughDefaultTransition(
      state,
      cueActions(CUE[roster], roster, 3, { ...runtime, scene: state.scene }),
      3,
    )) {
      next = reducer(next, a);
    }
    const token = next.sceneOpts.transitionVideo.restartToken;
    const finished = reducer(next, { type: 'transition/finish', token });
    expect(finished.scene).toBe('roster');
    expect(finished.sceneOpts.overlayVideo.active).toBe(false);
  });
});

/**
 * Q5 — 리플레이는 **씬 전환이 아니다**. 중앙 경계가 이 액션들을 스팅어/컬러 페이드로
 * 감싸면 되감기가 0.45초 전환 뒤에 시작하고, 라이브 복귀에도 전환이 한 번 더 걸린다.
 */
describe('슬로우 리플레이 액션은 전환 래핑을 타지 않는다 (Q5)', () => {
  const replayActions: Action[] = [
    { type: 'live/replay', now: 1_000 },
    { type: 'live/replayEnded', token: 1 },
    { type: 'live/replayStop' },
  ];

  it('스팅어가 걸려 있어도 원본 배열을 그대로 통과시킨다', () => {
    const state = reducer(withDefaultTransition(), { type: 'scene/set', scene: 'live' });
    expect(routeSceneActionsThroughDefaultTransition(state, replayActions, 2_000)).toEqual(
      replayActions,
    );
  });

  it('컬러 페이드 모드에서도 그대로다', () => {
    const state = reducer(
      reducer(createInitialState(), {
        type: 'settings/patch',
        patch: { sceneTransitionMode: 'black' },
      }),
      { type: 'scene/set', scene: 'live' },
    );
    expect(routeSceneActionsThroughDefaultTransition(state, replayActions, 2_000)).toEqual(
      replayActions,
    );
  });

  it('같은 배열 안의 씬 전환은 평소대로 감싸고 리플레이만 통과시킨다', () => {
    const state = reducer(withDefaultTransition(), { type: 'scene/set', scene: 'live' });
    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      [{ type: 'live/replayStop' }, { type: 'scene/set', scene: 'score' }],
      2_000,
    );
    expect(routed[0]).toEqual({ type: 'live/replayStop' });
    expect(routed[1].type).toBe('transition/play');
  });
});

/**
 * U81 — 되감기 진입·복귀를 **짧은 스팅어로 감싼다**.
 *
 * 위 (Q5) 계약과 모순이 아니다. 배치 라우터는 여전히 리플레이 액션을 손대지 않고 —
 * 거기서 감싸면 컷이 전환이 **끝난 뒤**에 일어나 되감기가 0.45초 늦게 시작한다 —
 * 대신 전용 입구가 컷을 스팅어가 **덮은 순간**으로 옮긴다. 감쌀지 말지의 판단은
 * 여전히 이 파일 하나가 쥔다(§3 중앙 경계).
 */
describe('리플레이 스팅어 래핑 (U81)', () => {
  const onLive = (): AppState =>
    reducer(withDefaultTransition(), { type: 'scene/set', scene: 'live' });

  it('중계 화면에서는 스팅어를 내고 리플레이는 보류시킨다', () => {
    const plan = routeReplayThroughStinger(onLive(), { type: 'live/replay', now: 5_000 }, 5_000);

    expect(plan.transition).toEqual({
      type: 'transition/play',
      assetId: 'sting-default',
      // 씬은 바뀌지 않는다 — 스팅어는 컷을 가리는 용도로만 쓴다
      nextScene: 'live',
      switchAtSec: 0.65,
      now: 5_000,
    });
    expect(plan.deferred).toEqual({ type: 'live/replay', now: 5_000 });
  });

  it('운영자 정지도 같은 방식으로 감싼다', () => {
    const playing = reducer(onLive(), { type: 'live/replay', now: 5_000 });
    const plan = routeReplayThroughStinger(playing, { type: 'live/replayStop' }, 6_000);

    expect(plan.transition?.nextScene).toBe('live');
    expect(plan.deferred).toEqual({ type: 'live/replayStop' });
  });

  /**
   * U85 — 사용자 지적 "지금 리플레이 끝날 때 스팅어가 안 나오거든".
   *
   * U81은 진입과 운영자 정지만 감쌌고, 되감기가 끝까지 돌아 display가 `replay-ended:<token>`을
   * 보고하는 **자연 종료**는 그대로 하드컷이었다. 들어오는 컷과 짝이 맞아야 되감기 구간이
   * 스팅어 두 장 사이에 놓인 하나의 묶음으로 읽힌다.
   */
  it('자연 종료(replay-ended)도 같은 스팅어로 감싼다 — 들어온 컷과 짝이 맞는다 (U85)', () => {
    const playing = reducer(onLive(), { type: 'live/replay', now: 5_000 });
    const plan = routeReplayThroughStinger(playing, { type: 'live/replayEnded', token: 1 }, 9_000);

    expect(plan.transition).toEqual({
      type: 'transition/play',
      assetId: 'sting-default',
      nextScene: 'live',
      switchAtSec: 0.65,
      now: 9_000,
    });
    // 토큰이 보존돼야 늦게 온 옛 보고가 다음 재생을 죽이지 못한다 (대조는 reducer가 한다)
    expect(plan.deferred).toEqual({ type: 'live/replayEnded', token: 1 });
  });

  it('진입과 나가는 컷이 같은 에셋·같은 switchAtSec를 쓴다 (U85)', () => {
    const enter = routeReplayThroughStinger(onLive(), { type: 'live/replay', now: 5_000 }, 5_000);
    const playing = reducer(onLive(), { type: 'live/replay', now: 5_000 });
    const exit = routeReplayThroughStinger(playing, { type: 'live/replayEnded', token: 1 }, 9_000);

    expect(exit.transition?.assetId).toBe(enter.transition?.assetId);
    expect(exit.transition?.switchAtSec).toBe(enter.transition?.switchAtSec);
  });

  it('쓸 스팅어가 없으면 감싸지 않는다 — 지금까지의 즉시 컷 그대로', () => {
    const bare = reducer(createInitialState(), { type: 'scene/set', scene: 'live' });
    const plan = routeReplayThroughStinger(bare, { type: 'live/replay', now: 5_000 }, 5_000);

    expect(plan.transition).toBeNull();
    expect(plan.deferred).toEqual({ type: 'live/replay', now: 5_000 });
  });

  it('스팅어가 없으면 나가는 컷도 즉시다 — 폴백이 세 갈래 모두에 걸린다 (U85)', () => {
    const bare = reducer(
      reducer(createInitialState(), { type: 'scene/set', scene: 'live' }),
      { type: 'live/replay', now: 5_000 },
    );
    const plan = routeReplayThroughStinger(bare, { type: 'live/replayEnded', token: 1 }, 9_000);

    expect(plan.transition).toBeNull();
    expect(plan.deferred).toEqual({ type: 'live/replayEnded', token: 1 });
  });

  it('[지금부터]가 잡은 구간 길이는 보류를 건너도 그대로 실려 간다 (U85)', () => {
    const plan = routeReplayThroughStinger(
      onLive(),
      { type: 'live/replay', now: 5_000, seconds: 4.3 },
      5_000,
    );
    expect(plan.deferred).toEqual({ type: 'live/replay', now: 5_000, seconds: 4.3 });
  });

  it('중계 화면이 아니면 감싸지 않는다 (복귀 액션이 어느 씬에서든 안전하게 통과)', () => {
    const elsewhere = reducer(withDefaultTransition(), { type: 'scene/set', scene: 'score' });
    expect(routeReplayThroughStinger(elsewhere, { type: 'live/replayStop' }, 7_000).transition).toBeNull();
  });

  it('스팅어가 씬을 바꾸지 않으므로 이탈 정리(Q5 #12)가 걸리지 않는다', () => {
    const playing = reducer(onLive(), { type: 'live/replay', now: 5_000 });
    const plan = routeReplayThroughStinger(playing, { type: 'live/replayStop' }, 6_000);
    const covering = reducer(playing, plan.transition!);
    const switched = reducer(covering, {
      type: 'transition/switched',
      token: covering.sceneOpts.transitionVideo.restartToken,
    });

    expect(switched.scene).toBe('live');
    // 덮은 순간까지는 되감기가 그대로 돌고 있어야 한다 — 컷은 control이 같은 프레임에 낸다
    expect(switched.sceneOpts.liveOverlay.replay).not.toBeNull();
    const cut = reducer(switched, plan.deferred);
    expect(cut.sceneOpts.liveOverlay.replay).toBeNull();
  });

  it('control이 스팅어 토큰과 보류 컷을 한 배열로 낸다 (방송 1회)', () => {
    const source = readFileSync(new URL('./control.ts', import.meta.url), 'utf8');
    expect(source).toContain('const replay = takeReplayUnderStinger(token);');
    expect(source).toContain('dispatch(replay ? [switched, replay] : switched);');
    // 안전망 — switch를 못 보고 끝난 전환에서도 운영자가 누른 컷이 삼켜지지 않는다
    expect(source).toContain('dispatch(replay ? [finish, replay] : finish);');
    // 전환 위에 전환을 얹지 않는다
    expect(source).toContain('if (state.sceneOpts.transitionVideo.active) {');
  });

  it('오디오를 건드리지 않는다 — 이 경로에 볼륨·음소거 조작이 없다', () => {
    const source = readFileSync(new URL('./scene-routing.ts', import.meta.url), 'utf8');
    const block = source.slice(source.indexOf('export function routeReplayThroughStinger'));
    expect(block).not.toMatch(/volume|muted|music|duck/i);
  });
});

/**
 * **U96** — 사용자 지시(01:04): "영상 틀다가 → 암전 → 대기화면 누르면(블랙 전환 방식일 때)
 * 대기화면 켜질 때 잠깐 영상이 배경에 보임(영상이 안 끝난 경우). 블랙에서 스윽 올라오도록."
 *
 * 규칙 한 줄: **암전이 켜져 있으면 씬 변경은 전환 없이 컷이고, 같은 배열에 암전 해제를 붙인다.**
 */
describe('암전 중 씬 변경 (U96)', () => {
  const displaySource = readFileSync(new URL('./display.ts', import.meta.url), 'utf8');

  /** 암전이 다 덮인 상태 (5초 램프가 끝난 뒤) */
  function blacked(mode: 'black' | 'white' | 'stinger') {
    const state = withDefaultTransition();
    state.settings.sceneTransitionMode = mode;
    return reducer(state, { type: 'blackout/set', on: true, now: 0 });
  }

  it.each(['black', 'white', 'stinger'] as const)(
    '%s 방식이어도 암전 중에는 전환을 걸지 않는다 — 컷 + 암전 해제 두 액션뿐',
    (mode) => {
      const state = blacked(mode);
      const routed = routeSceneActionsThroughDefaultTransition(
        state,
        [{ type: 'scene/set', scene: 'roster' }],
        9_000,
      );
      expect(routed).toEqual([
        { type: 'scene/set', scene: 'roster' },
        { type: 'blackout/set', on: false, now: 9_000 },
      ]);
      // 덮개가 둘이 되면 컷 시점이 밀리고, 그 사이에 암전을 풀면 옛 씬이 드러난다
      expect(routed.some((a) => a.type === 'sceneFade/play' || a.type === 'transition/play')).toBe(false);
    },
  );

  it('암전이 아니면 예전 경로 그대로다 (같은 상태·같은 배열)', () => {
    const state = withDefaultTransition();
    state.settings.sceneTransitionMode = 'black';
    expect(
      routeSceneActionsThroughDefaultTransition(
        state,
        [{ type: 'scene/set', scene: 'roster' }],
        9_000,
      ),
    ).toEqual([
      {
        type: 'sceneFade/play',
        color: '#000000',
        nextScene: 'roster',
        durationSec: state.settings.fadeSec,
        now: 9_000,
      },
    ]);
  });

  it('보이는 변화가 없으면 암전도 풀지 않는다 — 같은 씬을 다시 눌렀을 때', () => {
    const state = blacked('black');
    expect(
      routeSceneActionsThroughDefaultTransition(
        state,
        [{ type: 'scene/set', scene: state.scene }],
        9_000,
      ),
    ).toEqual([{ type: 'scene/set', scene: state.scene }]);
  });

  it('대기 모드 전환(U35)도 컷이며 모드가 액션에 실려 즉시 반영된다', () => {
    const state = blacked('black');
    const action = {
      type: 'scene/set' as const,
      scene: 'standby' as const,
      opts: { standby: { mode: 'pre-mission' as const } },
    };
    // 씬은 이미 standby이므로 이 배치는 'standby-mode' 변경이다
    expect(state.scene).toBe('standby');
    expect(
      routeSceneActionsThroughDefaultTransition(state, [action], 9_000),
    ).toEqual([action, { type: 'blackout/set', on: false, now: 9_000 }]);
  });

  it('리듀서가 한 방송 안에서 둘 다 적용한다 — 씬은 갈리고 암전은 100% 검정에서 내려온다', () => {
    const state = blacked('black');
    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      [{ type: 'scene/set', scene: 'roster' }],
      9_000,
    );
    const next = run(state, routed);
    expect(next.scene).toBe('roster');
    // 해제 램프의 출발값은 **지금 보이는 불투명도** — 여기서 0으로 스냅되면 "스윽"이 사라진다
    expect(next.sceneOpts.blackout).toEqual({ active: false, startedAt: 9_000, fromOpacity: 1 });
  });

  it('`scene/set`은 암전 서술자를 살려 보낸다 (씬 변경이 암전을 소유하지 않는다)', () => {
    // 이 값이 지워지면 위 램프가 0에서 출발해 검정이 곡선 없이 한 프레임에 걷힌다
    const state = blacked('black');
    const cut = reducer(state, { type: 'scene/set', scene: 'roster' });
    expect(cut.sceneOpts.blackout).toEqual(state.sceneOpts.blackout);
    // 램프가 도는 도중의 해제도 그대로 이어진다
    const releasing = reducer(state, { type: 'blackout/set', on: false, now: 2_500 });
    expect(reducer(releasing, { type: 'scene/set', scene: 'roster' }).sceneOpts.blackout).toEqual(
      releasing.sceneOpts.blackout,
    );
  });

  it('영상 재생 중에 잘라도 영상 단계는 그 자리에서 놓는다 (검정 뒤에서 컷)', () => {
    const onVideo = reducer(blacked('black'), { type: 'scene/set', scene: 'video' });
    const playing = reducer(onVideo, {
      type: 'video/playFull',
      assetId: 'clip-1',
      nextScene: null,
      now: 100,
    });
    expect(playing.sceneOpts.video.phase).not.toBe('idle');
    const routed = routeSceneActionsThroughDefaultTransition(
      playing,
      [{ type: 'scene/set', scene: 'standby' }],
      9_000,
    );
    const next = run(playing, routed);
    expect(next.sceneOpts.video.phase).toBe('idle');
    expect(next.sceneOpts.overlayVideo.active).toBe(false);
    expect(next.sceneOpts.blackout.fromOpacity).toBe(1);
  });

  it('display는 씬이 영상을 놓는 **그 프레임에** 그림을 감추고 소리만 보관함에 남긴다 (U27)', () => {
    // maybeTransition → renderScene → attachSlots가 한 paint 안에서 끝나야 한 프레임도 새지 않는다
    expect(displaySource).toMatch(/maybeTransition\(\);[\s\S]{0,600}const changed = renderScene\(/);
    expect(displaySource).toContain('if (changed) attachSlots();');
    expect(displaySource.indexOf('const changed = renderScene(')).toBeLessThan(
      displaySource.indexOf('if (changed) attachSlots();'),
    );
    // 슬롯이 없는 씬으로 가면 그림은 즉시 화면 밖, 소리는 문서 안에 남아 페이드를 마친다
    expect(displaySource).toMatch(/const videoSlot[\s\S]{0,200}\} else \{\s*\n\s*parkMedia\(videoEl\);/);
    expect(displaySource).toContain("requestAudioTeardown(videoMedia, 'pause', now)");
    expect(displaySource).toMatch(/overlayVideoEl\.hidden = true;\s*\n\s*requestAudioTeardown/);
  });
});

/**
 * **U96 실측 회귀 — 01:27 빌드(control-CUMPZ-TC / display-DWgecsyN) 격리 실행.**
 *
 * 올림픽 인트로 재생 중(`scene video` · `phase playing`) 암전을 켜고 5.6초 기다린 뒤
 * (상태 `{active:true, startedAt:1788539425854, fromOpacity:0}`) `F1`을 눌렀다. 전환 이벤트는
 * 나오지 않았고(라우팅은 정상) 씬도 즉시 `standby`로 갔지만, 상태가 뒤집힌 뒤 **0.7초에
 * `#blackout` opacity가 이미 0**이었다 — 5초 램프가 통째로 사라진 스냅이다.
 *
 * root cause: `withFullVideoAbort`가 배치 맨 앞에 끼우는 `video/abort`가
 * `resetRuntimeVideoPhase()`를 그대로 쓰는데, 그 함수가 암전까지 `{false, 0, 0}`으로 되돌렸다.
 * 그래서 뒤따르는 `blackout/set off`는 `active === on`이라 **무시**됐다.
 *
 * 여기서는 control의 디스패치 깔때기(`withFullVideoAbort` → 라우팅 → 리듀서)를 같은 순서로
 * 재현하고, 실측 타임스탬프 그대로 램프가 살아 있는지 본다.
 */
describe('U96 실측 회귀 — 영상 재생 중 암전 + F1 (01:27 빌드)', () => {
  /** 실측 `blackout.startedAt` */
  const T0 = 1_788_539_425_854;
  /** 운영자가 F1을 누른 시각 (암전 5.6초 뒤 — 5초 램프는 이미 끝나 완전 검정이다) */
  const PRESS = T0 + 5_600;

  /** 인트로가 도는 중에 암전이 다 덮인 상태 */
  function playingUnderBlackout() {
    const base = withDefaultTransition();
    base.settings.sceneTransitionMode = 'black';
    const on = reducer(base, { type: 'blackout/set', on: true, now: T0 });
    const covering = reducer(on, {
      type: 'video/playFull',
      assetId: 'intro',
      nextScene: null,
      now: T0 + 10,
    });
    const playing = reducer(covering, {
      type: 'video/covered',
      token: covering.sceneOpts.video.phaseToken,
    });
    expect(playing.scene).toBe('video');
    expect(playing.sceneOpts.video.phase).toBe('playing');
    expect(playing.sceneOpts.blackout).toEqual({ active: true, startedAt: T0, fromOpacity: 0 });
    return playing;
  }

  /** control의 `withFullVideoAbort` — 씬을 건드리는 배치는 `video/abort`가 앞에 붙는다 */
  function funnel(state: AppState, requested: Action[]): Action[] {
    const withAbort: Action[] =
      state.sceneOpts.video.phase !== 'idle' &&
      requested.some((a) => a.type === 'scene/set' || a.type === 'transition/play')
        ? [{ type: 'video/abort' }, ...requested]
        : requested;
    return routeSceneActionsThroughDefaultTransition(state, withAbort, PRESS);
  }

  it('라우팅은 컷 + 해제만 낸다 — `video/abort`는 그대로 통과한다', () => {
    const routed = funnel(playingUnderBlackout(), [sceneEntryAction('standby')]);
    expect(routed).toEqual([
      { type: 'video/abort' },
      sceneEntryAction('standby'),
      { type: 'blackout/set', on: false, now: PRESS },
    ]);
  });

  it('해제 램프가 **지금 보이는 불투명도(1)**에서 출발한다 — 스냅 회귀 고정', () => {
    const playing = playingUnderBlackout();
    const next = run(playing, funnel(playing, [sceneEntryAction('standby')]));

    expect(next.scene).toBe('standby');
    expect(next.sceneOpts.standby.mode).toBe('main');
    expect(next.sceneOpts.video.phase).toBe('idle');
    // 결함 당시 값: `{active:false, startedAt:0, fromOpacity:0}` — 램프 서술자가 통째로 지워졌다
    expect(next.sceneOpts.blackout).toEqual({
      active: false,
      startedAt: PRESS,
      fromOpacity: 1,
    });
  });

  it('display의 `tickBlackout` 산수가 +0.7초에 아직 검고 +5초에 걷힌다', () => {
    const playing = playingUnderBlackout();
    const next = run(playing, funnel(playing, [sceneEntryAction('standby')]));
    const b = next.sceneOpts.blackout;
    const to = blackoutTarget(b.active);
    const durationMs = blackoutDurationMs(next.settings.blackoutSec, b.fromOpacity, to);
    expect(durationMs).toBe(5_000);

    const at = (ms: number) => blackoutOpacity(ms, durationMs, b.fromOpacity, to);
    expect(at(0)).toBe(1);
    // **실측 결함이 잡히는 자리다** — 여기가 0이면 검정이 한 프레임에 걷힌 것이다
    expect(at(700)).toBeGreaterThan(0.9);
    expect(at(2_500)).toBeCloseTo(0.5, 6);
    expect(at(5_000)).toBe(0);
  });

  it('소리도 같은 서술자를 타고 함께 올라온다 (U95 × U96)', () => {
    const playing = playingUnderBlackout();
    const next = run(playing, funnel(playing, [sceneEntryAction('standby')]));
    const sec = next.settings.blackoutSec;
    // 컷 직후에는 아직 무음, 5초에 걸쳐 그림과 같은 속도로 돌아온다
    expect(blackoutAudioAxis(next.sceneOpts.blackout, sec, PRESS)).toBe(0);
    expect(blackoutAudioAxis(next.sceneOpts.blackout, sec, PRESS + 700)).toBeLessThan(0.1);
    expect(blackoutAudioAxis(next.sceneOpts.blackout, sec, PRESS + 2_500)).toBeCloseTo(0.5, 6);
    expect(blackoutAudioAxis(next.sceneOpts.blackout, sec, PRESS + 5_000)).toBe(1);
  });

  it('control은 `withFullVideoAbort` → 라우팅 순서로 낸다 (깔때기 재현의 근거)', () => {
    const control = readFileSync(new URL('./control.ts', import.meta.url), 'utf8');
    expect(control).toMatch(
      /withFullVideoAbort\(Array\.isArray\(action\) \? action : \[action\]\),[\s\S]{0,400}routeSceneActionsThroughDefaultTransition\(state, requested, now\)/,
    );
    // U103 — 암전 해제 판단은 전환 래핑이 **끝난 뒤**에 배열을 본다 (U96이 붙인 해제를 봐야
    // 이중 해제가 나지 않는다). 순서가 뒤집히면 같은 배치에 `blackout/set`이 둘 들어간다.
    expect(control).toMatch(
      /releaseBlackoutForCue\(\s*state,\s*routeSceneActionsThroughDefaultTransition\(state, requested, now\),\s*now,\s*\)/,
    );
    // 저장본 인수만이 암전을 푼다 — 리듀서 안의 런타임 리셋은 더 이상 그것을 소유하지 않는다
    expect(control).toContain('adoptStoredState(loadLocal() ?? createInitialState())');
    expect(control).toContain('state = adoptStoredState(stored);');
    expect(control).not.toContain('resetRuntimeVideoPhase(');
  });
});

/**
 * U100 (2026-09-05 사용자 지시) — 승리 영상은 알파를 갖고 완전 투명에서 시작하므로
 * "별도 트랜지션 없이 바로 오버레이로" 올라와야 하고, **끝은 기존 규칙 그대로**여야 한다.
 *
 * 여기서 고정하는 것은 그 두 가지가 **중앙 경계에서 실제로 그렇게 흐르는가**다.
 * `cue.test.ts`가 "승리 큐가 무엇을 내는가"를 고정한다면, 이 describe는 그 배열이
 * 전환 래핑을 지나갈 때 아무것도 덧붙지 않는다는 것을 고정한다.
 */
describe('승리 영상 오버레이는 전환 래핑을 타지 않는다 (U100)', () => {
  const item = CUE.find((c) => c.id === 'victory-curling')!;
  const index = CUE.findIndex((c) => c.id === 'victory-curling');
  const winnerRuntime = {
    versus: null,
    assets: [{ id: 'media:winner_red.webm' }],
    scene: 'live' as const,
    gameEventId: 'curling' as const,
    winner: 't3' as const,
  };

  it.each(['stinger', 'black', 'white'] as const)(
    '전역 전환이 %s여도 승리 오버레이 배열은 그대로 지나간다',
    (mode) => {
      const state = withDefaultTransition();
      state.settings.sceneTransitionMode = mode;
      state.scene = 'live';
      const actions = cueActions(item, index, 500, winnerRuntime);
      // 감쌀 `scene/set`이 없으므로 경계가 손댈 것이 없다 — 배열이 동일하게 나온다
      expect(routeSceneActionsThroughDefaultTransition(state, actions, 500)).toEqual(actions);
    },
  );

  it('오버레이가 아래 화면을 갈아치우지 않는다 — 리듀서를 태워도 씬은 live 그대로다', () => {
    const state = withDefaultTransition();
    state.scene = 'live';
    const next = run(state, cueActions(item, index, 500, winnerRuntime));
    expect(next.scene).toBe('live');
    expect(next.sceneOpts.overlayVideo).toMatchObject({
      active: true,
      assetId: 'media:winner_red.webm',
      holdEndFrame: true,
    });
    // 전환 영상 슬롯은 건드리지 않는다 (`#transition-video` 계약)
    expect(next.sceneOpts.transitionVideo.active).toBe(false);
    expect(next.sceneOpts.sceneFade.active).toBe(false);
  });

  it('끝 처리는 그대로다 — 오버레이 뒤 다음 큐(점수 공개)는 여전히 전환으로 감싸인다', () => {
    const state = withDefaultTransition();
    state.scene = 'live';
    const held = run(state, cueActions(item, index, 500, winnerRuntime));
    const scoreIndex = CUE.findIndex((c) => c.id === 'score-curling');
    const routed = routeSceneActionsThroughDefaultTransition(
      held,
      cueActions(CUE[scoreIndex], scoreIndex, 900),
      900,
    );
    expect(routed.some((a) => a.type === 'transition/play')).toBe(true);
    expect(routed.some((a) => a.type === 'scene/set')).toBe(false);
  });

  /**
   * U110 — 카드 폴백이 폐기됐다. 승리 팀이나 영상이 없으면 **전환도 걸리지 않는다**:
   * 감쌀 `scene/set`이 애초에 없기 때문이다. 화면은 있던 그대로 남는다(검정 아님).
   */
  it('승리 팀이 없으면 전환도 씬 변경도 없다 — 화면이 그대로 남는다 (U110)', () => {
    const state = withDefaultTransition();
    state.scene = 'live';
    const actions = cueActions(item, index, 500, { ...winnerRuntime, winner: null });
    const routed = routeSceneActionsThroughDefaultTransition(state, actions, 500);
    expect(routed.some((a) => a.type === 'transition/play')).toBe(false);
    expect(routed.some((a) => a.type === 'scene/set')).toBe(false);
    expect(routed.some((a) => a.type === 'overlay/play')).toBe(false);
    expect(run(state, routed).scene).toBe('live');
  });

  it('승리 음악이 지정돼 있으면 오버레이와 함께 그대로 지나간다 (U110)', () => {
    const state = withDefaultTransition();
    state.settings.sceneTransitionMode = 'stinger';
    state.scene = 'live';
    const actions = cueActions(item, index, 500, {
      ...winnerRuntime,
      victoryMusic: { trackId: '03', startSec: 5 },
    });
    expect(routeSceneActionsThroughDefaultTransition(state, actions, 500)).toEqual(actions);
    expect(actions.some((a) => a.type === 'music/play')).toBe(true);
  });
});

/**
 * **U103** — 사용자 지시(04:14): "화면 암전 상태에서 큐시트의 항목을 누르면 해당 항목이
 * 실행되게 해줘."
 *
 * U96은 `scene/set`을 내는 큐만 검정에서 끌어올렸다. 여기서 고정하는 것은 **나머지 종류**다 —
 * 오버레이·full 영상·반전처럼 `scene/set`을 내지 않는 큐, 그리고 같은 씬에서 opts만 바뀌어
 * `sceneSetChange`가 `null`을 주는 큐. 규칙 한 줄: **큐 실행 배치가 화면 출력을 바꾸면
 * 배열 끝에 암전 해제를 붙인다.**
 */
describe('암전 중 큐시트 실행 (U103)', () => {
  /** 암전이 다 덮인 상태 (5초 램프가 끝난 뒤) */
  function blacked() {
    return reducer(withDefaultTransition(), { type: 'blackout/set', on: true, now: 0 });
  }
  const RELEASE = { type: 'blackout/set' as const, on: false as const, now: 9_000 };
  /** 큐 실행의 표식 — 런처·단축키 배치에는 없다 */
  const CURSOR = { type: 'cue/index' as const, index: 4, cueId: 'match-curling' };

  it('매치 오버레이 큐(`overlay/play`)는 검정에서 영상이 올라온다', () => {
    const state = blacked();
    const actions: Action[] = [
      CURSOR,
      { type: 'overlay/play', assetId: 'media:match.webm', holdEndFrame: true, now: 9_000 },
      { type: 'sceneOpts/patch', patch: { liveOverlay: { versus: ['t1', 't2'] } } },
    ];
    expect(releaseBlackoutForCue(state, actions, 9_000)).toEqual([...actions, RELEASE]);
  });

  it('full 영상 큐(`video/playFull`)도 같은 규칙이다', () => {
    const state = blacked();
    const actions: Action[] = [
      { type: 'cue/index', index: 2, cueId: 'video:media:intro_curling.mp4' },
      { type: 'video/playFull', assetId: 'media:intro_curling.mp4', nextScene: 'standby', now: 9_000 },
    ];
    expect(releaseBlackoutForCue(state, actions, 9_000)).toEqual([...actions, RELEASE]);
  });

  it('반전 큐는 `mood/start`로 치환된 뒤에도 해제된다 (`scene/set`이 남지 않는 경로)', () => {
    const state = blacked();
    const index = CUE.findIndex((c) => c.id === 'breaking');
    // 큐가 낸 `scene/set 'breaking'`을 mood 라우터가 `mood/start`로 갈아치운다
    const requested = routeMoodSceneActions(state, cueActions(CUE[index], index, 9_000));
    expect(requested.some((a) => a.type === 'scene/set')).toBe(false);
    expect(requested.some((a) => a.type === 'mood/start')).toBe(true);

    const routed = routeSceneActionsThroughDefaultTransition(state, requested, 9_000);
    expect(releaseBlackoutForCue(state, routed, 9_000)).toEqual([...routed, RELEASE]);
  });

  it('같은 씬에서 opts만 바뀌는 큐도 해제된다 — 조별 명단 → 전체 명단', () => {
    const state = blacked();
    state.scene = 'roster';
    const index = CUE.findIndex((c) => c.id === 'roster-newspaper');
    const actions = cueActions(CUE[index], index, 9_000);
    // 씬이 그대로라 `sceneSetChange`가 null을 준다 — U96 경로는 여기서 아무것도 붙이지 않는다
    const routed = routeSceneActionsThroughDefaultTransition(state, actions, 9_000);
    expect(routed.some((a) => a.type === 'blackout/set')).toBe(false);
    expect(releaseBlackoutForCue(state, routed, 9_000)).toEqual([...routed, RELEASE]);
  });

  it('암전이 아니면 배열이 그대로다 (같은 참조)', () => {
    const state = withDefaultTransition();
    const actions: Action[] = [CURSOR, { type: 'overlay/play', assetId: 'm', holdEndFrame: true, now: 9_000 }];
    expect(releaseBlackoutForCue(state, actions, 9_000)).toBe(actions);
  });

  it('`cue/index`가 없는 런처·단축키 배치는 건드리지 않는다 (U96 경로만 남는다)', () => {
    const state = blacked();
    const actions: Action[] = [{ type: 'overlay/play', assetId: 'm', holdEndFrame: true, now: 9_000 }];
    expect(releaseBlackoutForCue(state, actions, 9_000)).toBe(actions);
  });

  it('U96이 이미 해제를 붙였으면 두 번 붙이지 않는다', () => {
    const state = blacked();
    const index = CUE.findIndex((c) => c.id === 'score-curling');
    // `scene/set`을 내는 큐 — U96 분기가 컷 + 해제를 이미 만든다
    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      cueActions(CUE[index], index, 9_000),
      9_000,
    );
    expect(routed.filter((a) => a.type === 'blackout/set')).toHaveLength(1);
    expect(releaseBlackoutForCue(state, routed, 9_000)).toBe(routed);
  });

  it('화면 출력을 바꾸지 않는 큐는 검정을 유지한다 — 커서·자막·타이머만 움직인다', () => {
    const state = blacked();
    const actions: Action[] = [
      { type: 'cue/index', index: 1, cueId: 'open' },
      { type: 'phase/set', phase: 'pre' },
      { type: 'timer/preset', preset: 'sticky60', durationSec: 60 },
    ];
    // 암전을 켠 채 다음 순서를 준비하는 조작이 살아 있어야 한다
    expect(releaseBlackoutForCue(state, actions, 9_000)).toBe(actions);
  });

  it('암전 중 큐 경계 전환(U42)은 걸리지 않는다 — 컷 + 해제 램프뿐', () => {
    const state = blacked();
    const index = CUE.findIndex((c) => c.id === 'score-curling');
    // 이 경계에 스팅어를 지정해도 암전 분기가 `transitionMode`를 읽기 전에 컷으로 빠진다
    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      cueActions(CUE[index], index, 9_000, undefined, 'stinger'),
      9_000,
    );
    expect(routed.some((a) => a.type === 'transition/play' || a.type === 'sceneFade/play')).toBe(false);
    expect(routed[routed.length - 1]).toEqual(RELEASE);
  });

  it('해제는 배열 **끝**이다 — 그림이 먼저 바뀌어야 램프가 100% 검정에서 출발한다', () => {
    const state = blacked();
    const actions: Action[] = [
      CURSOR,
      { type: 'overlay/play', assetId: 'media:match.webm', holdEndFrame: true, now: 9_000 },
    ];
    const out = releaseBlackoutForCue(state, actions, 9_000);
    expect(out[out.length - 1]).toEqual(RELEASE);

    const next = run(state, out);
    expect(next.sceneOpts.overlayVideo.active).toBe(true);
    // `fromOpacity: 1` — 여기가 0이면 검정이 곡선 없이 한 프레임에 걷힌다
    expect(next.sceneOpts.blackout).toEqual({ active: false, startedAt: 9_000, fromOpacity: 1 });
  });

  it('해제 램프의 오디오 축은 U95가 그대로 올린다 — 추가 배선이 없다', () => {
    const state = blacked();
    const out = releaseBlackoutForCue(
      state,
      [CURSOR, { type: 'overlay/play', assetId: 'm', holdEndFrame: true, now: 9_000 }],
      9_000,
    );
    const next = run(state, out);
    const sec = next.settings.blackoutSec;
    expect(blackoutAudioAxis(next.sceneOpts.blackout, sec, 9_000)).toBe(0);
    expect(blackoutAudioAxis(next.sceneOpts.blackout, sec, 9_000 + 5_000)).toBe(1);
  });
});

/**
 * **U127** — 최종 순위 발표는 등수마다 큐가 다른데 씬은 전부 `award`다. 씬 id만 비교하던
 * `sceneSetChange`는 그 경계를 "안 바뀜"으로 읽어 전환이 통째로 빠졌고, 전환이 없으니
 * U103(암전 중 큐 실행)의 출력 판정에도 걸리지 않아 검정이 그대로 남았다.
 */
describe('시상 등수 큐 전환 판정 (U127)', () => {
  /** 시상 씬에서 그 등수 자리를 열어 둔 상태 */
  function atRank(rank: number) {
    const state = withDefaultTransition();
    return run(state, [
      { type: 'scene/set', scene: 'award' },
      { type: 'award/selectRank', rank },
    ]);
  }

  const cueFor = (id: string) => {
    const index = CUE.findIndex((c) => c.id === id);
    return cueActions(CUE[index], index, 9_000);
  };

  it('4위 → 3위는 씬이 그대로여도 전환이 걸린다', () => {
    const state = atRank(4);
    const routed = routeSceneActionsThroughDefaultTransition(state, cueFor('award-3'), 9_000);
    const play = routed.find((a) => a.type === 'transition/play');
    expect(play).toMatchObject({ assetId: 'sting-default', nextScene: 'award' });
    // opts는 즉시 반영된다 — 등수 큐는 팀을 열지 않으므로 먼저 드러날 비밀이 없다
    expect(routed.some((a) => a.type === 'sceneOpts/patch')).toBe(true);
    expect(run(state, routed).sceneOpts.award).toMatchObject({ selectedRank: 3, solo: true });
  });

  it('팀 공개 전/후도 서로 다른 그림이라 전환 대상이다', () => {
    const state = atRank(4);
    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      [{ type: 'scene/set', scene: 'award', opts: { award: { selectedTeamRevealed: true } } }],
      9_000,
    );
    expect(routed.some((a) => a.type === 'transition/play')).toBe(true);
  });

  it('같은 등수 큐를 다시 눌러도 전환이 두 번 돌지 않는다', () => {
    const state = atRank(4);
    const routed = routeSceneActionsThroughDefaultTransition(state, cueFor('award-4'), 9_000);
    expect(routed.some((a) => a.type === 'transition/play')).toBe(false);
  });

  it('한 배열이 등수를 두 번 옮기면 두 경계 모두 해석된다', () => {
    const state = atRank(4);
    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      [
        { type: 'scene/set', scene: 'award', opts: { award: { selectedRank: 3 } } },
        { type: 'scene/set', scene: 'award', opts: { award: { selectedRank: 3 } } },
        { type: 'scene/set', scene: 'award', opts: { award: { selectedRank: 2 } } },
      ],
      9_000,
    );
    // 첫 경계(4→3)와 셋째(3→2)만 전환이다. 둘째는 같은 등수라 아무것도 붙지 않는다.
    expect(routed.filter((a) => a.type === 'transition/play')).toHaveLength(2);
  });

  it('암전 중 등수 큐를 누르면 그 등수가 검정에서 올라온다 (U103)', () => {
    const blacked = reducer(atRank(4), { type: 'blackout/set', on: true, now: 0 });
    const routed = routeSceneActionsThroughDefaultTransition(blacked, cueFor('award-3'), 9_000);
    const out = releaseBlackoutForCue(blacked, routed, 9_000);
    expect(out.some((a) => a.type === 'blackout/set' && a.on === false)).toBe(true);
    expect(run(blacked, out).sceneOpts.award.selectedRank).toBe(3);
  });
});
