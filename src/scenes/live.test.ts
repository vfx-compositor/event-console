import { describe, expect, it } from 'vitest';
// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';

import { createInitialState, reducer } from '../state';
import { toHTML, toText } from '../vdom';
import { tick, view } from './live';
import {
  CSS as css,
  TOKENS as tokens,
  declOf,
  parseRules,
  positiveLetterSpacings,
  section,
} from './luxe-css.testkit';
import type { AppState, TeamId } from '../types';

/** S3 라이브캠 크롬 — 보더·아이콘 바·종목 배지·타이머·스코어바가 모두 이 안에 있다. */
const chrome = section('S3 라이브캠', '게임 오프닝');

/** padding 축약형에서 좌+우 합. 가림 폭을 계산하려면 이 값이 필요하다. */
function paddingX(selector: string): number {
  const raw = declOf(chrome, selector, 'padding');
  if (!raw) return 0;
  const p = raw.trim().split(/\s+/).map((v) => Number.parseInt(v, 10) || 0);
  if (p.length === 1) return p[0] * 2;
  if (p.length < 4) return p[1] * 2;
  return p[1] + p[3];
}

/** border 축약형의 좌+우 두께. border-box라 이만큼 요소가 넓어진다. */
function borderX(selector: string): number {
  const raw = declOf(chrome, selector, 'border');
  return raw ? (Number.parseInt(raw, 10) || 0) * 2 : 0;
}

function withVersus(versus: [TeamId, TeamId] | null, teamCount = 4): AppState {
  return reducer(
    { ...createInitialState(), teamCount },
    { type: 'sceneOpts/patch', patch: { liveOverlay: { versus } } },
  );
}

describe('중계 화면 대결 팀 아이콘 (U21)', () => {
  it('versus가 없으면 아이콘 마크업 자체를 만들지 않는다', () => {
    const html = toHTML(view(createInitialState()));

    expect(html).toContain('class="vs-borders vs-borders--neutral"');
    expect(html).not.toContain('vs-teams');
  });

  it('확정 4팀은 오피셜 팀 배지를 좌·우에 띄운다 (U31)', () => {
    const state = withVersus(['t1', 't2']);
    const html = toHTML(view(state));

    expect(html).toContain('class="vs-teams"');
    expect(html).toContain(
      `<div class="vs-teams__side vs-teams__side--l" data-team="t1" style="--team-color:${state.teams[0].color}">`,
    );
    expect(html).toContain(
      `<div class="vs-teams__side vs-teams__side--r" data-team="t2" style="--team-color:${state.teams[1].color}">`,
    );
    expect(html).toContain(
      '<img class="vs-teams__logo team-badge" src="./media/team_logo_yellow.svg" alt="">',
    );
    expect(html).toContain(
      '<img class="vs-teams__logo team-badge" src="./media/team_logo_blue.svg" alt="">',
    );
    expect(html).not.toContain('vs-teams__badge');
    expect(toText(view(state))).toContain('VS');
  });

  it('오피셜 배지가 없는 슬롯은 팀 색 배지와 이니셜로 남는다', () => {
    const state = withVersus(['t5', 't6'], 6);
    const html = toHTML(view(state));

    expect(html).toContain(`<span class="vs-teams__badge">${state.teams[4].name[0]}</span>`);
    expect(html).toContain(`<span class="vs-teams__badge">${state.teams[5].name[0]}</span>`);
    expect(state.teams[4].name[0]).not.toBe(state.teams[5].name[0]);
    expect(html).not.toContain('vs-teams__logo');
  });

  it('배지는 자기 rim이 있으므로 아이콘 링을 hairline으로 낮춘다', () => {
    // 기본 링 두께는 바 크기에 따라 바뀐다 — 중요한 건 배지 쪽이 더 얇다는 관계다
    expect(borderX('.vs-teams__logo') / 2).toBeGreaterThan(2);
    expect(declOf(chrome, '.vs-teams__logo.team-badge', 'border-width')).toBe('2px');
    expect(declOf(chrome, '.vs-teams__logo.team-badge', 'background')).toBe('transparent');
  });

  it('아이콘 좌·우 순서가 컬러 보더와 항상 같다 (좌우 바꾸기 포함)', () => {
    const state = withVersus(['t2', 't1']);
    const html = toHTML(view(state));

    const border = html.indexOf(`class="vs-borders__l" style="--team-color:${state.teams[1].color}"`);
    const icon = html.indexOf('class="vs-teams__side vs-teams__side--l" data-team="t2"');
    expect(border).toBeGreaterThan(-1);
    expect(icon).toBeGreaterThan(-1);
    expect(html).toContain('class="vs-teams__side vs-teams__side--r" data-team="t1"');
  });

  it('아이콘 바는 좌상 종목 배지·우상 타이머와 같은 인셋에서 가운데로 비켜 앉는다', () => {
    const block = css.slice(css.indexOf('.vs-teams {'), css.indexOf('.vs-teams__side'));

    expect(block).toContain('top: var(--inset-badge)');
    expect(block).toContain('left: 50%');
    expect(block).toContain('transform: translateX(-50%)');
    // 카메라 화면을 클릭 흡수로도 가리지 않는다
    expect(block).toContain('pointer-events: none');
  });

  it('좌상 종목 배지는 폭을 제한해 가운데 아이콘 바와 겹치지 않는다', () => {
    const badge = css.slice(css.indexOf('.event-badge__name {'), css.indexOf('/* ── 우상 러닝 클록'));

    expect(badge).toContain('max-width: 420px');
    expect(badge).toContain('text-overflow: ellipsis');
    // 아이콘 바 최대 900px + 배지 420px × 2 ≤ 1920 세이프존
    expect(css.slice(css.indexOf('.vs-teams {'), css.indexOf('.vs-teams__side'))).toContain(
      'max-width: 900px',
    );
  });

  it('팀명에 양수 자간을 쓰지 않는다', () => {
    const block = css.slice(css.indexOf('.vs-teams__name {'), css.indexOf('.vs-teams__vs {'));

    expect(block).toContain('letter-spacing: -0.02em');
  });
});

