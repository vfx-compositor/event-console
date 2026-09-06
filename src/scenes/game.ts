import { P1_EVENT_NAMES } from '../state';
import type { AppState, P1EventId } from '../types';
import { h, renderInto, type VNode } from '../vdom';
import { view as standbyView } from './standby';

/**
 * 게임 대기 화면에 쓰는 **종목별 고정 이미지** (U29).
 *
 * 전체 대기 화면(`standby`)은 사진 배경 토글이 걸린 반복 영상이지만, 게임 대기는 종목마다
 * 다른 스틸 한 장이다 — 소개 영상이 끝난 자리에 그 종목의 그림이 그대로 이어져야 한다.
 * manifest에 올리지 않고 URL로 직접 읽는다: 운영자가 고르는 에셋이 아니라 씬에 붙박인
 * 그림이라, 등록 여부에 따라 화면이 달라지면 안 된다 (`pre_mission.svg`와 같은 이유).
 */
export const GAME_STEADY_IMAGES: Record<P1EventId, string> = {
  curling: './media/game_steady_curling.svg',
  newspaper: './media/game_steady_newspaper.svg',
  sticky: './media/game_steady_sticky.svg',
  sync: './media/game_steady_sync.svg',
};

/** 종목 대기 이미지 한 장. 매핑이 없으면 검정 대신 전체 대기 영상으로 떨어진다. */
function steadyView(state: AppState, eventId: P1EventId): VNode {
  const src = GAME_STEADY_IMAGES[eventId];
  if (!src) {
    return standbyView({
      ...state,
      sceneOpts: { ...state.sceneOpts, standby: { mode: 'main' } },
    });
  }
  return h(
    'div',
    { class: 'scene scene--standby-image-only scene--game-steady', 'data-event': eventId },
    h('img', {
      class: 'game-steady-image',
      src,
      alt: '',
      'aria-hidden': 'true',
    }),
  );
}

/**
 * ## 승리 보드 카드는 여기 있었다 (U71 → U110에서 폐기)
 *
 * 2026-09-05 04:56 사용자 지시: "송출보드 저건 폐기해. 내가 준 영상과 음악으로 대체하고."
 * 승리 발표는 이제 씬이 아니다 — `winner_<색>.webm` 알파 오버레이가 지금 화면 위로 올라오고
 * 승리 음악이 함께 나간다(`victoryOutputActions`, cue.ts). 그래서 이 씬은 다시 **오프닝과
 * 대기 둘**뿐이고, `sceneOpts.game.mode`에서도 `'victory'`가 빠졌다.
 *
 * **폴백을 되살리지 말 것.** "영상이 없으면 카드라도"는 U100의 판단이었고 U110이 뒤집었다.
 * 영상이 없으면 아무것도 내보내지 않고(아래 화면 유지) 컨트롤이 토스트로 파일 이름을 말한다 —
 * 카드가 나가면 운영자는 파일이 빠진 것을 모른 채 넘어간다.
 */
export function view(state: AppState): VNode {
  const { eventId, mode } = state.sceneOpts.game;
  if (mode === 'standby') return steadyView(state, eventId);

  return h(
    'div',
    {
      class: 'scene scene--game scene--game-opening',
      'data-event': eventId,
    },
    h('div', { class: 'game__wash' }),
    h('div', { class: 'game__orbit game__orbit--outer' }),
    h('div', { class: 'game__orbit game__orbit--inner' }),
    h(
      'div',
      { class: 'game__card' },
      h('div', { class: 'game__eyebrow' }, 'GAME OPENING'),
      h('div', { class: 'game__rule' }),
      h('h1', { class: 'game__title' }, P1_EVENT_NAMES[eventId]),
      h('div', { class: 'game__edition' }, 'EVENT CONSOLE · PART 1'),
    ),
    h('div', { class: 'game__corner game__corner--tl' }),
    h('div', { class: 'game__corner game__corner--br' }),
  );
}

export function render(state: AppState, root: HTMLElement): void {
  renderInto(root, view(state));
}
