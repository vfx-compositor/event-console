import { describe, expect, it } from 'vitest';
import { createInitialState } from '../state';
import { toHTML } from '../vdom';
import { declOf, positiveLetterSpacings, section } from './luxe-css.testkit';
import { view } from './timerScene';

// U114 (2026-09-05 사용자 지시) — "위에 글씨(남은 시간) 크게, 아래 숫자 작게".
// U99가 고친 건 조작 패널(콘솔) 타이머 탭(src/scenes/tab-*)뿐이고, 이 씬은 출력 화면
// 풀스크린 타이머(F4)라 완전히 다른 자리다 — 혼동해서 U99 값을 다시 여기 넣지 않도록 고정.
const timerCss = section(
  '════════════════════════════════════════════════════════ 타이머 (풀스크린)',
  '════════════════════════════════════════════════════════ 출전 명단',
);

describe('출력 타이머 씬 (U114)', () => {
  it('라벨(남은 시간)이 숫자보다 크다 — 128px, 800 weight (96px 실측이 캡션처럼 읽혀 확정한 값)', () => {
    expect(declOf(timerCss, '.bigtimer__label', 'font-size')).toBe('128px');
    expect(declOf(timerCss, '.bigtimer__label', 'font-weight')).toBe('800');
  });

  it('숫자는 라벨보다 작게 줄었다 — 300px (U99 조작 패널 타이머 탭과는 다른 값)', () => {
    expect(declOf(timerCss, '.bigtimer', 'font-size')).toBe('300px');
  });

  it('진행 바 폭은 줄어든 숫자 폭에 맞춰 880px', () => {
    expect(declOf(timerCss, '.bigtimer__bar', 'width')).toBe('880px');
  });

  it('라벨이 숫자보다 DOM에서 먼저 온다 (위에 글씨, 아래 숫자)', () => {
    const html = toHTML(view(createInitialState()));
    const labelAt = html.indexOf('class="bigtimer__label"');
    const numberAt = html.indexOf('data-bind="timer"');
    expect(labelAt).toBeGreaterThanOrEqual(0);
    expect(numberAt).toBeGreaterThanOrEqual(0);
    expect(labelAt).toBeLessThan(numberAt);
  });

  it('라벨 텍스트는 "남은 시간" 그대로다', () => {
    const html = toHTML(view(createInitialState()));
    expect(html).toMatch(/class="bigtimer__label"[^>]*>남은 시간</);
  });

  it('양수 letter-spacing 없음 (전역 UI 규칙 — 한글 자간은 0 또는 음수만)', () => {
    expect(positiveLetterSpacings(timerCss)).toEqual([]);
  });
});