/**
 * U25 — 중계 크롬을 Broadcast Luxe로 맞춘다.
 * 카메라를 가리는 면적은 **현재 이하**가 절대 조건이라 위치·높이를 수치로 못 박는다.
 */
describe('중계 크롬 Luxe 정렬 (U25)', () => {
  it('카메라 가림 면적이 늘지 않는다', () => {
    // 하단 스코어바: 풀와이드 · 높이 토큰 그대로
    expect(declOf(chrome, '.scorebar', 'height')).toBe('var(--scorebar-h)');
    expect(declOf(chrome, '.scorebar', 'bottom')).toBe('0');
    // 좌상 배지·우상 타이머: 인셋과 높이 그대로
    expect(declOf(chrome, '.event-badge', 'top')).toBe('var(--inset-badge)');
    expect(declOf(chrome, '.event-badge', 'left')).toBe('var(--inset-badge)');
    expect(declOf(chrome, '.event-badge', 'height')).toBe('56px');
    expect(declOf(chrome, '.timer-badge', 'top')).toBe('var(--inset-badge)');
    expect(declOf(chrome, '.timer-badge', 'right')).toBe('var(--inset-badge)');
    expect(declOf(chrome, '.timer-badge', 'min-width')).toBe('230px');
    // 아이콘 바만 키울 수 있다 — U32에서 상한을 68 → 120px로 올렸다.
    // 가림이 느는 것은 **상단 바 하나뿐**이고 스코어바·배지·타이머 예산은 위에서 그대로 못 박는다.
    const barH = Number.parseInt(declOf(chrome, '.vs-teams', 'height') ?? '0', 10);
    expect(barH).toBeGreaterThan(56);
    expect(barH).toBeLessThanOrEqual(120);
    expect(declOf(chrome, '.vs-teams', 'max-width')).toBe('900px');
  });

  /**
   * 높이·인셋만 고정하면 padding·border 증가로 가로가 넓어지는 것을 못 잡는다.
   * (U25에서 타이머 padding 26→30 + 테두리 1px로 폭이 10px 늘었던 적이 있다.)
   * border-box라 요소 폭 = 콘텐츠 + padding + border이므로 그 합을 예산으로 못 박는다.
   */
  it('가로 차지폭도 U25 이전 예산을 넘지 않는다', () => {
    // 타이머: 이전 좌우 padding 26px 두 겹 = 52
    expect(paddingX('.timer-badge') + borderX('.timer-badge')).toBeLessThanOrEqual(52);
    // 종목 배지: 이전 LIVE 30 + 종목명 48 + 구분선 1 = 79
    const badgeX =
      paddingX('.event-badge__live') + paddingX('.event-badge__name') + borderX('.event-badge');
    expect(badgeX).toBeLessThanOrEqual(79);
    // 아이콘 바: 이전 좌우 padding 20px 두 겹 = 40
    expect(paddingX('.vs-teams') + borderX('.vs-teams')).toBeLessThanOrEqual(40);
    // 종목명 최대폭은 그대로라 중앙 아이콘 바와 겹치지 않는다
    expect(declOf(chrome, '.event-badge__name', 'max-width')).toBe('420px');
  });

  it('종목명 행높이가 캡슐 테두리를 반영한 내부 높이에 맞는다', () => {
    // 배지 56px − 테두리 1px 두 겹 = 54px. 56이면 한 줄이 아래로 밀린다.
    expect(declOf(chrome, '.event-badge__name', 'line-height')).toBe('54px');
    // padding 중복 선언이 남아 있으면 축약형이 조용히 덮인다
    const live = parseRules(chrome).filter((r) => r.selectors.includes('.event-badge__live'));
    expect(live).toHaveLength(1);
    expect([...live[0].body.matchAll(/(?:^|;)\s*padding(-left)?\s*:/g)]).toHaveLength(1);
  });

  it('네 크롬 조각이 같은 luxe 패널 면을 쓴다', () => {
    for (const sel of ['.scorebar', '.event-badge', '.timer-badge', '.vs-teams']) {
      expect(declOf(chrome, sel, 'background')).toBe('var(--luxe-panel)');
    }
    for (const sel of ['.event-badge', '.timer-badge', '.vs-teams']) {
      expect(declOf(chrome, sel, 'border')).toBe('1px solid var(--luxe-panel-line)');
      expect(declOf(chrome, sel, 'border-radius')).toBe('999px');
    }
  });

  it('타이머 숫자의 굵기·급수·대비를 유지한다', () => {
    expect(declOf(chrome, '.timer-badge__time', 'font-size')).toBe('72px');
    expect(declOf(chrome, '.timer-badge__time', 'font-weight')).toBe('700');
    expect(declOf(chrome, '.timer-badge__time', 'color')).toBe('var(--fg)');
    // 임계치는 점멸이 아니라 색 전환으로만 알린다
    expect(declOf(chrome, '.timer-badge.is-danger', 'box-shadow')).toContain('var(--danger)');
    expect(declOf(chrome, '.timer-badge.is-danger', 'animation')).toBeNull();
  });

  it('스코어바 팀 식별을 좌측 컬러 바에서 아바타 링으로 옮긴다', () => {
    const html = toHTML(view(createInitialState()));
    expect(html).toContain('scorebar__avatar luxe-avatar');
    expect(html).not.toContain('scorebar__bar');
    expect(html).not.toContain('scorebar__logo');
    // 카운트업·획득 슬롯 배선은 그대로다 (display.ts가 이 셀렉터로 찾는다)
    expect(html).toContain('class="scorebar__score" data-bind="total"');
    expect(html).toContain('class="scorebar__gain" data-bind="gain"');
  });

  it('팀 색은 링과 좌·우 컬러 보더에만 쓰고 다른 면을 채우지 않는다', () => {
    // 화면 가장자리 컬러 보더(.vs-borders)는 §3.2가 허용하는 "팀 컬러 바"라 예외다
    const filled = parseRules(chrome)
      .filter((r) => /background:\s*var\(--team(-color)?\)/.test(r.body))
      .flatMap((r) => r.selectors)
      .filter((sel) => !sel.startsWith('.vs-borders'));
    expect(filled).toEqual([]);
    expect(declOf(chrome, '.vs-teams__logo', 'border')).toContain(
      'color-mix(in srgb, var(--team-color)',
    );
  });

  it('VS 표식은 리더보드 순위 pill과 같은 보라 캡슐을 쓴다', () => {
    expect(declOf(chrome, '.vs-teams__vs', 'background')).toBe('var(--luxe-pill-grad)');
    expect(declOf(chrome, '.vs-teams__vs', 'border-radius')).toBe('999px');
  });

  it('2부 진입 글리치 레이어는 이 블록 밖에 그대로 둔다', () => {
    expect(chrome).not.toContain('fx__glitch');
    expect(chrome).not.toContain('mood-transition');
    expect(css).toContain('.fx__glitch');
    expect(css).toContain('#mood-transition');
  });

  it('중계 크롬에는 양수 자간이 하나도 없다', () => {
    expect(positiveLetterSpacings(chrome)).toEqual([]);
  });
});

