/**
 * U125 — 전환이 도는 동안 눌린 큐가 **도착 씬**을 기준으로 해석되는가.
 *
 * 실측 재현(2026-09-05, Playwright 4174, DELAY=120ms에서 5/5 재현·280ms에서 0/5):
 *  A) `roster` 화면에서 `컬링 대기화면`을 누르고 0.12초 뒤 `컬링 · 출전 명단`을 누르면
 *     — 옛 씬(`roster`)과 목표(`roster`)가 같아 "변화 없음"으로 읽혀 전환이 걸리지 않고,
 *       그대로 흘러간 `scene/set`이 돌던 스팅어를 뜯어내 화면이 한 번도 안 넘어갔다.
 *  B) 같은 자리에서 `▶ 매치 영상 · 컬링`을 누르면 — `matchCueOnRightScene`이 옛 씬을 봐서
 *       영상 없이 씬만 옮기고 커서를 `game-standby-curling`으로 물렸고, 이어 [다음 →]이
 *       매치 영상을 한 번 더 재생했다.
 *  C) 컷(`switchAtSec`) 뒤 스팅어가 아직 도는 1초 사이에 시작한 매치 오버레이가
 *       `transition/finish`에서 함께 꺼졌다.
 */
import { describe, expect, it } from 'vitest';
import { pendingScene, pendingStandbyMode, videoEndedFallbackScene } from './pending-scene';
import { routeSceneActionsThroughDefaultTransition } from './scene-routing';
import { cueActions, cueWithVideos, matchCueOnRightScene, type CueItem } from './cue';
import { createInitialState, reducer, type Action } from './state';
import type { AppState } from './types';

/** 기본 알파 전환이 등록된 상태 — 없으면 라우팅이 하드컷으로 수렴해 판정 자체가 성립하지 않는다. */
function withDefaultTransition(scene: AppState['scene']): AppState {
  const state = createInitialState();
  state.scene = scene;
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

function playing(state: AppState, nextScene: AppState['scene'], token: number): AppState {
  return {
    ...state,
    sceneOpts: {
      ...state.sceneOpts,
      transitionVideo: {
        ...state.sceneOpts.transitionVideo,
        active: true,
        assetId: 'sting',
        nextScene,
        switchAtSec: 0.3,
        restartToken: token,
        switched: false,
      },
    },
  };
}

describe('pendingScene (U125)', () => {
  it('전환이 없으면 지금 씬 그대로다', () => {
    const state = { ...createInitialState(), scene: 'roster' as const };
    expect(pendingScene(state)).toBe('roster');
  });

  it('컷 전 스팅어가 돌고 있으면 목적지를 돌려준다', () => {
    const state = playing({ ...createInitialState(), scene: 'roster' }, 'game', 1000);
    expect(pendingScene(state)).toBe('game');
  });

  it('컷이 끝난 스팅어는 보지 않는다 — 씬은 이미 갈렸다', () => {
    const base = playing({ ...createInitialState(), scene: 'game' }, 'game', 1000);
    const state = {
      ...base,
      sceneOpts: {
        ...base.sceneOpts,
        transitionVideo: { ...base.sceneOpts.transitionVideo, switched: true },
      },
    };
    expect(pendingScene(state)).toBe('game');
  });

  it('컬러 페이드도 같은 규칙이다', () => {
    const base = { ...createInitialState(), scene: 'live' as const };
    const state: AppState = {
      ...base,
      sceneOpts: {
        ...base.sceneOpts,
        sceneFade: {
          ...base.sceneOpts.sceneFade,
          active: true,
          nextScene: 'score',
          restartToken: 5,
          switched: false,
        },
      },
    };
    expect(pendingScene(state)).toBe('score');
  });

  it('대기 화면 모드도 도착값을 따른다 (U35 축)', () => {
    const base = playing({ ...createInitialState(), scene: 'standby' }, 'standby', 1000);
    const state: AppState = {
      ...base,
      sceneOpts: {
        ...base.sceneOpts,
        standby: { mode: 'main' },
        transitionVideo: { ...base.sceneOpts.transitionVideo, nextStandbyMode: 'oath' },
      },
    };
    expect(pendingStandbyMode(state)).toBe('oath');
  });
});

describe('A — 도착 씬과 같은 큐가 스팅어를 뜯어내지 않는다 (U125)', () => {
  it('roster로 가는 중 roster 큐를 누르면 "변화 없음"이라 전환을 새로 걸지 않는다', () => {
    // 지금 보이는 씬은 game이고, 이미 roster로 향하는 중이다.
    const state = playing(withDefaultTransition('game'), 'roster', 1000);
    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      [{ type: 'scene/set', scene: 'roster', opts: { roster: { eventId: 'curling', scope: 'all' } } }],
      2000,
    );
    // 도착값 기준이므로 변화가 없다 — 전환을 한 겹 더 걸지 않는다.
    expect(routed.some((a) => a.type === 'transition/play')).toBe(false);
  });

  it('옛 씬과 같은 큐는 이제 전환으로 감싼다 — 스팅어가 반쯤 돌다 뜯기지 않는다', () => {
    // 화면은 roster, 스팅어는 game으로 가는 중. 여기서 roster 큐를 누른 것이 신고된 자리다.
    const state = playing(withDefaultTransition('roster'), 'game', 1000);
    const routed = routeSceneActionsThroughDefaultTransition(
      state,
      [{ type: 'scene/set', scene: 'roster', opts: { roster: { eventId: 'curling', scope: 'all' } } }],
      2000,
    );
    // 예전에는 sceneSetChange('roster','roster') = null 이라 맨몸 scene/set이 흘러가
    // cancelTransitionVideo()가 돌던 스팅어를 뜯어냈다. 이제는 변화로 읽힌다.
    const bare = routed.find((a) => a.type === 'scene/set');
    expect(bare).toBeUndefined();
  });
});

