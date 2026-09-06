/**
 * 큐 경계별 전환 선택 (U42).
 *
 * ## 왜 필요한가
 * 전환 방식(화이트/블랙/스팅어)은 지금까지 **전역 하나**였다. 그런데 대본상 필요한 전환은
 * 자리마다 다르다 — 개회식 진입은 스팅어가 맞고, 반전 직전은 검정이 맞고, 시상 발표는 화이트가
 * 맞다. 전역 하나로 하면 운영자가 큐를 넘기기 **직전마다** 상단(지금은 런처)에서 방식을 바꾸고
 * 다시 되돌려야 한다. 그 두 조작 사이가 방송에 그대로 나간다.
 *
 * 그래서 큐시트의 **경계**(= 이 큐로 들어가는 순간)마다 선택을 붙인다. 고르지 않으면 전역을
 * 따르므로, 대부분의 자리는 지금까지와 똑같이 동작한다.
 *
 * ## 순차 진행에서만 적용한다
 * `→`/`←`(또는 [다음]/[이전])로 대본을 따라 갈 때만 쓴다. 큐를 직접 클릭하거나 런처에서
 * 씬으로 점프하는 것은 **대본을 벗어난 조작**이고, 그때 대본상의 전환이 걸리면 운영자가
 * 예상하지 못한 연출이 나간다. 그 경우는 전역을 그대로 쓴다.
 *
 * ## 영상 항목은 "시작 전 전환"만이다
 * 영상 큐는 `scene/set`이 아니라 `video/playFull`·`transition/play`·`overlay/play`를 낸다.
 * 그것들은 자기 페이드·스팅어를 스스로 들고 있어 중앙 경계(`scene-routing.ts`)를 구조적으로
 * 타지 않는다(§2-3). 그래서 영상 큐에서 이 선택이 실제로 걸리는 자리는 **영상이 시작되기 전에
 * 씬을 옮기는 경우**(예: 매치 영상을 엉뚱한 화면에서 눌러 먼저 종목 대기화면으로 가는 경로)뿐이다.
 * 화면에서도 그렇게 안내한다 — 걸리지도 않을 선택을 걸리는 것처럼 보이게 두면 안 된다.
 */

import { scriptedOutroForCueId } from './scripted-outro';
import type { SceneTransitionMode } from './types';

export type CueTransitions = Record<string, SceneTransitionMode>;

/**
 * 대본이 전환까지 못 박은 경계 (U87).
 *
 * 아웃트로가 붙은 영상은 **자기 끝을 스스로 연출한다** — 올림픽 인트로는 5초 오디오 페이드 뒤
 * 화이트로 덮고 대기 화면으로 돌아온다. 그 자리에서 운영자가 블랙이나 스팅어를 고를 수 있으면,
 * 고른 값이 실제로는 아무 데도 걸리지 않으면서 화면에는 걸린 것처럼 보인다. 그래서 값 자체를
 * 여기서 못 박고, 저장본에 남아 있는 옛 지정은 `normalizeCueTransitions`가 지운다.
 *
 * `null`이면 잠기지 않은 보통 경계다.
 */
export function lockedCueTransition(
  cueId: string | null | undefined,
): SceneTransitionMode | null {
  return scriptedOutroForCueId(cueId)?.boundaryMode ?? null;
}

/** 잠긴 경계의 안내 문구 — 왜 못 누르는지 그 자리에서 답한다 */
export function lockedCueTransitionTip(cueId: string | null | undefined): string | null {
  return scriptedOutroForCueId(cueId)?.tip ?? null;
}

const MODES: readonly SceneTransitionMode[] = ['white', 'black', 'stinger'];

/** 경계 아이콘 넷. `null` = 전역 따르기(기본). */
export interface CueTransitionChoice {
  mode: SceneTransitionMode | null;
  /** 이음선 위에 얹는 기호 — 글자가 아니라 형태로 구분한다 */
  mark: string;
  label: string;
  tip: string;
}

export function cueTransitionChoices(globalMode: SceneTransitionMode): CueTransitionChoice[] {
  return [
    {
      mode: null,
      mark: '·',
      label: '전역 따르기',
      tip: `이 경계는 전역 전환 방식(지금 ${MODE_LABEL[globalMode]})을 그대로 씁니다. 기본값입니다.`,
    },
    { mode: 'white', mark: '◻', label: '화이트', tip: '이 경계에서만 흰 화면으로 덮었다 넘어갑니다.' },
    { mode: 'black', mark: '◼', label: '블랙', tip: '이 경계에서만 검은 화면으로 덮었다 넘어갑니다.' },
    {
      mode: 'stinger',
      mark: '◆',
      label: '스팅어',
      tip: '이 경계에서만 전환 영상(대판)으로 덮었다 넘어갑니다. 쓸 전환 영상이 없으면 하드컷입니다.',
    },
  ];
}

export const MODE_LABEL: Record<SceneTransitionMode, string> = {
  white: '화이트',
  black: '블랙',
  stinger: '스팅어',
};

/**
 * 이 큐 경계에 지정된 방식. 없으면 `null`(전역 따르기).
 *
 * 잠긴 경계(U87)는 **저장본을 보지 않는다** — 이 결정 이전에 저장된 브라우저에 남아 있는 지정이나
 * 손으로 고친 저장본이 대본 고정 전환을 조용히 바꾸지 못하게, 순수 해석기 안에서 걷어 낸다.
 */
export function cueTransitionOf(
  map: CueTransitions,
  cueId: string | null | undefined,
): SceneTransitionMode | null {
  if (!cueId) return null;
  const locked = lockedCueTransition(cueId);
  if (locked) return locked;
  const mode = map[cueId];
  return MODES.includes(mode) ? mode : null;
}

/**
 * 지정하거나 해제한다. `null`이면 키 자체를 지운다 —
 * `'global'` 같은 센티널 값을 넣으면 저장본에 죽은 키가 쌓이고 "전부 전역으로"가 무의미해진다.
 */
export function setCueTransition(
  map: CueTransitions,
  cueId: string,
  mode: SceneTransitionMode | null,
): CueTransitions {
  // 잠긴 경계에는 아무것도 쓰지 않는다 (U87). 화면이 못 누르게 막아도 단축키·복원·다른 창의
  // 방송이 같은 액션을 낼 수 있고, 그때 죽은 키가 저장본에 쌓이면 [전부 전역으로]가 켜진다.
  if (lockedCueTransition(cueId)) return map;
  if (mode === null) {
    if (!(cueId in map)) return map;
    const next = { ...map };
    delete next[cueId];
    return next;
  }
  if (map[cueId] === mode) return map;
  return { ...map, [cueId]: mode };
}

/**
 * 저장본 복원 — 알 수 없는 방식은 버린다(그 자리가 조용히 하드컷이 되는 것을 막는다).
 * 잠긴 경계(U87)의 지정도 함께 버린다 — 값이 남아 있으면 지정이 하나도 없는데
 * [전환 전부 전역으로] 버튼이 켜져, 눌러도 아무 변화가 없는 버튼이 된다.
 */
export function normalizeCueTransitions(raw: unknown): CueTransitions {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: CueTransitions = {};
  for (const [cueId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (lockedCueTransition(cueId)) continue;
    if (MODES.includes(value as SceneTransitionMode)) out[cueId] = value as SceneTransitionMode;
  }
  return out;
}

/** 지정이 하나라도 있는가 — [전부 전역으로] 버튼을 띄울지 정한다 */
export function hasCueTransitions(map: CueTransitions): boolean {
  return Object.keys(map).length > 0;
}