describe('스코어바 오피셜 팀 로고 (U31)', () => {
  it('스코어바 아바타도 같은 해석기를 쓰므로 배지가 함께 들어온다', () => {
    const html = toHTML(view(createInitialState()));
    for (const color of ['yellow', 'blue', 'red', 'green']) {
      expect(html).toContain(`<img class="luxe-logo team-badge" src="./media/team_logo_${color}.svg" alt="">`);
    }
    expect(html).not.toContain('luxe-logo-fallback');
  });

  it('배지가 붙은 공용 아바타만 링을 hairline으로 낮춘다', () => {
    expect(declOf(css, '.luxe-avatar', 'border')).toContain('6px');
    expect(declOf(css, '.luxe-avatar:has(.team-badge)', 'border-width')).toBe('2px');
    expect(declOf(css, '.luxe-avatar:has(.team-badge)', 'background')).toBe('transparent');
  });
});

/**
 * U32 — "중계에서 VS 더 크게". 카메라 인물이 서는 중앙·하단은 그대로 두고
 * 상단 가운데 바 하나만 키운다. 가로 발자국(중앙 세이프존 510~1410px)은 건드리지 않는다.
 */
describe('중계 VS 바 확대 (U32)', () => {
  const px = (sel: string, prop: string): number =>
    Number.parseInt(declOf(chrome, sel, prop) ?? '0', 10);

  it('바 높이를 110~120px로 키운다', () => {
    const h = px('.vs-teams', 'height');
    expect(h).toBeGreaterThanOrEqual(110);
    expect(h).toBeLessThanOrEqual(120);
  });

  it('팀 로고·이니셜 배지가 84px 이상이다', () => {
    for (const sel of ['.vs-teams__logo', '.vs-teams__badge']) {
      expect(px(sel, 'width')).toBeGreaterThanOrEqual(84);
      expect(px(sel, 'height')).toBeGreaterThanOrEqual(84);
    }
    // U31 오피셜 배지 규칙은 커진 뒤에도 그대로 살아 있다
    expect(declOf(chrome, '.vs-teams__logo.team-badge', 'border-width')).toBe('2px');
  });

  it('팀명이 36px 이상 굵게 나온다', () => {
    expect(px('.vs-teams__name', 'font-size')).toBeGreaterThanOrEqual(36);
    expect(declOf(chrome, '.vs-teams__name', 'font-weight')).toBe('800');
    // 굵고 큰 글자라 자간은 계속 음수 (전역 UI 규칙)
    expect(declOf(chrome, '.vs-teams__name', 'letter-spacing')).toBe('-0.02em');
  });

  it('VS 캡슐이 리더보드 순위 pill과 같은 급이다', () => {
    expect(px('.vs-teams__vs', 'height')).toBeGreaterThanOrEqual(64);
    expect(declOf(chrome, '.vs-teams__vs', 'background')).toBe('var(--luxe-pill-grad)');
    expect(declOf(chrome, '.vs-teams__vs', 'box-shadow')).toBe('var(--luxe-pill-shadow)');
    expect(px('.vs-teams__vs', 'font-size')).toBeGreaterThanOrEqual(28);
    // 순위 pill과 같은 값을 쓰는지 — 리더보드 쪽 정본과 대조
    expect(declOf(css, '.sb__rank', 'background')).toBe('var(--luxe-pill-grad)');
  });

  it('키운 내용이 중앙 세이프존 900px 안에 그대로 들어간다', () => {
    const bar = paddingX('.vs-teams') + borderX('.vs-teams');
    const gaps = px('.vs-teams', 'gap') * 2; // 좌 · VS · 우 사이 두 칸
    const side =
      px('.vs-teams__logo', 'width') +
      borderX('.vs-teams__logo') +
      px('.vs-teams__side', 'gap') +
      px('.vs-teams__name', 'max-width');
    const vsPill = paddingX('.vs-teams__vs') + 60; // 'VS' 두 글자 여유
    expect(bar + gaps + side * 2 + vsPill).toBeLessThanOrEqual(900);
  });

  it('세로로만 커지고 가로 발자국·인셋은 U25 예산 그대로다', () => {
    expect(declOf(chrome, '.vs-teams', 'top')).toBe('var(--inset-badge)');
    expect(declOf(chrome, '.vs-teams', 'max-width')).toBe('900px');
    expect(paddingX('.vs-teams') + borderX('.vs-teams')).toBeLessThanOrEqual(40);
    // 카메라 클릭도 흡수하지 않는다
    expect(declOf(chrome, '.vs-teams', 'pointer-events')).toBe('none');
  });
});

