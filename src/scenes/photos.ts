/**
 * 현장 사진 슬라이드쇼 씬 — **순수 뷰 + 표시 정책 함수**만 둔다 (계획 §4-1 · §11 H3/L9/M3).
 *
 * 재생(크로스페이드·Ken Burns·objectURL 수명)은 전부 `display.ts`가 런타임으로 돌린다.
 * 여기서 만드는 것은 두 레이어가 꽂힐 **빈 슬롯 하나**뿐이다.
 *
 * ## 잠금 계약 (AC-2)
 * 이 뷰는 파일명·촬영 시각·장수 등 **어떤 사진 메타도 텍스트로 렌더하지 않는다.**
 * 현장 사진 파일명이 `용의자_후보.jpg`이기만 해도 1부 송출 화면에 금지어가 그대로 뜬다.
 * 그래서 `state`를 읽지 않는다 — 읽을 것이 없어야 유출될 자리도 없다.
 * (런타임 `<img>`도 같은 이유로 `alt=''` 고정 · `title`/`aria-label` 미설정 — display.ts 참조.)
 *
 * ## 왜 HTML이 상태와 무관하게 **완전히 고정**인가 (§11 L9)
 * `renderInto`는 HTML 문자열이 달라진 순간 stage를 통째로 교체한다. 사진이 바뀔 때마다
 * (혹은 "0장일 때만 브랜드 배경") HTML이 달라지면 매번 innerHTML이 갈리면서
 *  (1) 두 레이어가 날아가 크로스페이드가 끊기고
 *  (2) `.scene`의 진입 애니메이션(scene-in)이 재생돼 화면이 깜빡인다.
 * 그래서 `.photo-brand`는 **조건 없이 항상** 렌더하고, 빈 상태는 "레이어가 투명한 상태"로 표현한다.
 */

import { h, renderInto, type VNode } from '../vdom';
import { standbyCrossfadeScene } from '../standby-crossfade';
import type { AppState, PhotoSettings, SceneId } from '../types';

/** 설명 영상 3단계 상태 머신의 phase (display.ts와 같은 타입) */
type VideoPhase = AppState['sceneOpts']['video']['phase'];

export function view(_state: AppState): VNode {
  return h(
    'div',
    { class: 'scene scene--photos' },
    // 사진 뒤에 항상 깔리는 브랜드 지면. `object-fit: contain`의 레터박스 여백이 이 색이다.
    h('div', { class: 'photo-brand' }),
    // 슬롯 속성은 **고정**이다. video 씬처럼 assetId를 넣으면 사진이 바뀔 때마다 HTML이 달라진다.
    h('div', { class: 'photo-stage', 'data-photo-slot': '' }),
  );
}

export function render(state: AppState, root: HTMLElement): boolean {
  return renderInto(root, view(state));
}

/** display가 사진 슬롯에 붙일 합성 효과 클래스. 배열 순서는 CSS 우선순위와 무관하게 고정한다. */
export function photoFilterClasses(settings: PhotoSettings): string[] {
  const classes: string[] = [];
  if (settings.sepia) classes.push('is-sepia');
  if (settings.vignette) classes.push('is-vignette');
  if (settings.grain) classes.push('is-grain');
  return classes;
}

/**
 * 전체 사진 씬 또는 사용자가 허용한 대기 화면에서만 사진 재생기를 돌린다.
 *
 * 대기 배경 판정은 `standbyCrossfadeScene`과 **같은 함수**를 쓴다. 두 곳에 조건을 따로 쓰면
 * "사진은 도는데 크로스는 안 하는" 화면이 생긴다 — 실제로 사전미션(이미지 한 장)에서 사진
 * 런타임만 돌아 objectURL을 만들고 버리는 낭비가 그 모양이었다.
 *
 * 게임 대기 화면은 종목별 고정 이미지 한 장이라 여기서 항상 false다 (U29) — 사진이 깔릴
 * 자리가 없다. `modes`를 넘기지 않으면 대기 씬은 일반(`main`) 모드로 본다.
 */
export function photoPlaybackEnabled(
  scene: SceneId,
  settings: PhotoSettings,
  modes: {
    standbyMode?: AppState['sceneOpts']['standby']['mode'];
  } = {},
): boolean {
  if (scene === 'photos') return true;
  if (!settings.standbyBackdrop) return false;
  return standbyCrossfadeScene(scene, modes.standbyMode ?? 'main');
}

/**
 * 런타임 `<img>` 레이어에 붙는 속성의 **전부** (§11 H3 · M2).
 *
 * display.ts가 `document.createElement('img')` 뒤에 손으로 붙이던 것을 순수 팩토리로 뺐다.
 * 이유는 검증이다 — DOM 없이 돌아가는 vitest에서 "사진 메타가 속성으로 새지 않는다"를
 * **런타임이 실제로 쓰는 그 값**에 대고 단언할 수 있어야 한다. 뷰 HTML만 검사하면
 * `<img>`는 뷰에 없으므로(슬롯만 있다) 이 경로는 영영 무검증으로 남는다.
 *
 * 계약: `alt=''`(장식 이미지 — 접근성 트리에서 제외) 외에 `title`·`aria-*`·`data-*`는 **없다**.
 * 값에도 파일명·촬영시각 등 사진에서 파생된 문자열이 들어가지 않는다(전부 고정 리터럴이다).
 * 유일하게 사진마다 달라지는 것은 런타임이 넣는 `src`(objectURL)뿐이고, 그건 blob: URL이라
 * 원본 파일명을 담지 않는다.
 */
export function photoLayerAttrs(): Record<string, string> {
  return {
    class: 'photo-layer',
    alt: '',
    decoding: 'async',
    draggable: 'false',
  };
}

/**
 * 스팅어(알파 전환)·설명 영상 페이드가 화면을 덮고 있는 동안 슬라이드쇼를 어떻게 둘 것인가 (§11 M3).
 *
 * `transition-video.ts`의 `transitionAmbientPresentation`과 **같은 자리·같은 모양**의 순수 함수다.
 * (같은 문제 — "위 레이어가 GPU를 쓰는 동안 아래 레이어의 합성 부하를 뺀다" — 이므로 형태를 맞춘다.)
 *
 * 왜 필요한가:
 *  · 1080p 알파 스팅어와 Ken Burns(transform 애니메이션 2장)를 동시에 올리면 합성기가 프레임을 놓친다.
 *    실측 이력이 있는 조합이라(ambient ↔ 알파 영상) 같은 방식으로 미리 뺀다.
 *  · 덮여 있는 동안 사진이 넘어가면 **아무도 못 본 채로 한 장이 소모된다.** 스팅어가 걷혔을 때
 *    시작하던 사진이 그대로 있어야 한다 → `hold`.
 *
 * 반환값
 *  · `motion`     — Ken Burns transform을 계속 굴릴 것인가 (false면 현재 위치에 정지)
 *  · `willChange` — 레이어에 `will-change`를 유지할 것인가 (false면 해제해 합성 레이어를 반납)
 *  · `hold`       — 다음 사진으로 넘어가는 시계를 멈출 것인가
 */
export interface PhotoPresentation {
  motion: boolean;
  willChange: boolean;
  hold: boolean;
}

export function photoTransitionPresentation(
  transitionActive: boolean,
  videoPhase: VideoPhase,
): PhotoPresentation {
  const covered = Boolean(transitionActive) || videoPhase !== 'idle';
  return { motion: !covered, willChange: !covered, hold: covered };
}
