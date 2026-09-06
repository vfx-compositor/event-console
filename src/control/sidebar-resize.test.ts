/**
 * U137 — 좌측 사이드바 드래그 리사이즈.
 *
 * 지시: 09-05 12:2x "콘솔쪽 좌측 사이드가 너무 비좁은 느낌인데 잡고 끌 수 있게 해줄수 있어?"
 * → 라이브 중이라 1.1배(U134)만 하고 미뤘고, 09-06 "드래그 리사이즈 -> 진행해"로 열렸다.
 *
 * vitest는 node 환경이라 실제 드래그를 돌릴 수 없다. 그래서 **판단은 전부 순수 함수**로
 * 빼 두고 여기서 그 계약을 고정한다: 경계값 clamp, 좌표→폭 한 식, 저장 라운드트립,
 * 키보드 한 칸. DOM 배선(포인터 캡처·rAF·hold)은 소스 문자열로 확인한다 — 이 저장소의
 * 다른 DOM 컴포넌트 스위트와 같은 관례다.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';

import {
  SIDEBAR_DEFAULT,
  SIDEBAR_LS_KEY,
  SIDEBAR_MAX_ABS,
  SIDEBAR_MAX_RATIO,
  SIDEBAR_MIN,
  SIDEBAR_STEP,
  SIDEBAR_STEP_BIG,
  clampSidebarWidth,
  clearSidebarWidth,
  readSidebarWidth,
  sidebarMax,
  widthFromDrag,
  widthFromKey,
  writeSidebarWidth,
} from './sidebar-resize';

const source = readFileSync(new URL('./sidebar-resize.ts', import.meta.url), 'utf8');
const holdSource = readFileSync(new URL('./render-hold.ts', import.meta.url), 'utf8');
const controlSource = readFileSync(new URL('../control.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles/control.css', import.meta.url), 'utf8');

/** 넓은 화면 — 비율 상한(40%)이 절대 상한(480)보다 커서 480이 이긴다. */
const WIDE = 1920;

describe('폭 clamp', () => {
  it('최소·최대 사이로 자르고 정수로 떨어뜨린다', () => {
    expect(clampSidebarWidth(300, WIDE)).toBe(300);
    expect(clampSidebarWidth(100, WIDE)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(9999, WIDE)).toBe(SIDEBAR_MAX_ABS);
    expect(clampSidebarWidth(300.6, WIDE)).toBe(301);
  });

  it('경계값은 그대로 통과한다', () => {
    expect(clampSidebarWidth(SIDEBAR_MIN, WIDE)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(SIDEBAR_MAX_ABS, WIDE)).toBe(SIDEBAR_MAX_ABS);
  });

  it('좁은 화면에서는 화면 비율(40%)이 절대 상한보다 먼저 걸린다', () => {
    expect(sidebarMax(1000)).toBe(400);
    expect(sidebarMax(WIDE)).toBe(SIDEBAR_MAX_ABS);
    expect(clampSidebarWidth(9999, 1000)).toBe(400);
  });

  it('아주 좁은 화면에서도 상한이 최소 폭 아래로 뒤집히지 않는다', () => {
    // 400 × 0.4 = 160 < 252. min > max가 되면 clamp가 엉뚱한 값을 낸다.
    expect(sidebarMax(400)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(300, 400)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(10, 400)).toBe(SIDEBAR_MIN);
  });

  it('못 읽는 값은 기본값으로 떨어진다', () => {
    expect(clampSidebarWidth(Number.NaN, WIDE)).toBe(SIDEBAR_DEFAULT);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY, WIDE)).toBe(SIDEBAR_DEFAULT);
    expect(clampSidebarWidth(Number.NEGATIVE_INFINITY, WIDE)).toBe(SIDEBAR_DEFAULT);
  });

  it('상한 계산에 쓰는 상수가 기대한 값이다', () => {
    expect(SIDEBAR_MIN).toBe(252); // U134 이전 최소 폭 = 내부 구성요소가 접히도록 설계된 폭
    expect(SIDEBAR_DEFAULT).toBe(300);
    expect(SIDEBAR_MAX_ABS).toBe(480);
    expect(SIDEBAR_MAX_RATIO).toBe(0.4);
  });
});

