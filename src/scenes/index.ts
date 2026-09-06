/**
 * 씬 셀렉터 — **2부 잠금은 여기서 렌더 레벨로 강제된다.** (SPEC P3 / AC-2)
 * 상태의 scene 값이 2부 씬이더라도 unlocked가 false면 standby로 강등한다.
 * (버튼을 숨기는 것만으로는 부족하다: 단축키·큐시트·복원된 상태 등 진입 경로가 여럿이므로
 *  마지막 관문인 렌더에서 막아야 유출이 원천 차단된다.)
 */

import * as award from './award';
import * as breaking from './breaking';
import * as game from './game';
import * as live from './live';
import * as photos from './photos';
import * as prompt from './prompt';
import * as roster from './roster';
import * as score from './score';
import * as standby from './standby';
import * as submit from './submit';
import * as suspects from './suspects';
import * as timerScene from './timerScene';
import * as video from './video';
import { renderInto, type VNode } from '../vdom';
import { P2_SCENES, type AppState, type SceneId } from '../types';

type SceneModule = {
  view(state: AppState): VNode;
  tick?(root: HTMLElement, state: AppState, now: number): void;
};

const MODULES: Record<SceneId, SceneModule> = {
  standby,
  game,
  live,
  score,
  timer: timerScene,
  roster,
  prompt,
  breaking,
  video,
  photos,
  suspects,
  submit,
  award,
};

/** 실제로 렌더할 씬 (잠금 강등 적용) */
export function pickScene(state: AppState): SceneId {
  if (!state.p2.unlocked && P2_SCENES.includes(state.scene)) return 'standby';
  return state.scene;
}

export function isDegraded(state: AppState): boolean {
  return pickScene(state) !== state.scene;
}

export function sceneView(state: AppState): VNode {
  return MODULES[pickScene(state)].view(state);
}

/**
 * HTML이 실제로 교체됐으면 true (display.ts가 슬롯 재부착 여부를 판단).
 *
 * `override`는 **전환 애니메이션이 화면을 덮고 있는 동안 이전 씬을 그대로 유지**하기 위한 것이다.
 * (상태는 이미 새 씬이지만 화면은 스윕이 덮은 순간에 갈아끼워야 자연스럽다.)
 */
/**
 * 씬을 그린다. `data-scene-enter`는 **씬이 바뀐 렌더에만** 남는다.
 *
 * `renderInto`는 HTML 문자열이 달라지면 innerHTML을 통째로 갈아끼우므로, 같은 씬 안에서
 * 데이터가 조금 바뀌어도(대결팀 토글 등) 진입 모션이 처음부터 다시 돈다 — 온에어 중
 * 1초짜리 행 등장이 재생되는 사고. CSS가 이 표시를 보고 진입 모션을 건너뛴다.
 *
 * 표시를 지우는 시점이 중요하다. HTML이 그대로인 프레임(대부분)에서 지우면 아직 돌고 있는
 * 진입 모션이 중간에 끊긴다. 그래서 **같은 씬에서 실제로 다시 그린 순간**에만 지운다.
 * 리더보드 재정렬은 transition이라 이 게이트와 무관하다.
 */
export function renderScene(state: AppState, root: HTMLElement, override?: SceneId): boolean {
  const id = override ?? pickScene(state);
  const entering = root.dataset.scene !== id;
  root.dataset.scene = id;
  if (entering) root.dataset.sceneEnter = '1';
  const changed = renderInto(root, MODULES[id].view(state));
  if (!entering && changed) delete root.dataset.sceneEnter;
  return changed;
}

export function tickScene(root: HTMLElement, state: AppState, now: number, override?: SceneId): void {
  MODULES[override ?? pickScene(state)].tick?.(root, state, now);
}

export const SCENE_LABELS: Record<SceneId, string> = {
  standby: '대기 화면',
  game: '게임 오프닝·대기',
  live: '경기 중계',
  score: '스코어보드',
  timer: '타이머',
  roster: '출전 명단',
  prompt: '제시어 카드',
  breaking: '긴급 속보',
  video: '영상 재생',
  photos: '현장 사진',
  suspects: '용의자 보드',
  submit: '제출 현황',
  award: '시상',
};
