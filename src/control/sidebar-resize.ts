/**
 * 좌측 사이드바 드래그 리사이즈 (U137)
 *
 * ## 어디서 왔나
 * 09-05 12:2x 사용자: "콘솔쪽 좌측 사이드가 너무 비좁은 느낌인데 잡고 끌 수 있게 해줄수
 * 있어? 어려운 작업이면 그냥 지금보다 1.1배". 그때는 **라이브 중**이라 회귀 위험이 없는
 * 쪽만 골라 폭을 1.1배로 넓혔다(U134 — `.main`의 `minmax(252px, 300px)` → `minmax(277px,
 * 330px)`). 09-06 행사가 끝난 뒤 "드래그 리사이즈 -> 진행해"로 본 작업이 열렸다.
 *
 * ## 왜 상태(AppState)가 아니라 localStorage인가
 * 폭은 **이 창의 보기 설정**이지 행사 데이터가 아니다. 원장·persist·출력 창 방송에 태우면
 * 사이드바를 끌 때마다 리더가 상태를 저장하고 출력 창까지 방송이 나간다 — 화면에 아무
 * 영향이 없는 값 때문이다. 기존 설치와 호환되는 UI 저장 칸 하나만 쓴다.
 *
 * ## 왜 저장값이 없을 때 `--sidebar-w`를 세우지 않는가
 * CSS 기본값은 `minmax(277px, 330px)`라 **범위**다 — 화면이 좁으면 277로 줄고 넓으면 330까지
 * 늘어난다. 저장값이 없다고 300px 같은 한 숫자를 박으면 그 반응형이 죽는다. 그래서
 * `grid-template-columns: var(--sidebar-w, minmax(277px, 330px)) …`로 두고, **사용자가 실제로
 * 끌었을 때만** 변수를 세운다. 더블클릭 초기화는 변수를 지워 이 범위로 되돌리는 것이다.
 *
 * ## 왜 재렌더를 보류하는가 (U43/U104 `renderHold` 재사용)
 * 조작 패널의 `render()`는 트리를 통째로 새로 만든다. 사이드바를 끄는 동안 다른 경로(동기화
 * 하트비트·타이머)에서 재렌더가 돌면 좌측·중앙 열의 내용물이 통째로 갈리며 드래그 내내
 * 리플로가 튄다. 볼륨·음악 슬라이더가 쓰던 계약을 그대로 재사용해 잡는 동안 DOM을 세워 둔다.
 *
 * ## 좌표 → 폭은 한 식이다
 * `widthFromDrag(startWidth, startX, clientX, viewportW)` 하나뿐이다. 잡은 순간의 폭과 x를
 * 기억하고 **이동량만 더한다** — 12px 띠 안 어디를 잡아도 손잡이가 튀지 않고, 포인터와
 * 구분선이 처음 잡은 간격을 끝까지 유지한다. 키보드도 같은 clamp를 통과한다.
 */

import type { Ctx } from './ctx';

/** 이 창의 보기 설정 저장 칸. 기존 사용자 설정 보존을 위해 키 이름을 유지한다. */
export const SIDEBAR_LS_KEY = 'nsdh.console.ui.sidebarWidth';

/**
 * 좌측 열 최소 폭. U134 이전의 최소값이자 **내부 구성요소가 접히도록 설계된 폭**이다
 * (씬 런처 격자·큐시트 줄이 이 폭에서 잘리지 않게 만들어져 있다). 이 아래로는 못 줄인다.
 */
export const SIDEBAR_MIN = 252;

/** 더블클릭 초기화가 돌아가는 자리 — 저장값을 지우면 CSS `minmax(277px, 330px)`가 다시 산다. */
export const SIDEBAR_DEFAULT = 300;

/** 절대 상한. 이보다 넓히면 중앙 종목 카드(2열, 카드당 540px 하한)가 1열로 무너진다. */
export const SIDEBAR_MAX_ABS = 480;

/** 화면 폭 대비 상한. 좁은 노트북에서 절대 상한만 두면 사이드바가 화면 절반을 먹는다. */
export const SIDEBAR_MAX_RATIO = 0.4;

/** 키보드 ←→ 한 칸. Shift를 누르면 큰 칸. */
export const SIDEBAR_STEP = 8;
export const SIDEBAR_STEP_BIG = 32;