describe('좌표 → 폭 (계산식 하나)', () => {
  it('잡은 폭에 이동량만 더한다 — 잡는 순간 튀지 않는다', () => {
    // 움직이지 않았으면 잡은 폭 그대로. 손잡이 띠 어디를 잡았든 무관하다.
    expect(widthFromDrag(300, 500, 500, WIDE)).toBe(300);
    expect(widthFromDrag(300, 500, 512, WIDE)).toBe(312);
    expect(widthFromDrag(300, 500, 488, WIDE)).toBe(288);
  });

  it('이동량이 같으면 시작 좌표가 달라도 결과가 같다', () => {
    expect(widthFromDrag(300, 100, 140, WIDE)).toBe(widthFromDrag(300, 900, 940, WIDE));
  });

  it('드래그 결과도 같은 clamp를 통과한다', () => {
    expect(widthFromDrag(300, 500, 100, WIDE)).toBe(SIDEBAR_MIN);
    expect(widthFromDrag(300, 500, 5000, WIDE)).toBe(SIDEBAR_MAX_ABS);
    expect(widthFromDrag(300, 500, 5000, 1000)).toBe(400);
  });
});

describe('키보드 한 칸', () => {
  it('←→는 8px, Shift를 누르면 32px', () => {
    expect(widthFromKey(300, 'ArrowRight', false, WIDE)).toBe(300 + SIDEBAR_STEP);
    expect(widthFromKey(300, 'ArrowLeft', false, WIDE)).toBe(300 - SIDEBAR_STEP);
    expect(widthFromKey(300, 'ArrowRight', true, WIDE)).toBe(300 + SIDEBAR_STEP_BIG);
    expect(widthFromKey(300, 'ArrowLeft', true, WIDE)).toBe(300 - SIDEBAR_STEP_BIG);
  });

  it('Home/End는 최소·최대로 간다', () => {
    expect(widthFromKey(300, 'Home', false, WIDE)).toBe(SIDEBAR_MIN);
    expect(widthFromKey(300, 'End', false, WIDE)).toBe(SIDEBAR_MAX_ABS);
    expect(widthFromKey(300, 'End', false, 1000)).toBe(400);
  });

  it('경계에서 더 밀어도 넘어가지 않는다', () => {
    expect(widthFromKey(SIDEBAR_MIN, 'ArrowLeft', true, WIDE)).toBe(SIDEBAR_MIN);
    expect(widthFromKey(SIDEBAR_MAX_ABS, 'ArrowRight', true, WIDE)).toBe(SIDEBAR_MAX_ABS);
  });

  it('처리하지 않는 키는 null — 호출부가 전역 단축키를 삼키지 않는다', () => {
    expect(widthFromKey(300, 'ArrowUp', false, WIDE)).toBeNull();
    expect(widthFromKey(300, ' ', false, WIDE)).toBeNull();
    expect(widthFromKey(300, 'Enter', false, WIDE)).toBeNull();
    expect(widthFromKey(300, 'a', false, WIDE)).toBeNull();
  });
});

