/**
 * U41 — 보드 씬(순위·출전 명단·시상)의 엣지 호흡 글로우.
 *
 * 여기서 지키는 계약:
 *  1) 애니메이션 대상은 `opacity`·`transform`뿐이다 — `box-shadow`/`filter`를 애니메이션하면
 *     매 프레임 페인트가 다시 돌아 순위 재정렬 트윈·카운트업과 프레임 예산을 다툰다.
 *  2) 참조하는 keyframe이 실제로 정의돼 있다 (이름만 있고 정의가 없으면 조용히 아무 일도 안 난다).
 *  3) 진입 keyframe에 `to` 블록을 쓰지 않는다 (both fill이 상태 클래스를 덮은 sb-rise 실사고).
 *  4) `prefers-reduced-motion`이면 이 설정과 무관하게 멈춘다.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';

import { CSS as css, declOf, parseRules, stripComments } from './luxe-css.testkit';
import { createInitialState, migrate } from '../state';

const displaySource = readFileSync(new URL('../display.ts', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('../control/tab-settings.ts', import.meta.url), 'utf8');

/** `animation`/`animation-name` 축약형에서 참조된 keyframe 이름 */
function referencedKeyframes(source: string): string[] {
  const defined = new Set(
    [...stripComments(source).matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]),
  );
  const names = new Set<string>();
  for (const rule of parseRules(source)) {
    for (const m of rule.body.matchAll(/animation(?:-name)?\s*:\s*([^;]+)/g)) {
      for (const token of m[1].split(/[\s,]+/)) if (defined.has(token)) names.add(token);
    }
  }
  return [...names];
}

const GLOW_KEYFRAMES = ['luxe-breathe', 'luxe-breathe-soft'];

