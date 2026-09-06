import type { SceneId, SceneOpts } from './types';

/**
 * Bake된 이미지 단독 출력 씬에서는 마우스용 운영 컨트롤을 합성하지 않는다.
 *
 * 게임 대기도 여기 들어온다 (U29). 종목별 고정 이미지 한 장을 풀프레임으로 띄우는
 * 화면이라 사전미션과 **같은 계약**이다 — 판정을 두 곳에 나눠 쓰면 한쪽에만 배지가
 * 남아 프로젝터에 안내 문구가 찍힌다. 이미지 단독 씬은 이 함수 하나가 정의한다.
 */
export function displayOperatorControlHidden(
  scene: SceneId,
  standbyMode: SceneOpts['standby']['mode'] = 'main',
  gameMode: SceneOpts['game']['mode'] = 'opening',
): boolean {
  // 선수 선서(U60)도 이미지 한 장짜리 안내 화면이다 — 사전미션과 같은 계약이다.
  // 모드 유니온이 늘 때마다 여기 목록을 고치지 않도록 "메인 대기가 아니면 이미지"로 적는다.
  if (scene === 'standby') return standbyMode !== 'main';
  // 승리 보드(U71)는 이미지가 아니라 타이포 카드라 오프닝과 같이 배지를 그대로 둔다.
  if (scene === 'game') return gameMode === 'standby';
  return false;
}

/** image-only 계약이 운영 배지의 일시 표시 요청보다 항상 우선한다. */
export function displayOperatorOverlayVisible(
  scene: SceneId,
  requestedVisible: boolean,
  standbyMode: SceneOpts['standby']['mode'] = 'main',
  gameMode: SceneOpts['game']['mode'] = 'opening',
): boolean {
  return requestedVisible && !displayOperatorControlHidden(scene, standbyMode, gameMode);
}