describe('저장 (이 창의 보기 설정)', () => {
  const store = new Map<string, string>();
  let throwOnAccess = false;

  beforeEach(() => {
    store.clear();
    throwOnAccess = false;
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => {
        if (throwOnAccess) throw new Error('blocked');
        return store.has(k) ? store.get(k)! : null;
      },
      setItem: (k: string, v: string) => {
        if (throwOnAccess) throw new Error('blocked');
        store.set(k, v);
      },
      removeItem: (k: string) => {
        if (throwOnAccess) throw new Error('blocked');
        store.delete(k);
      },
    };
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it('원장·상태가 아니라 기존 호환 UI 칸 하나만 쓴다', () => {
    expect(SIDEBAR_LS_KEY).toBe('nsdh.console.ui.sidebarWidth');
    // 상태(AppState)·persist·방송에 태우지 않는다 — 화면 폭은 행사 데이터가 아니다.
    expect(source).not.toContain('dispatch');
    expect(source).not.toContain("type: 'settings/");
  });

  it('쓰고 읽으면 같은 값이 돌아온다 (정수로 저장)', () => {
    writeSidebarWidth(318.4);
    expect(store.get(SIDEBAR_LS_KEY)).toBe('318');
    expect(readSidebarWidth()).toBe(318);
  });

  it('저장값이 없으면 null — 기본값이 아니다', () => {
    // null이어야 호출부가 `--sidebar-w`를 세우지 않고 CSS `minmax()` 반응형이 그대로 산다.
    expect(readSidebarWidth()).toBeNull();
  });

  it('망가진 값은 없는 것으로 친다', () => {
    store.set(SIDEBAR_LS_KEY, 'abc');
    expect(readSidebarWidth()).toBeNull();
    store.set(SIDEBAR_LS_KEY, '0');
    expect(readSidebarWidth()).toBeNull();
    store.set(SIDEBAR_LS_KEY, '-40');
    expect(readSidebarWidth()).toBeNull();
  });

  it('더블클릭 초기화는 칸을 지운다 (다시 CSS 기본 범위)', () => {
    writeSidebarWidth(400);
    clearSidebarWidth();
    expect(store.has(SIDEBAR_LS_KEY)).toBe(false);
    expect(readSidebarWidth()).toBeNull();
  });

  it('localStorage가 던져도 조작 패널이 죽지 않는다', () => {
    throwOnAccess = true;
    expect(readSidebarWidth()).toBeNull();
    expect(() => writeSidebarWidth(300)).not.toThrow();
    expect(() => clearSidebarWidth()).not.toThrow();
  });
});

describe('배선', () => {
  it('renderHold 소유자에 sidebar-resize가 있다', () => {
    expect(holdSource).toMatch(/RenderHoldOwner\s*=\s*'volume'\s*\|\s*'music-scrub'\s*\|\s*'sidebar-resize'/);
    expect(source).toContain("ctx.holdRender('sidebar-resize', true)");
    expect(source).toContain("ctx.holdRender('sidebar-resize', false)");
  });

  it('포인터 캡처와 rAF 스로틀을 쓴다', () => {
    expect(source).toContain('setPointerCapture');
    expect(source).toContain('requestAnimationFrame');
    // 놓는 경로 셋 다 같은 정리 함수로 간다 — 하나라도 새면 hold가 영영 풀리지 않는다
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      expect(source).toContain(`resizer.addEventListener('${ev}', endDrag)`);
    }
  });

  it('접근성 속성과 tip을 단다', () => {
    expect(source).toContain("setAttribute('role', 'separator')");
    expect(source).toContain("'aria-orientation', 'vertical'");
    expect(source).toContain('aria-valuenow');
    expect(source).toContain('aria-valuemin');
    expect(source).toContain('aria-valuemax');
    expect(source).toContain('resizer.tabIndex = 0');
    expect(source).toMatch(/더블클릭 초기화/);
  });

  it('control.ts가 재렌더에서 살아남는 .main에 딱 한 번 설치한다', () => {
    expect(controlSource).toContain("import { installSidebarResizer } from './control/sidebar-resize'");
    expect(controlSource).toContain('installSidebarResizer(mainRoot, ctx)');
    // 매 렌더에 다시 부르면 구분선과 리스너가 중복으로 쌓인다 — 호출은 딱 하나여야 한다
    expect(controlSource.match(/installSidebarResizer\(/g)).toHaveLength(1);
    // `paintApp()`(매 렌더)보다 **앞**에 있어야 모듈 초기화 때 한 번만 돈다
    expect(controlSource).not.toMatch(/function paintApp\(\)[\s\S]*installSidebarResizer\(/);
  });
});

describe('CSS', () => {
  it('.main이 3열이고 가운데가 옛 gap 자리(12px)다', () => {
    const main = css.match(/\.main\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(main).toMatch(
      /grid-template-columns:\s*var\(--sidebar-w,\s*minmax\(277px,\s*330px\)\)\s+12px\s+minmax\(0,\s*1fr\);/,
    );
    // 트랙을 더하면서 `gap`(축약)을 남기면 열 간격이 12 → 24px로 벌어진다.
    // 선언부만 본다 — 주석에 `gap`이라는 낱말이 들어 있어 블록 전체를 훑으면 헛걸린다.
    const decls = main.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(decls).toMatch(/column-gap:\s*0;/);
    expect(decls).toMatch(/row-gap:\s*var\(--sp-3\);/);
    expect(decls).not.toMatch(/(?:^|[\s;])gap:\s/);
  });

  it('구분선은 12px 히트 영역에 1px 선, hover·focus에서만 또렷해진다', () => {
    const resizer = css.match(/\.col-resizer\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(resizer).toMatch(/cursor:\s*col-resize/);
    expect(resizer).toMatch(/touch-action:\s*none/); // 없으면 터치·펜에서 스크롤로 먹힌다
    expect(css).toMatch(/\.col-resizer::before\s*\{[^}]*width:\s*1px/s);
    expect(css).toMatch(/\.col-resizer:focus-visible\s*\{[^}]*outline:/s);
    expect(resizer).not.toMatch(/letter-spacing:/);
  });

  it('드래그 중에는 iframe·video가 포인터를 삼키지 않는다', () => {
    // PGM 모니터(iframe)가 이벤트를 먹으면 그 위를 지나는 순간 드래그가 끊긴다
    expect(css).toMatch(/body\.is-resizing\s*\{[^}]*cursor:\s*col-resize/s);
    expect(css).toMatch(/body\.is-resizing\s*\{[^}]*user-select:\s*none/s);
    expect(css).toMatch(/body\.is-resizing\s+iframe[\s\S]{0,80}pointer-events:\s*none/);
  });
});