describe('엣지 호흡 글로우 (U41)', () => {
  it('참조한 글로우 keyframe이 실제로 정의돼 있다', () => {
    const referenced = referencedKeyframes(css);
    for (const name of GLOW_KEYFRAMES) {
      expect(referenced).toContain(name);
      expect(css).toMatch(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
    }
  });

  it('애니메이션하는 속성이 opacity·transform뿐이다', () => {
    const clean = stripComments(css);
    for (const name of GLOW_KEYFRAMES) {
      const start = clean.indexOf(`@keyframes ${name}`);
      expect(start).toBeGreaterThan(-1);
      const open = clean.indexOf('{', start);
      // 중첩 블록(0%/50%/100%)을 세며 keyframe 본문의 끝을 찾는다
      let depth = 0;
      let end = open;
      for (let i = open; i < clean.length; i += 1) {
        if (clean[i] === '{') depth += 1;
        else if (clean[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const body = clean.slice(open, end);
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      // D7: `transform: scale`을 뺐다 — 레이어 크기가 매 프레임 바뀌면 래스터를 다시 뜬다.
      expect([...new Set(props)].sort()).toEqual(['opacity']);
    }
  });

  it('진입 keyframe과 달리 `to` 블록을 쓰지 않는다', () => {
    const clean = stripComments(css);
    for (const name of GLOW_KEYFRAMES) {
      const start = clean.indexOf(`@keyframes ${name}`);
      const body = clean.slice(start, clean.indexOf('\n}', start));
      expect(body).not.toMatch(/(^|\s)to\s*\{/);
      expect(body).not.toMatch(/(^|\s)from\s*\{/);
    }
  });

  it('그림자는 pseudo-element에 한 번만 심고 애니메이션하지 않는다', () => {
    // reduced-motion 블록이 같은 셀렉터에 정지값을 다시 심으므로 기본 규칙만 떼어 본다
    const base = css.slice(0, css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    for (const sel of ['.luxe-board::after', '.rs__panel::after']) {
      expect(declOf(base, sel, 'box-shadow')).toBeTruthy();
      expect(declOf(base, sel, 'opacity')).toBe('0');
      expect(declOf(base, sel, 'pointer-events')).toBe('none');
    }
    // 글로우 셀렉터(::after 계열) 중 그림자를 애니메이션/트랜지션하는 규칙이 하나도 없어야 한다.
    // (`.timer-badge`의 위험 색 전환은 글로우와 무관한 기존 규칙이라 범위 밖이다.)
    const glowRules = parseRules(css).filter((rule) =>
      rule.selectors.some((sel) => /::after/.test(sel) && /luxe|rs__panel|sb__/.test(sel)),
    );
    expect(glowRules.length).toBeGreaterThan(0);
    const animatesShadow = glowRules.filter((rule) =>
      /(?:animation|transition)[^;]*box-shadow/.test(rule.body),
    );
    expect(animatesShadow.map((r) => r.selectors.join(','))).toEqual([]);
  });

  it('보드 진입 모션이 끝난 뒤에 시작한다 (지연 1초 이상)', () => {
    const board = declOf(css, '.is-luxe-glow .luxe-board::after', 'animation') ?? '';
    expect(board).toMatch(/luxe-breathe/);
    expect(Number.parseFloat(board.match(/(\d+(?:\.\d+)?)s\s+infinite/)?.[1] ?? '0')).toBeGreaterThanOrEqual(1);
    // 호흡 주기는 4~6초
    const period = Number.parseFloat(board.match(/luxe-breathe\s+(\d+(?:\.\d+)?)s/)?.[1] ?? '0');
    expect(period).toBeGreaterThanOrEqual(4);
    expect(period).toBeLessThanOrEqual(6);
  });

  /**
   * U79 회귀 핀 — 아바타 링 글로우를 되살리지 않는다.
   *
   * 의도는 아바타(86px) 안쪽에 갇힌 2px 팀 색 링이었지만 `.luxe-avatar`/`.sb__avatar`에
   * `position: relative`가 없어서, `position: absolute; inset: 0`이 행 본체(absolute)를
   * 기준으로 잡혔다. 결과는 행 전폭 상자에 `border-radius: 50%`가 걸린 **거대한 타원**이
   * 아바타를 관통해 오른쪽으로 휘어 나가는 그림이었다.
   *
   * 되살리려면 `position: relative`가 **먼저** 필요하다. 이 테스트는 그 순서를 강제한다.
   */
  it('아바타 링 글로우는 없다 — 행 전폭 타원으로 새던 레이어 (U79)', () => {
    expect(css).not.toContain('.luxe-avatar::after');
    expect(css).not.toContain('.sb__avatar::after');
  });

  it('스팅어가 덮은 동안에는 멈춘다', () => {
    expect(declOf(css, '.is-tx .luxe-board::after', 'animation-play-state')).toBe('paused');
    // U75 — 스팅어 표시는 시각 경로라 동결 스냅샷을 읽는다
    expect(displaySource).toContain("classList.toggle('is-tx', vis.sceneOpts.transitionVideo.active)");
  });

  it('모션 최소화면 설정과 무관하게 멈춘다', () => {
    const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.luxe-board::after');
    expect(reduced).toContain('.rs__panel::after');
    expect(reduced).toMatch(/animation:\s*none/);
  });
});

describe('호흡 글로우 설정 (U41)', () => {
  it('기본은 켬이고 저장본에 없으면 켬으로 올라온다', () => {
    expect(createInitialState().settings.luxeGlow).toBe(true);
    // U41 이전 저장본 — 키 자체가 없다
    const base = createInitialState();
    const settings = { ...base.settings } as unknown as Record<string, unknown>;
    delete settings.luxeGlow;
    expect(migrate({ ...base, settings } as unknown as typeof base).settings.luxeGlow).toBe(true);
  });

  it('false로 저장된 값은 그대로 꺼진 채 올라온다', () => {
    const base = createInitialState();
    const off = migrate({ ...base, settings: { ...base.settings, luxeGlow: false } });
    expect(off.settings.luxeGlow).toBe(false);
  });

  it('설정 탭 토글이 상태에만 쓰고 CSS 스위치는 display가 심는다', () => {
    expect(settingsSource).toContain("patch: { luxeGlow: !s.settings.luxeGlow }");
    expect(displaySource).toContain("classList.toggle('is-luxe-glow', vis.settings.luxeGlow)");
    // 마크업은 늘리지 않는다 — renderInto 캐시 키가 바뀌면 모든 씬이 매 프레임 교체된다
    for (const scene of ['score', 'roster', 'award']) {
      const src = readFileSync(new URL(`./${scene}.ts`, import.meta.url), 'utf8');
      expect(src).not.toContain('luxe-glow');
    }
  });
});

/**
 * D7 — 격리 실측에서 score 정착 rAF p95가 17 → 33ms였다. 애니메이션 자체는 `opacity`만
 * 움직여도 **큰 그림자 레이어를 여러 장** 띄우면 합성·재래스터 비용이 그대로 든다.
 * 여기서 고정하는 것은 "비용을 만드는 구조"다 — 수치는 격리 브라우저가 따로 잰다.
 */
describe('글로우 비용 (D7)', () => {
  const glowRules = () =>
    parseRules(css).filter(
      (rule) =>
        /animation(-name)?\s*:\s*luxe-breathe/.test(rule.body) &&
        rule.selectors.some((sel) => sel.includes('.is-luxe-glow')),
    );

  it('행 캡슐 전폭 그림자를 지웠다 — 비용의 대부분이었다', () => {
    expect(css).not.toContain('.luxe-capsule::after');
    expect(css).not.toContain('.sb__row-body::after');
  });

  // U79에서 아바타 링 레이어가 빠져 보드 외곽 + 명단 패널 둘만 남았다.
  it('움직이는 레이어는 보드 외곽·명단 패널뿐이다', () => {
    const targets = glowRules().flatMap((rule) => rule.selectors);
    // 셀렉터 그룹 수 상한 — 늘리려면 실측을 다시 해야 한다
    expect(targets.length).toBeLessThanOrEqual(6);
    for (const sel of targets) {
      expect(sel).toMatch(/luxe-board|sb__board|rs__panel/);
    }
  });

  it('중계 스코어바 아바타는 대상이 아니다 — 카메라 화면에 비용을 얹지 않는다', () => {
    for (const rule of glowRules()) {
      for (const sel of rule.selectors) {
        if (!/avatar/.test(sel)) continue;
        // 보드 씬 컨테이너로 범위가 묶여 있어야 한다
        expect(sel).toMatch(/\.luxe-rows|\.sb__rows/);
      }
    }
    expect(css).not.toMatch(/\.is-luxe-glow\s+\.scorebar__avatar/);
  });

  it('레이어를 미리 승격하고 재래스터 범위를 가둔다', () => {
    const base = css.slice(0, css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    expect(declOf(base, '.luxe-board::after', 'will-change')).toBe('opacity');
    expect(declOf(base, '.luxe-board::after', 'contain')).toBe('paint');
    // 모션 최소화면 승격까지 되돌린다 — 안 그러면 안 도는 레이어가 메모리만 잡는다
    const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/will-change:\s*auto/);
  });

  it('순위 재정렬 트윈이 도는 동안 멈춘다', () => {
    expect(declOf(css, '.is-reordering .luxe-board::after', 'animation-play-state')).toBe('paused');
    expect(displaySource).toContain("classList.toggle('is-reordering', now < reorderUntil)");
    // 창 길이는 CSS transition과 같은 값이어야 한다
    expect(displaySource).toContain('const REORDER_TWEEN_MS = 400;');
    expect(declOf(css, '.sb__row', 'transition')).toContain('0.4s');
  });

  it('첫 렌더는 재정렬로 세지 않는다 — 진입은 animation-delay가 담당한다', () => {
    expect(displaySource).toContain("if (reorderSig !== '') reorderUntil = now + REORDER_TWEEN_MS;");
  });
});