/**
 * U37 — "중계할 때 로고가 너무 작다". 카메라 가림 면적(스코어바 높이 120px·풀와이드)은
 * 그대로 두고 **그 안에서** 아바타를 최대치까지 키운다. 상단 VS 바 로고와 같은 급으로 맞춰
 * 두 크롬이 따로 놀지 않게 한다.
 */
describe('중계 로고 확대 (U37)', () => {
  const px = (sel: string, prop: string): number =>
    Number.parseInt(declOf(chrome, sel, prop) ?? '0', 10);

  const SCOREBAR_H = 120;

  it('스코어바 아바타가 96px 이상이고 바 높이 안에 여백 12px로 앉는다', () => {
    const size = px('.scorebar .scorebar__avatar', 'width');
    expect(size).toBe(px('.scorebar .scorebar__avatar', 'height'));
    expect(size).toBeGreaterThanOrEqual(96);
    // 바를 넘지 않는다 — 위아래 최소 12px씩 남는다(가림 면적은 바 높이가 정한다)
    expect(size).toBeLessThanOrEqual(SCOREBAR_H - 24);
  });

  /**
   * U79 — 로고 px를 씬마다 따로 적던 것을 끊었다.
   *
   * 예전에는 아바타 96px에 로고 72px이라 링 안쪽(배지일 때 지름 92px)에 20px 여백이 남아
   * 512px 원형 엠블럼이 가운데 점처럼 보였다("왜 이렇게 작게 표시하는거야"). 이제 공용
   * `.luxe-logo`가 아바타 상자의 100%다 — `overflow: hidden`이 패딩 박스에서 자르므로
   * 정확히 테두리 안쪽 원을 채우고, 아바타 지름이 바뀌면(5·6팀 축소) 저절로 따라온다.
   * 여기서 고정하는 것은 "스코어바가 로고 크기를 따로 정하지 않는다"는 계약이다.
   */
  it('아바타 안 로고는 링 안쪽을 꽉 채운다 (U79)', () => {
    expect(declOf(chrome, '.scorebar .scorebar__avatar .luxe-logo', 'width')).toBeNull();
    expect(declOf(css, '.luxe-logo', 'width')).toBe('100%');
    expect(declOf(css, '.luxe-logo', 'height')).toBe('100%');
    expect(declOf(css, '.luxe-logo', 'object-fit')).toBe('contain');
  });

  it('팀명·점수도 비례해 커진다', () => {
    expect(px('.scorebar__name', 'font-size')).toBeGreaterThanOrEqual(31);
    expect(declOf(chrome, '.scorebar__name', 'letter-spacing')).toBe('-0.025em');
    expect(Number.parseInt(declOf(tokens, ':root', '--fs-score') ?? '0', 10)).toBeGreaterThanOrEqual(46);
  });

  it('4팀이 1920 안에 nowrap로 들어간다', () => {
    const slot = 1920 / 4;
    // 숫자 폭은 tabular 급수의 0.6em × 3자리로 잡는다 (총점 세 자리가 최대)
    const scoreW = Math.ceil(
      Number.parseInt(declOf(tokens, ':root', '--fs-score') ?? '0', 10) * 0.6 * 3,
    );
    const fixed =
      paddingX('.scorebar__team') +
      px('.scorebar .scorebar__avatar', 'width') +
      px('.scorebar__team', 'gap') * 2 +
      scoreW;
    // 팀명이 잘리지 않고 들어갈 자리가 남아야 한다 (기본 팀명 'YELLOW' 6자 × 0.62em)
    const nameW = Math.ceil(px('.scorebar__name', 'font-size') * 0.62 * 6);
    expect(fixed + nameW).toBeLessThanOrEqual(slot);
    expect(declOf(chrome, '.scorebar__name', 'white-space')).toBe('nowrap');
    expect(declOf(chrome, '.scorebar__name', 'text-overflow')).toBe('ellipsis');
  });

  it('5·6팀 축소 규격도 4팀에 비례해 커진다', () => {
    const four = px('.scorebar .scorebar__avatar', 'width');
    const sizes = [5, 6].map((teams) =>
      Number.parseInt(
        declOf(chrome, `.scorebar[data-teams='${teams}'] .scorebar__avatar`, 'width') ?? '0',
        10,
      ),
    );
    expect(sizes[0]).toBeGreaterThanOrEqual(76);
    expect(sizes[1]).toBeGreaterThanOrEqual(64);
    // 팀이 늘수록 작아지고, 4팀 규격을 넘지 않는다
    expect(sizes[0]).toBeLessThan(four);
    expect(sizes[1]).toBeLessThan(sizes[0]);
    // 슬롯이 좁아져도 팀명이 통째로 사라지지 않게 최소 폭을 남긴다
    for (const teams of [5, 6]) {
      expect(declOf(chrome, `.scorebar[data-teams='${teams}'] .scorebar__name`, 'min-width')).toBeTruthy();
    }
  });

  /**
   * 공용 `.luxe-avatar`(86px)가 이 파일 뒤쪽에 있어, 같은 특정도면 순서만으로 그쪽이 이긴다.
   * 실측에서 96이 아니라 86으로 잡혔던 사고 — 셀렉터에 `.scorebar`를 붙여 이긴다.
   */
  it('공용 아바타 규칙에 캐스케이드로 지지 않는다 (배지 변형 포함)', () => {
    const shared = Number.parseInt(declOf(css, '.luxe-avatar', 'width') ?? '0', 10);
    const scorebarRule = css.indexOf('.scorebar .scorebar__avatar {');
    const sharedRule = css.indexOf('.luxe-avatar,');
    expect(scorebarRule).toBeGreaterThan(-1);
    // 뒤에 있는 공용 규칙보다 특정도가 높아야 한다 (순서로는 지고 있다)
    expect(sharedRule).toBeGreaterThan(scorebarRule);
    expect(shared).toBeLessThan(px('.scorebar .scorebar__avatar', 'width'));
    // 오피셜 배지 변형도 상자는 96 유지, 링만 2px
    expect(px('.scorebar .scorebar__avatar:has(.team-badge)', 'width')).toBe(
      px('.scorebar .scorebar__avatar', 'width'),
    );
    expect(px('.scorebar .scorebar__avatar:has(.team-badge)', 'border-width')).toBe(2);
    for (const teams of [5, 6]) {
      expect(
        declOf(chrome, `.scorebar[data-teams='${teams}'] .scorebar__avatar:has(.team-badge)`, 'width'),
      ).toBe(declOf(chrome, `.scorebar[data-teams='${teams}'] .scorebar__avatar`, 'width'));
    }
  });

  it('상단 VS 바 로고와 스코어바 아바타가 같은 급이다', () => {
    expect(px('.vs-teams__logo', 'width')).toBe(px('.scorebar .scorebar__avatar', 'width'));
    expect(px('.vs-teams__badge', 'width')).toBe(px('.vs-teams__logo', 'width'));
  });

  it('카메라 가림 예산은 그대로다 — 바 높이·인셋·풀와이드 불변', () => {
    expect(declOf(chrome, '.scorebar', 'height')).toBe('var(--scorebar-h)');
    expect(Number.parseInt(declOf(tokens, ':root', '--scorebar-h') ?? '0', 10)).toBe(SCOREBAR_H);
    expect(declOf(chrome, '.scorebar', 'bottom')).toBe('0');
    expect(declOf(chrome, '.event-badge', 'height')).toBe('56px');
    expect(declOf(chrome, '.timer-badge', 'min-width')).toBe('230px');
    expect(px('.vs-teams', 'height')).toBeLessThanOrEqual(120);
  });
});

