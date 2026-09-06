/**
 * 지금 **향하고 있는 씬** (U125).
 *
 * ## 무엇을 고치는가
 * 전환(스팅어·컬러 페이드)은 누른 순간이 아니라 `switchAtSec`이 지난 뒤에 씬을 갈아 끼운다.
 * 그 사이(실측 0.28초, display가 바쁘면 1.1초까지) `state.scene`은 **아직 옛 씬**이다.
 * 그런데 큐 해석은 전부 `state.scene`을 읽고 있었다 — 그래서 그 구간에 들어온 다음 큐가
 * 화면이 이미 떠난 씬을 기준으로 판정돼 두 가지로 어긋났다(2026-09-05 U125 사용자 신고):
 *
 *  - 도착 씬과 **같은 씬**을 목표로 하는 큐가 `sceneSetChange()`에서 "바뀌는 것 없음"으로 읽혀
 *    전환이 걸리지 않고, 그대로 흘러간 `scene/set`의 리듀서가 `cancelTransitionVideo()`로
 *    **돌고 있던 스팅어를 화면에서 뜯어낸다** → "넘어가는 애니메이션만 나오고 원래 화면이
 *    다시 나옴".
 *  - 매치 큐가 `matchCueOnRightScene()`에서 "엉뚱한 씬"으로 판정돼 영상을 내지 않고 씬만 옮기며
 *    커서를 한 칸 물린다(U42 리뷰의 되감기) → 매치 영상이 안 나가고, 물러난 커서 때문에
 *    다음 [다음 →]이 **매치 영상을 한 번 더** 재생한다.
 *
 * ## 규칙 한 줄
 * **"지금 보이는 씬"이 아니라 "이 조작이 끝나면 도착할 씬"으로 판정한다.** 전환이 아직 컷 전이면
 * 그 목적지가 곧 현재의 뜻이다 — 운영자는 이미 그 화면으로 가라고 눌렀고, 스팅어는 그 요청이
 * 화면에 도착하는 중일 뿐이다.
 *
 * 전환이 없으면 `state.scene`을 그대로 돌려준다 — 그래서 평상시 동작은 한 글자도 달라지지 않고,
 * 달라지는 것은 **전환이 도는 동안 눌린 큐**뿐이다.
 *
 * ## 컷이 끝난 전환은 보지 않는다
 * `switched`가 참이면 씬은 이미 갈렸고 `state.scene`이 정답이다. 스팅어 그림은 아직 1초쯤 더
 * 남아 있지만 그것은 덮개일 뿐 씬의 주인이 아니다.
 */

import type { AppState, SceneId, SceneOpts } from './types';

/** 이 조작이 끝나면 화면이 서 있을 씬. 전환이 컷 전이면 그 목적지, 아니면 지금 씬. */
export function pendingScene(state: AppState): SceneId {
  const transition = state.sceneOpts.transitionVideo;
  if (transition.active && !transition.switched && transition.nextScene) return transition.nextScene;
  const fade = state.sceneOpts.sceneFade;
  if (fade.active && !fade.switched && fade.nextScene) return fade.nextScene;
  return state.scene;
}

/**
 * 같은 규칙의 대기 화면 모드 (U35 축).
 *
 * 사전미션 ↔ 메인 대기는 씬이 둘 다 `standby`라 모드만으로 갈린다. 씬만 도착값으로 보고 모드는
 * 옛 값으로 보면, 전환 중에 누른 대기 화면 큐가 "모드가 바뀐다"고 잘못 읽혀 전환이 한 겹 더 걸린다.
 */
/**
 * 영상 종료 폴백(`video-ended`)이 지금 씬을 옮겨야 하는가 — 옮긴다면 어느 씬으로 (U125b).
 *
 * ## 무엇을 받는 자리인가
 * "영상이 끝났는데 페이드 상태 머신이 치우지 않고 있다"는 안전망이다. 페이드가 도는 동안
 * (`phase !== 'idle'`)에는 `fullvideo-tail`이 종료를 맡으므로 여기서는 손을 뗀다 — 검정이
 * 덮기 전에 다음 씬이 드러나기 때문이다.
 *
 * ## 왜 `state.scene`으로는 부족했나 (2026-09-05 U125b 신고)
 * 운영자가 영상이 끝나기 **직전에** 다음 큐를 누르면 `video/abort`가 phase를 `idle`로 내린다.
 * 그런데 `video/abort`는 **씬을 건드리지 않으므로** 화면은 여전히 `'video'`이고, 영상은
 * 스팅어 밑에서 계속 돌다가 곧 `ended`를 낸다. 그 순간이 정확히 `phase === 'idle' &&
 * scene === 'video'`라 이 폴백이 살아나, 운영자가 고른 씬 대신 영상의 `nextScene`으로 화면을
 * 끌고 갔다. 그 `scene/set`이 돌던 스팅어를 취소하며 **영상이 한 번 드러나고**("영상이 또 살짝
 * 보인 뒤 전환"), 도착지도 명단이 아니라 대기 화면이 됐다(실측: 큐는 `roster-newspaper-heat`
 * 인데 씬은 `standby`).
 *
 * 그래서 `pendingScene`으로 묻는다 — 전환이 아직 컷 전이면 화면의 주인은 이미 다음 큐다.
 * 전환이 없으면 `state.scene`과 같은 값이라 원래 동작 그대로다.
 *
 * `null`이면 아무것도 하지 않는다.
 */
export function videoEndedFallbackScene(state: AppState): SceneId | null {
  if (state.sceneOpts.video.phase !== 'idle') return null;
  if (pendingScene(state) !== 'video') return null;
  return state.sceneOpts.video.nextScene ?? null;
}

export function pendingStandbyMode(state: AppState): SceneOpts['standby']['mode'] {
  const transition = state.sceneOpts.transitionVideo;
  if (transition.active && !transition.switched && transition.nextStandbyMode) {
    return transition.nextStandbyMode;
  }
  const fade = state.sceneOpts.sceneFade;
  if (fade.active && !fade.switched && fade.nextStandbyMode) return fade.nextStandbyMode;
  return state.sceneOpts.standby.mode;
}
