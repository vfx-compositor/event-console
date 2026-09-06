import { describe, expect, it } from 'vitest';

import { createInitialState } from './state';
import { routeMoodSceneActions } from './mood-routing';

describe('분위기 반전 씬 라우팅', () => {
  it('breaking 씬 요청을 직전 영상이 아니라 공식 Part 1 분위기반전 asset으로 바꾼다', () => {
    const state = createInitialState();
    state.sceneOpts.video.assetId = 'stale-previous-video';
    state.assets = [
      {
        id: 'media:260831_pt1_v001.mp4',
        name: '2부 Part 1 · 분위기 반전',
        type: 'video',
        size: 1,
        mime: 'video/mp4',
      },
    ];
    expect(routeMoodSceneActions(state, [{ type: 'scene/set', scene: 'breaking' }])).toEqual([
      { type: 'mood/start', assetId: 'media:260831_pt1_v001.mp4' },
    ]);
  });

  it('공식 Part 1 asset이 없으면 이전 영상을 재사용하지 않는다', () => {
    const state = createInitialState();
    state.sceneOpts.video.assetId = 'stale-previous-video';
    expect(routeMoodSceneActions(state, [{ type: 'scene/set', scene: 'breaking' }])).toEqual([
      { type: 'mood/start', assetId: null },
    ]);
  });

  it('진행 중 다른 씬 요청은 먼저 비상 중단한다', () => {
    const state = createInitialState();
    state.sceneOpts.moodTransition = { active: true, phase: 'glitch', assetId: 'cut', token: 7 };
    expect(routeMoodSceneActions(state, [{ type: 'scene/set', scene: 'live' }])).toEqual([
      { type: 'mood/abort', token: 7 },
      { type: 'scene/set', scene: 'live' },
    ]);
  });
});

describe('분위기 반전 진행 중 full 영상 재생 (D2)', () => {
  it('진행 중 분위기 반전은 video/playFull 요청에도 먼저 비상 중단한다', () => {
    const state = createInitialState();
    state.sceneOpts.moodTransition = {
      active: true,
      phase: 'crossfade',
      assetId: 'media:260831_pt1_v001.mp4',
      token: 9,
    };
    const play = {
      type: 'video/playFull' as const,
      assetId: 'media:260831_pt2_v001.mp4',
      nextScene: 'suspects' as const,
      now: 1_700_000_000_000,
    };
    expect(routeMoodSceneActions(state, [play])).toEqual([{ type: 'mood/abort', token: 9 }, play]);
  });

  it('분위기 반전이 없으면 video/playFull 을 그대로 통과시킨다', () => {
    const state = createInitialState();
    const play = {
      type: 'video/playFull' as const,
      assetId: 'media:260831_pt2_v001.mp4',
      nextScene: null,
      now: 1_700_000_000_000,
    };
    expect(routeMoodSceneActions(state, [play])).toEqual([play]);
  });
});