describe('B — 전환 중 매치 큐가 영상을 내고 커서를 물리지 않는다 (U125)', () => {
  const items: CueItem[] = cueWithVideos([]);
  const match = items.find((i) => i.id === 'match-curling')!;
  const matchIndex = items.findIndex((i) => i.id === 'match-curling');

  // t2=BLUE · t3=RED → `match_blue_red.webm` (슬롯 색 정본은 `DEFAULT_TEAM_NAMES`)
  const runtime = (scene: AppState['scene']) => ({
    versus: ['t2', 't3'] as [import('./types').TeamId, import('./types').TeamId],
    assets: [
      {
        id: 'media:match_blue_red.webm',
        name: '매치',
        type: 'video' as const,
        size: 1,
        mime: 'video/webm',
        playMode: 'overlay' as const,
      },
    ],
    scene,
    gameEventId: 'curling' as const,
    prevCueId: items[matchIndex - 1]?.id ?? null,
  });

  it('도착 씬이 그 종목 대기화면이면 "맞는 씬"이다', () => {
    expect(matchCueOnRightScene(match, runtime('game'))).toBe(true);
    expect(matchCueOnRightScene(match, runtime('roster'))).toBe(false);
  });

  it('맞는 씬이면 커서를 물리지 않고 오버레이를 낸다', () => {
    const out = cueActions(match, matchIndex, 3000, runtime('game'));
    const index = out.find((a) => a.type === 'cue/index') as Extract<Action, { type: 'cue/index' }>;
    expect(index.cueId).toBe('match-curling');
    expect(out.some((a) => a.type === 'overlay/play')).toBe(true);
    expect(out.some((a) => a.type === 'scene/set')).toBe(false);
  });

  it('엉뚱한 씬이면 예전대로 씬만 옮기고 커서를 한 칸 물린다 (U42 리뷰 규칙 유지)', () => {
    const out = cueActions(match, matchIndex, 3000, runtime('roster'));
    const index = out.find((a) => a.type === 'cue/index') as Extract<Action, { type: 'cue/index' }>;
    expect(index.cueId).toBe(items[matchIndex - 1].id);
    expect(out.some((a) => a.type === 'overlay/play')).toBe(false);
  });
});

/**
 * U125b (09:0x 신고) — "신문지 달리기 소개영상에서 적당한 시간이 지난 후 명단으로 갔는데
 * 영상이 또 살짝 보인 뒤 전환되는 경우가 있음."
 *
 * 실측(4174, `u125b-sweep.mjs`): 6.04초짜리 소개 영상을 틀고 **+6.3초**(끝나기 직전)에 명단 큐를
 * 누르면 결과가 `cue=roster-newspaper-heat`인데 `scene=standby`였다 — 영상의 `nextScene`이
 * 운영자가 고른 씬을 덮었다. 홀드 중(+9초)·재생 중(+3초)·covering(+0.25초)에서는 정상.
 */