/**
 * 지금 화면에서 허용되는 최대 폭. 절대 상한과 화면 비율 중 **작은 쪽**이고, 그래도 최소
 * 폭보다는 크다 — 화면이 아주 좁아 비율 상한이 최소 폭 아래로 내려가도 clamp가 뒤집히지
 * 않게(`min > max`가 되면 `Math.min`/`Math.max` 순서에 따라 엉뚱한 값이 나온다).
 */
export function sidebarMax(viewportW: number): number {
  const byRatio = Number.isFinite(viewportW) ? viewportW * SIDEBAR_MAX_RATIO : SIDEBAR_MAX_ABS;
  return Math.max(SIDEBAR_MIN, Math.round(Math.min(SIDEBAR_MAX_ABS, byRatio)));
}

/** 폭 하나를 지금 화면에서 유효한 범위로 자른다. 못 읽는 값은 기본값으로 떨어진다. */
export function clampSidebarWidth(px: number, viewportW: number): number {
  if (!Number.isFinite(px)) return clampSidebarWidth(SIDEBAR_DEFAULT, viewportW);
  return Math.round(Math.min(Math.max(px, SIDEBAR_MIN), sidebarMax(viewportW)));
}

/**
 * 드래그 중 폭 — **유일한 좌표→폭 계산식**이다.
 *
 * 잡은 순간의 폭(`startWidth`)에 포인터 이동량만 더한다. 절대 좌표(`clientX - 그리드 왼쪽`)로
 * 계산하면 12px 손잡이 띠의 어디를 잡았느냐에 따라 잡는 순간 최대 12px 튄다.
 */
export function widthFromDrag(
  startWidth: number,
  startX: number,
  clientX: number,
  viewportW: number,
): number {
  return clampSidebarWidth(startWidth + (clientX - startX), viewportW);
}

/**
 * 키보드 한 칸. 처리하지 않는 키는 `null`이라 호출부가 `preventDefault` 여부를 그대로 가른다
 * (전역 단축키를 삼키지 않기 위해 — 처리한 키만 막는다).
 */
export function widthFromKey(
  current: number,
  key: string,
  shift: boolean,
  viewportW: number,
): number | null {
  const step = shift ? SIDEBAR_STEP_BIG : SIDEBAR_STEP;
  switch (key) {
    case 'ArrowLeft':
      return clampSidebarWidth(current - step, viewportW);
    case 'ArrowRight':
      return clampSidebarWidth(current + step, viewportW);
    case 'Home':
      return SIDEBAR_MIN;
    case 'End':
      return sidebarMax(viewportW);
    default:
      return null;
  }
}

/**
 * 저장된 폭. **저장값이 없으면 `null`** — 0이나 기본값이 아니다. 호출부는 `null`일 때
 * `--sidebar-w`를 세우지 않아 CSS의 `minmax()` 반응형이 그대로 산다.
 *
 * localStorage 접근을 try/catch로 감싸는 이유: 사생활 보호 모드·사이트 데이터 차단 브라우저에서
 * `getItem` 자체가 던진다. 보기 설정 하나 때문에 조작 패널이 뜨지 못하면 안 된다.
 */
export function readSidebarWidth(): number | null {
  try {
    const raw = localStorage.getItem(SIDEBAR_LS_KEY);
    if (raw === null) return null;
    const px = Number(raw);
    return Number.isFinite(px) && px > 0 ? px : null;
  } catch {
    return null;
  }
}

export function writeSidebarWidth(px: number): void {
  try {
    localStorage.setItem(SIDEBAR_LS_KEY, String(Math.round(px)));
  } catch {
    /* 저장 못 해도 이번 세션 폭은 그대로 산다 */
  }
}

/** 더블클릭 초기화 — 지우면 CSS `minmax()` 기본 범위로 돌아간다. */
export function clearSidebarWidth(): void {
  try {
    localStorage.removeItem(SIDEBAR_LS_KEY);
  } catch {
    /* no-op */
  }
}

/** `px`가 `null`이면 변수를 지운다(= CSS 기본 범위 복귀). */
export function applySidebarWidth(main: HTMLElement, px: number | null): void {
  if (px === null) main.style.removeProperty('--sidebar-w');
  else main.style.setProperty('--sidebar-w', `${Math.round(px)}px`);
}

const TIP =
  '드래그해 좌측 폭을 조절합니다 · 더블클릭 초기화 · 포커스 후 ←→ 8px, Shift+←→ 32px, Home/End 최소·최대';

