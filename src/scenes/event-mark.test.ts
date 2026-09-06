/**
 * 리더보드·시상·출전명단과 조작 패널이 같은 중립 모노그램을 사용한다.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { existsSync, readFileSync } from 'node:fs';

import { EVENT_MARK_H, EVENT_MARK_SRC } from './luxe-grid';
import { CSS as css, declOf } from './luxe-css.testkit';
import { createInitialState, reducer } from '../state';
import { toHTML } from '../vdom';
import { view as scoreView } from './score';
import { view as rosterView } from './roster';
import { view as awardView } from './award';

const displaySource = readFileSync(new URL('../display.ts', import.meta.url), 'utf8');
const topbarSource = readFileSync(new URL('../control/topbar.ts', import.meta.url), 'utf8');

describe('Event Console 모노그램', () => {
  it('실파일이 있고 경로가 하나의 상수에서 나온다', () => {
    expect(EVENT_MARK_SRC).toMatch(/^data:image\/svg\+xml,/);
    expect(existsSync(new URL('../../public/media/event_mark.png', import.meta.url))).toBe(false);
  });

  it('리더보드는 게임패드 SVG를 더 이상 그리지 않는다', () => {
    const html = toHTML(scoreView(createInitialState()));
    expect(html).toContain('class="luxe-mast__mark"');
    expect(html).not.toContain('sb__game-icon');
    // 텍스트 워드마크는 그대로 남는다
    expect(html).toContain('EVENT CONSOLE LEADERBOARD');
  });

  it('출전 명단도 같은 마크를 같은 자리에 둔다', () => {
    const html = toHTML(rosterView(createInitialState()));
    expect(html).toContain('class="luxe-mast__mark"');
    expect(html).toContain('출전명단');
  });

  it('시상은 텍스트 워드마크를 지우지 않고 병기한다', () => {
    const state = reducer(createInitialState(), {
      type: 'sceneOpts/patch',
      patch: { award: { step: 'p1' } },
    });
    const html = toHTML(awardView(state));
    expect(html).toContain('class="luxe-mast__mark"');
    expect(html).toContain('luxe-mast__title');
  });

  it('마크는 마스트헤드(120px) 안에 들어가고 비율을 지킨다', () => {
    expect(EVENT_MARK_H).toBe(88);
    expect(declOf(css, '.luxe-mast__mark', 'height')).toBe(`${EVENT_MARK_H}px`);
    expect(declOf(css, '.luxe-mast__mark', 'width')).toBe('auto');
    expect(declOf(css, '.luxe-mast__mark', 'object-fit')).toBe('contain');
    const mast = Number.parseInt(declOf(css, '.luxe-mast', 'height') ?? '0', 10);
    expect(EVENT_MARK_H).toBeLessThan(mast);
  });

  it('display 부팅에서 팀 배지와 함께 예열한다', () => {
    expect(displaySource).toContain('[...DEFAULT_TEAM_LOGOS, EVENT_MARK_SRC]');
  });

  it('조작 패널 상단바도 같은 마크를 쓴다 — 불꽃 엠블럼은 남기지 않는다', () => {
    expect(topbarSource).toContain("class: 'topbar__mark'");
    expect(topbarSource).toContain('EVENT_MARK_SRC');
    expect(topbarSource).not.toContain('emblemElement');
  });
});