/**
 * Q5 — 슬로우 리플레이 배지. 되감은 그림이 라이브처럼 보이면 사고이므로
 * 재생 중에는 화면 안에 반드시 표식이 있어야 한다.
 * U108 — 사용자 지시("좌상단에 리플레이라고 써줘")로 우하단에서 좌상 종목 배지 아래로
 * 옮기고, 라벨 텍스트를 `REPLAY ×배속`에서 `리플레이` 한 단어로 바꿨다.
 */
describe('슬로우 리플레이 배지 (Q5 · 위치·라벨은 U108)', () => {
  const playing = (rate = 0.5): AppState =>
    reducer(
      reducer(reducer(createInitialState(), { type: 'settings/patch', patch: { replayRate: rate } }), {
        type: 'scene/set',
        scene: 'live',
      }),
      { type: 'live/replay', now: 1_700_000_000_000 },
    );

  it('재생 중이 아니면 마크업 자체를 만들지 않는다', () => {
    expect(toHTML(view(createInitialState()))).not.toContain('replay-badge');
  });

  it('재생 중에는 좌상단에 "리플레이" 한 단어만 뜬다 — 배속 숫자는 화면에 없다', () => {
    expect(toText(view(playing(0.5)))).toContain('리플레이');
    expect(toText(view(playing(0.25)))).toContain('리플레이');
    expect(toText(view(playing(1)))).toContain('리플레이');
    // 옛 `REPLAY ×n` 표기는 걷어냈다 — 화면에 남는 리플레이 표식은 이 라벨 하나뿐이다
    expect(toText(view(playing(0.5)))).not.toContain('REPLAY');
  });

  it('배속은 aria-label에 남아 스크린리더에서는 여전히 읽힌다', () => {
    const html = toHTML(view(playing(0.25)));
    expect(html).toContain('슬로우 리플레이 0.25배속');
  });

  it('배지·점·라벨 세 클래스가 모두 CSS 규칙을 가진다', () => {
    const html = toHTML(view(playing()));
    for (const cls of ['replay-badge', 'replay-badge__dot', 'replay-badge__label']) {
      expect(html).toContain(cls);
      expect(parseRules(chrome).some((r) => r.selectors.includes(`.${cls}`))).toBe(true);
    }
  });

  it('좌상 종목 배지 바로 아래에 앉는다 (U108) — 우상 타이머·상단 VS 바와 겹치지 않는다', () => {
    expect(declOf(chrome, '.replay-badge', 'left')).toBe('var(--inset-badge)');
    expect(declOf(chrome, '.replay-badge', 'top')).toBe('calc(var(--inset-badge) + 56px + 20px)');
    expect(declOf(chrome, '.replay-badge', 'right')).toBeNull();
    expect(declOf(chrome, '.replay-badge', 'bottom')).toBeNull();
    // 카메라 클릭을 흡수하지 않는다 (다른 크롬과 같은 규칙)
    expect(declOf(chrome, '.replay-badge', 'pointer-events')).toBe('none');
  });

  it('다른 중계 크롬과 같은 luxe 패널 면을 쓴다', () => {
    expect(declOf(chrome, '.replay-badge', 'background')).toBe('var(--luxe-panel)');
    expect(declOf(chrome, '.replay-badge', 'border-radius')).toBe('999px');
  });

  it('펄스는 빨간 점의 opacity만 움직인다 — 레이아웃·배지 전체를 흔들지 않는다', () => {
    const anim = declOf(chrome, '.replay-badge__dot', 'animation');
    expect(anim).toContain('replay-pulse');
    expect(declOf(chrome, '.replay-badge', 'animation')).toBeNull();
    const frames = chrome.slice(chrome.indexOf('@keyframes replay-pulse'));
    const block = frames.slice(0, frames.indexOf('}\n}') + 3);
    expect(block).toContain('opacity');
    expect(block).not.toMatch(/transform|width|height|filter/);
  });

  it('한글 라벨은 자간이 0 이하다 — 양수 자간 금지 규칙 유지 (U108)', () => {
    expect(positiveLetterSpacings(chrome)).toEqual([]);
    expect(declOf(chrome, '.replay-badge__label', 'letter-spacing')).toBe('-0.02em');
  });
});