/**
 * `main`의 두 열 사이에 구분선을 꽂고 배선한다. **`.main`은 재렌더에서 살아남는 뼈대**(U72)라
 * 이 함수는 부팅 때 한 번만 불린다 — 매 렌더마다 부르면 리스너가 중복 등록된다.
 *
 * 구분선은 `main`의 **두 번째 자식**으로 들어간다. CSS가 3열 격자
 * (`좌 | 12px 구분선 | 중앙`)라 순서가 곧 배치다.
 */
export function installSidebarResizer(main: HTMLElement, ctx: Pick<Ctx, 'holdRender'>): HTMLElement {
  const resizer = document.createElement('div');
  resizer.className = 'col-resizer';
  resizer.tabIndex = 0;
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.setAttribute('aria-label', '좌측 패널 폭 조절');
  resizer.dataset.tip = TIP;
  main.insertBefore(resizer, main.children[1] ?? null);

  const viewport = (): number => window.innerWidth;
  /** 저장값이 없을 때의 실측 폭 — 키보드 첫 조작이 CSS `minmax()` 결과에서 이어지게. */
  const measured = (): number =>
    (main.firstElementChild as HTMLElement | null)?.getBoundingClientRect().width || SIDEBAR_DEFAULT;
  const currentWidth = (): number => readSidebarWidth() ?? measured();

  const paint = (px: number | null): void => {
    applySidebarWidth(main, px);
    const now = px ?? measured();
    resizer.setAttribute('aria-valuenow', String(Math.round(now)));
    resizer.setAttribute('aria-valuemin', String(SIDEBAR_MIN));
    resizer.setAttribute('aria-valuemax', String(sidebarMax(viewport())));
  };

  // 저장값이 있으면 그것으로, 없으면 CSS 기본 범위 그대로 두고 aria 값만 실측으로 채운다.
  const stored = readSidebarWidth();
  paint(stored === null ? null : clampSidebarWidth(stored, viewport()));

  let drag: { startX: number; startWidth: number; pointerId: number } | null = null;
  let frame = 0;
  let pendingX = 0;

  const flush = (): void => {
    frame = 0;
    if (!drag) return;
    paint(widthFromDrag(drag.startWidth, drag.startX, pendingX, viewport()));
  };

  const endDrag = (): void => {
    if (!drag) return;
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    const px = widthFromDrag(drag.startWidth, drag.startX, pendingX, viewport());
    drag = null;
    document.body.classList.remove('is-resizing');
    paint(px);
    writeSidebarWidth(px);
    ctx.holdRender('sidebar-resize', false);
  };

  resizer.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    drag = { startX: ev.clientX, startWidth: currentWidth(), pointerId: ev.pointerId };
    pendingX = ev.clientX;
    resizer.setPointerCapture(ev.pointerId);
    document.body.classList.add('is-resizing');
    ctx.holdRender('sidebar-resize', true);
  });

  resizer.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    pendingX = ev.clientX;
    // rAF 스로틀 — pointermove는 프레임당 여러 번 온다. 그리드 재배치를 그때마다 돌리면
    // 좌측 열 전체가 초당 수백 번 리플로한다.
    if (!frame) frame = requestAnimationFrame(flush);
  });

  resizer.addEventListener('pointerup', endDrag);
  resizer.addEventListener('pointercancel', endDrag);
  resizer.addEventListener('lostpointercapture', endDrag);

  resizer.addEventListener('dblclick', () => {
    clearSidebarWidth();
    paint(null);
  });

  resizer.addEventListener('keydown', (ev) => {
    const next = widthFromKey(currentWidth(), ev.key, ev.shiftKey, viewport());
    if (next === null) return;
    // 처리한 키만 막는다 — 전역 단축키(스페이스·다른 화살표)는 그대로 흘려보낸다.
    ev.preventDefault();
    ev.stopPropagation();
    paint(next);
    writeSidebarWidth(next);
  });

  // 창이 좁아지면 저장된 폭이 새 상한을 넘길 수 있다. 저장값은 건드리지 않고 화면만 자른다 —
  // 창을 다시 넓히면 원래 폭으로 돌아오는 편이 "내가 정한 폭"이라는 모델과 맞는다.
  window.addEventListener('resize', () => {
    const saved = readSidebarWidth();
    if (saved === null) {
      paint(null);
      return;
    }
    paint(clampSidebarWidth(saved, viewport()));
  });

  return resizer;
}