describe('D — 영상 종료 폴백이 다음 큐의 전환을 가로채지 않는다 (U125b)', () => {
  function afterAbortDuringTransition(): AppState {
    const base = createInitialState();
    return {
      ...base,
      // `video/abort`는 씬을 건드리지 않는다 — 화면은 아직 'video'다
      scene: 'video',
      sceneOpts: {
        ...base.sceneOpts,
        video: { ...base.sceneOpts.video, phase: 'idle', assetId: 'media:intro_newspaper_race.mp4', nextScene: 'standby' },
        transitionVideo: {
          ...base.sceneOpts.transitionVideo,
          active: true,
          assetId: 'sting',
          nextScene: 'roster',
          switchAtSec: 0.3,
          restartToken: 1000,
          switched: false,
        },
      },
    };
  }

  it('명단으로 가는 전환이 도는 중이면 폴백은 물러난다', () => {
    expect(videoEndedFallbackScene(afterAbortDuringTransition())).toBeNull();
  });

  it('전환이 없으면 예전대로 `nextScene`으로 옮긴다', () => {
    const base = createInitialState();
    const state: AppState = {
      ...base,
      scene: 'video',
      sceneOpts: {
        ...base.sceneOpts,
        video: { ...base.sceneOpts.video, phase: 'idle', assetId: 'a', nextScene: 'standby' },
      },
    };
    expect(videoEndedFallbackScene(state)).toBe('standby');
  });

  it('페이드 상태 머신이 도는 동안에는 `fullvideo-tail`이 종료를 맡는다', () => {
    const base = createInitialState();
    const state: AppState = {
      ...base,
      scene: 'video',
      sceneOpts: {
        ...base.sceneOpts,
        video: { ...base.sceneOpts.video, phase: 'playing', assetId: 'a', nextScene: 'standby' },
      },
    };
    expect(videoEndedFallbackScene(state)).toBeNull();
  });

  it('컷이 끝난 뒤(씬이 이미 옮겨졌으면) 폴백은 물러난다', () => {
    const base = createInitialState();
    const state: AppState = {
      ...base,
      scene: 'roster',
      sceneOpts: {
        ...base.sceneOpts,
        video: { ...base.sceneOpts.video, phase: 'idle', assetId: 'a', nextScene: 'standby' },
      },
    };
    expect(videoEndedFallbackScene(state)).toBeNull();
  });

  it('갈 곳이 지정돼 있지 않으면 아무것도 하지 않는다', () => {
    const base = createInitialState();
    const state: AppState = {
      ...base,
      scene: 'video',
      sceneOpts: {
        ...base.sceneOpts,
        video: { ...base.sceneOpts.video, phase: 'idle', assetId: 'a', nextScene: null },
      },
    };
    expect(videoEndedFallbackScene(state)).toBeNull();
  });

  it('컬러 페이드로 넘어가는 중에도 물러난다 (블랙/화이트 전환)', () => {
    const base = createInitialState();
    const state: AppState = {
      ...base,
      scene: 'video',
      sceneOpts: {
        ...base.sceneOpts,
        video: { ...base.sceneOpts.video, phase: 'idle', assetId: 'a', nextScene: 'standby' },
        sceneFade: {
          ...base.sceneOpts.sceneFade,
          active: true,
          nextScene: 'roster',
          restartToken: 7,
          switched: false,
        },
      },
    };
    expect(videoEndedFallbackScene(state)).toBeNull();
  });
});

describe('C — 전환 정리가 뒤늦게 시작한 오버레이를 끄지 않는다 (U125)', () => {
  function withTransition(state: AppState, token: number, switched: boolean): AppState {
    return {
      ...state,
      sceneOpts: {
        ...state.sceneOpts,
        transitionVideo: {
          ...state.sceneOpts.transitionVideo,
          active: true,
          assetId: 'sting',
          nextScene: 'game',
          switchAtSec: 0.3,
          restartToken: token,
          switched,
        },
      },
    };
  }

  it('스팅어가 끝나도 그 뒤에 시작한 매치 영상은 남는다', () => {
    let state = withTransition({ ...createInitialState(), scene: 'game' }, 1000, true);
    state = reducer(state, {
      type: 'overlay/play',
      assetId: 'media:match_blue_red.webm',
      holdEndFrame: true,
      now: 1400,
    });
    state = reducer(state, { type: 'transition/finish', token: 1000 });
    expect(state.sceneOpts.overlayVideo.active).toBe(true);
    expect(state.sceneOpts.overlayVideo.assetId).toBe('media:match_blue_red.webm');
  });

  it('전환보다 앞서 있던 오버레이는 예전대로 걷는다', () => {
    let state: AppState = { ...createInitialState(), scene: 'game' };
    state = reducer(state, {
      type: 'overlay/play',
      assetId: 'media:match_blue_red.webm',
      holdEndFrame: true,
      now: 500,
    });
    state = withTransition(state, 1000, true);
    state = reducer(state, { type: 'transition/finish', token: 1000 });
    expect(state.sceneOpts.overlayVideo.active).toBe(false);
  });

  it('컷(transition/switched)도 같은 규칙이다', () => {
    let state = withTransition({ ...createInitialState(), scene: 'roster' }, 1000, false);
    state = reducer(state, {
      type: 'overlay/play',
      assetId: 'media:match_blue_red.webm',
      holdEndFrame: true,
      now: 1200,
    });
    state = reducer(state, { type: 'transition/switched', token: 1000 });
    expect(state.scene).toBe('game');
    expect(state.sceneOpts.overlayVideo.active).toBe(true);
  });
});