/**
 * U68 — 오버레이 토글을 부드럽게. 핵심 계약은 **HTML이 토글에 대해 고정된다**는 것이다.
 * (`vdom.ts`에 diff가 없어, 문자열이 달라지는 순간 씬 전체가 새 엘리먼트로 교체되고
 *  transition이 돌 시작점이 사라진다.)
 */
describe('중계 오버레이 등장·퇴장 (U68)', () => {
  /** vitest 환경이 node라 DOM이 없다 — tick이 만지는 최소 표면만 흉내 낸다. */
  function fakeRoot(): { root: HTMLElement; off: Map<string, boolean> } {
    const off = new Map<string, boolean>();
    const root = {
      querySelector(selector: string) {
        const kind = selector.replace('.ov-slot--', '');
        return {
          classList: {
            toggle(cls: string, on: boolean) {
              if (cls === 'is-off') off.set(kind, on);
            },
          },
        };
      },
    } as unknown as HTMLElement;
    return { root, off };
  }

  const withOverlay = (patch: Partial<AppState['sceneOpts']['liveOverlay']>): AppState =>
    reducer(createInitialState(), { type: 'sceneOpts/patch', patch: { liveOverlay: patch } });

  it('타이머를 꺼도 HTML이 한 글자도 달라지지 않는다', () => {
    expect(toHTML(view(withOverlay({ timer: false })))).toBe(
      toHTML(view(withOverlay({ timer: true }))),
    );
  });

  it('스코어바를 꺼도 HTML이 한 글자도 달라지지 않는다', () => {
    expect(toHTML(view(withOverlay({ scorebar: false })))).toBe(
      toHTML(view(withOverlay({ scorebar: true }))),
    );
  });

  it('꺼진 상태에서도 슬롯 마크업은 남는다 — 사라지는 쪽에도 transition이 붙어야 한다', () => {
    const html = toHTML(view(withOverlay({ timer: false, scorebar: false })));
    expect(html).toContain('class="ov-slot ov-slot--timer"');
    expect(html).toContain('class="ov-slot ov-slot--scorebar"');
    expect(html).toContain('class="ov-slot ov-slot--badge"');
    expect(html).toContain('class="ov-slot ov-slot--versus"');
    // 껍데기만 남는 게 아니라 속 내용도 그대로 있다 (숨김은 클래스가 한다)
    expect(html).toContain('timer-badge');
    expect(html).toContain('scorebar');
  });

  it('tick이 네 슬롯의 is-off를 상태대로 갈라 놓는다', () => {
    const { root, off } = fakeRoot();
    tick(root, withOverlay({ timer: false, scorebar: true, badge: null, versus: null }));
    expect(off.get('timer')).toBe(true);
    expect(off.get('scorebar')).toBe(false);
    expect(off.get('badge')).toBe(true);
    expect(off.get('versus')).toBe(true);

    tick(root, withOverlay({ timer: true, scorebar: false, badge: 'curling', versus: ['t1', 't2'] }));
    expect(off.get('timer')).toBe(false);
    expect(off.get('scorebar')).toBe(true);
    expect(off.get('badge')).toBe(false);
    expect(off.get('versus')).toBe(false);
  });

  it('씬 tick 훅이 실제로 live의 tick을 물고 있다', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).toContain('MODULES[override ?? pickScene(state)].tick?.(root, state, now)');
  });

  it('슬롯은 opacity/transform만 움직인다 — 레이아웃 속성 금지', () => {
    const slot = declOf(chrome, '.ov-slot', 'transition') ?? '';
    expect(slot).toContain('opacity');
    expect(slot).toContain('transform');
    expect(slot).not.toMatch(/\b(width|height|top|left|right|bottom|margin|padding|filter)\b/);
    // 절대 배치 기준 상자를 항상 자기가 쥔다 — transform이 붙고 떨어질 때 자식이 튀지 않게
    expect(declOf(chrome, '.ov-slot', 'position')).toBe('absolute');
    expect(declOf(chrome, '.ov-slot', 'inset')).toBe('0');
  });

  it('꺼진 슬롯은 방향이 자기 자리에서 나온다 — 스코어바는 아래, 상단 크롬은 위', () => {
    // 기본 규칙만 본다. 뒤따르는 prefers-reduced-motion 블록이 transform을 none으로 덮으므로
    // 전체에서 마지막 선언을 읽으면 그쪽이 잡힌다.
    const base = chrome.slice(
      chrome.indexOf('.ov-slot {'),
      chrome.indexOf('@media (prefers-reduced-motion: reduce)', chrome.indexOf('.ov-slot {')),
    );
    expect(declOf(base, '.ov-slot--scorebar.is-off', 'transform')).toBe('translateY(8px)');
    expect(declOf(base, '.ov-slot--badge.is-off', 'transform')).toBe('translateY(-8px)');
    expect(declOf(base, '.ov-slot.is-off', 'opacity')).toBe('0');
    expect(declOf(base, '.ov-slot.is-off', 'pointer-events')).toBe('none');
    // 움직임 줄이기에서는 밀림만 없애고 페이드는 남긴다
    expect(declOf(chrome, '.ov-slot--scorebar.is-off', 'transform')).toBe('none');
  });
});
