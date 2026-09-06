import type { Action } from './state';
import type { AppState } from './types';

export const MOOD_PART1_ASSET_ID = 'media:260831_pt1_v001.mp4';

export function routeMoodSceneActions(state: AppState, requested: Action[]): Action[] {
  const routed: Action[] = [];
  for (const action of requested) {
    if (action.type === 'scene/set' && action.scene === 'breaking') {
      const assetId = state.assets.some((asset) => asset.id === MOOD_PART1_ASSET_ID)
        ? MOOD_PART1_ASSET_ID
        : null;
      routed.push({ type: 'mood/start', assetId });
      continue;
    }
    // `video/playFull`도 씬의 다음 주인을 정하는 요청이다 (D2). 여기서 끊지 않으면 속보(분위기 반전)
    // 오버레이가 pt1 소리를 낸 채로 Part 영상과 겹쳐 돌고, 오버레이가 끝나는 순간 `mood/finish`가
    // 재생 중인 영상을 덮어쓰며 씬을 suspects로 끌고 간다.
    if (
      (action.type === 'scene/set' || action.type === 'video/playFull') &&
      state.sceneOpts.moodTransition.active
    ) {
      routed.push({ type: 'mood/abort', token: state.sceneOpts.moodTransition.token });
    }
    routed.push(action);
  }
  return routed;
}
