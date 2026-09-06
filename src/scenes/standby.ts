import { h, renderInto, type VNode } from '../vdom';
import type { AppState } from '../types';
import bundledManifest from '../../public/media/manifest.json';

// Only request optional videos explicitly shipped with this installation.
const bundledFiles = new Set((bundledManifest as Array<{ file: string }>).map((entry) => entry.file));

/**
 * 사전미션은 지정 이미지 한 장, 일반 대기는 사진 토글에 맞는 반복 영상을 표시한다.
 *
 * ## 왜 두 영상을 항상 함께 렌더하는가 (U19)
 * `renderInto`는 HTML 문자열이 달라진 순간 stage를 통째로 교체한다. 예전처럼 토글에 따라
 * `src`를 갈아치우면 (1) 영상이 처음부터 다시 돌고 (2) 겹쳐 페이드할 상대가 없다.
 * 그래서 light/dark와 사진 슬롯을 **조건 없이** 렌더해 HTML을 고정하고, 어느 쪽이 보일지는
 * display가 opacity로만 정한다 (`standby-crossfade.ts` · 사진 씬의 §11 L9와 같은 이유).
 *
 * ## 왜 스택 두 개로 감싸는가
 * 크로스디졸브는 **완성된 그림 두 장** 사이에서만 밝기 손실 없이 일어난다. 영상 세 장(사진
 * 백드롭 포함)을 각자 페이드시키면 중간에서 합성 가중치가 1에 못 미쳐 검정이 새어 나온다.
 * 그래서 "끈 상태의 그림"과 "켠 상태의 그림"을 각각 한 덩어리로 묶고, display는 덩어리
 * **하나의 opacity**만 움직인다. 자세한 산수는 `standbyBackdropLayers` 주석에 있다.
 */
/**
 * 선수 선서 안내 이미지 경로 (U60). `pre_mission.svg`와 같은 **씬 붙박이 그림**이라
 * 매니페스트에 올리지 않고 URL로 직접 읽는다 — 운영자가 고르는 에셋이 아니므로 등록
 * 여부에 따라 화면이 달라지면 안 된다 (`scenes/game.ts`의 `GAME_STEADY_IMAGES`와 같은 이유).
 */
export const ATHLETE_OATH_IMAGE = './media/athlete_oath.svg';

/**
 * 파일이 아직 없을 때 검은 화면이 나가지 않게 하는 폴백 (U60).
 *
 * 이미지가 없으면 브라우저는 깨진 아이콘 하나만 남기고 나머지는 검정이다 — 프로젝터에서는
 * "송출이 끊겼다"로 보인다. `onerror`가 프레임에 `is-missing`을 붙이면 CSS가 이미지를 감추고
 * 같은 자리의 타이포 카드를 드러낸다. JS 없이 순수 CSS 상태 전환이라 렌더 경로를 타지 않는다.
 */
const OATH_FALLBACK_ONERROR = "this.closest('.oath-frame').classList.add('is-missing')";

export function view(state: AppState): VNode {
  const mode = state.sceneOpts.standby.mode;
  if (mode === 'pre-mission') {
    return h(
      'div',
      { class: 'scene scene--standby-image-only' },
      h('img', {
        class: 'pre-mission-image',
        src: './media/pre_mission.svg',
        alt: '',
        'aria-hidden': 'true',
      }),
    );
  }
  if (mode === 'oath') {
    return h(
      'div',
      { class: 'scene scene--standby-image-only scene--oath' },
      h(
        'div',
        { class: 'oath-frame' },
        h('img', {
          class: 'oath-image',
          src: ATHLETE_OATH_IMAGE,
          alt: '',
          'aria-hidden': 'true',
          onerror: OATH_FALLBACK_ONERROR,
        }),
        h(
          'div',
          { class: 'oath-fallback' },
          h('div', { class: 'oath-fallback__title' }, '선수 선서'),
          h('div', { class: 'oath-fallback__rule' }),
          h('div', { class: 'oath-fallback__edition' }, 'EVENT CONSOLE'),
        ),
      ),
    );
  }

  const standbyVideo = (variant: 'light' | 'dark') =>
    h('video', {
      class: `main-standby-video main-standby-video--${variant}`,
      'data-standby-video': variant,
      src: bundledFiles.has(`main_05_${variant}.webm`) ? `./media/main_05_${variant}.webm` : undefined,
      poster: `./media/standby-${variant}.svg`,
      autoplay: true,
      loop: true,
      muted: true,
      playsinline: true,
      alt: '',
      'aria-hidden': 'true',
    });

  return h(
    'div',
    { class: 'scene scene--standby-video' },
    // 사진 배경 **끈** 상태의 완성된 그림 — 불투명한 밝은 영상 한 장
    h(
      'div',
      { class: 'standby-stack standby-stack--off', 'data-standby-stack': 'off' },
      standbyVideo('light'),
    ),
    // 사진 배경 **켠** 상태의 완성된 그림 — 검정 지면 위 사진 백드롭, 그 위 알파 영상.
    // 스택 안에서 먼저 합성한 뒤 이 덩어리 전체가 페이드 인한다(중간 밝기 dip 방지).
    h(
      'div',
      { class: 'standby-stack standby-stack--on', 'data-standby-stack': 'on' },
      h('div', { class: 'photo-stage photo-backdrop', 'data-photo-slot': '' }),
      standbyVideo('dark'),
    ),
  );
}

export function render(state: AppState, root: HTMLElement): boolean {
  return renderInto(root, view(state));
}
