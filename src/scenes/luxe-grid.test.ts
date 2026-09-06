import { describe, expect, it } from 'vitest';

import { declOf, positiveLetterSpacings, section, TOKENS } from './luxe-css.testkit';
import {
  eventColumns,
  LUXE,
  ROW_GAP,
  ROW_REVEAL_MS,
  ROWS_AREA,
  rowIntroDelayMs,
  rowStep,
  rowStyle,
  rowsStyle,
  rowsTop,
} from './luxe-grid';

const core = section('Broadcast Luxe 공통 골격', 'S4 리더보드');
const sb = section('S4 리더보드', '타이머 (풀스크린)');

/** display.css에 죽은 --sb-purple 별칭이 남아 있는가. */
function CSSHasSbPurple(): boolean {
  return section('Broadcast Luxe 공통 골격', '타이머 (풀스크린)').includes('--sb-purple');
}

/** 예산 변수를 실제로 풀어 6가지 조합의 값 크기(px)를 계산한다. */
function sizeLadder(): number[] {
  const v = (sel: string, prop: string, fallback: number) => {
    const raw = declOf(core, sel, prop);
    return raw === null ? fallback : Number.parseInt(raw, 10);
  };
  const base = v('.luxe-rows', '--cells-fs-v', 0);
  const t5 = v(".luxe-rows[data-teams='5']", '--cells-fs-v', base);
  const t6 = v(".luxe-rows[data-teams='6']", '--cells-fs-v', base);
  const c3 = v(".luxe-rows[data-cols='3']", '--cells-fs-h', base);
  const c4 = v(".luxe-rows[data-cols='4']", '--cells-fs-h', base);
  // 4팀2열 · 5팀2열 · 6팀2열 · 4팀3열 · 4팀4열 · 6팀4열
  return [base, t5, t6, Math.min(base, c3), Math.min(base, c4), Math.min(t6, c4)];
}

describe('Broadcast Luxe 공용 격자 수치', () => {
  it('보드 세로 예산이 매스트헤드·헤더바·행 영역으로 정확히 나뉜다', () => {
    const inner = LUXE.boardH - 2 - LUXE.padTop - LUXE.padBottom; // 테두리 1px 두 겹
    expect(inner - LUXE.mastH - LUXE.headH - LUXE.headGap).toBe(ROWS_AREA);
    expect(ROWS_AREA).toBe(510);
  });

  it('보드 가로 예산이 네 열로 정확히 나뉜다', () => {
    // border-box라 좌우 테두리 1px 두 겹이 콘텐츠에서 빠진다
    expect(LUXE.boardW - 2 - 2 * LUXE.padX).toBe(LUXE.contentW);
    expect(LUXE.contentW).toBe(1390);
    expect(LUXE.colRank + LUXE.pillOverlap).toBe(LUXE.pillW);
    // 리더보드·출전명단은 4열, 시상은 가운데 열을 뺀 3열을 쓴다
    const flexible = LUXE.contentW - LUXE.colRank - LUXE.colTeam - LUXE.colValue;
    expect(flexible).toBe(550);
    expect(flexible).toBeGreaterThanOrEqual(420); // 보조 격자 2열 최소폭
  });

  it('4·5·6팀 step과 행 높이', () => {
    expect(ROW_GAP).toBe(18);
    expect([rowStep(4), rowStep(5), rowStep(6)]).toEqual([127, 102, 85]);
    expect([4, 5, 6].map((n) => rowStep(n) - ROW_GAP)).toEqual([109, 84, 67]);
  });

  it('행 블록이 영역을 넘지 않고 세로 중앙에 놓인다', () => {
    for (const teams of [4, 5, 6]) {
      const block = teams * rowStep(teams) - ROW_GAP;
      expect(block).toBeLessThanOrEqual(ROWS_AREA);
      expect(Math.abs(ROWS_AREA - block - 2 * rowsTop(teams))).toBeLessThanOrEqual(1);
    }
  });

  it('보조 격자는 항목이 늘어도 항상 2줄이다', () => {
    expect(eventColumns(1)).toBe(2);
    expect(eventColumns(4)).toBe(2);
    expect(eventColumns(5)).toBe(3);
    expect(eventColumns(7)).toBe(4);
  });

  it('4~6팀의 마지막 행도 1초 안에 완료되는 지연값을 만든다', () => {
    for (const teams of [4, 5, 6]) {
      expect(rowIntroDelayMs(teams - 1, teams) + ROW_REVEAL_MS).toBeLessThanOrEqual(1000);
    }
    expect(rowIntroDelayMs(0, 4)).toBe(0);
    expect(rowIntroDelayMs(1, 4)).toBeCloseTo(167, 0);
  });

  it('세 씬이 같은 CSS 변수 문자열을 만든다', () => {
    expect(rowsStyle(4, 2)).toBe('--step:127px; --rows-top:10px; --event-cols:2');
    expect(rowStyle('#c0453b', 1, 4)).toBe(
      '--team:#c0453b; --row-index:1; --row-delay:167ms; --rank-delay:167ms',
    );
    // --row-index가 빠지면 absolute 행이 전부 겹친다 (D4)
    expect(rowStyle('#c0453b', 3, 4)).toContain('--row-index:3');
  });
});

describe('공통 골격 CSS가 luxe-grid 수치를 그대로 쓴다', () => {
  it('보드 치수·패딩이 TS 상수와 일치한다', () => {
    expect(declOf(core, '.luxe-board', 'width')).toBe(`${LUXE.boardW}px`);
    expect(declOf(core, '.luxe-board', 'height')).toBe(`${LUXE.boardH}px`);
    expect(declOf(core, '.luxe-board', 'padding')).toBe(
      `${LUXE.padTop}px ${LUXE.padX}px ${LUXE.padBottom}px`,
    );
    expect(declOf(core, '.luxe-board', 'border')).toBe('1px solid var(--luxe-panel-line)');
  });

  it('매스트헤드·헤더바·행 영역 높이가 TS 상수와 일치한다', () => {
    expect(declOf(core, '.luxe-mast', 'height')).toBe(`${LUXE.mastH}px`);
    expect(declOf(core, '.luxe-headbar', 'height')).toBe(`${LUXE.headH}px`);
    expect(declOf(core, '.luxe-rows', 'height')).toBe(`${ROWS_AREA}px`);
    expect(declOf(core, '.luxe-rows', 'margin')).toBe(`${LUXE.headGap}px 0 0`);
    expect(declOf(core, '.luxe-row', 'height')).toBe(`calc(var(--step) - ${ROW_GAP}px)`);
    expect(declOf(core, '.luxe-row', 'top')).toBe('var(--rows-top, 0px)');
  });

  it('pill 폭·캡슐 시작점·아바타 시작선이 TS 상수와 일치한다', () => {
    expect(declOf(core, '.luxe-row > .luxe-pill', 'width')).toBe(`${LUXE.pillW}px`);
    expect(declOf(core, '.luxe-row > .luxe-capsule', 'left')).toBe(`${LUXE.colRank}px`);
    expect(declOf(core, '.luxe-id', 'padding')).toBe(`0 16px 0 ${LUXE.idPadLeft}px`);
    expect(declOf(core, '.luxe-headbar__cell--team', 'padding-left')).toBe(`${LUXE.idPadLeft}px`);
    expect(declOf(core, '.luxe-headbar__cell--rank', 'padding-left')).toBe(
      `${LUXE.pillOverlap}px`,
    );
  });

  it('세 씬의 열 구성이 같은 격자 위에 선다', () => {
    const cols = `${LUXE.colRank}px ${LUXE.colTeam}px minmax(0, 1fr) ${LUXE.colValue}px`;
    expect(declOf(core, '.sb__table-head', 'grid-template-columns')).toBe(cols);
    // U28 이후 출전명단은 행 격자를 쓰지 않는다 — 씬별 열 구성에 남아 있으면 안 된다
    expect(declOf(core, '.rs__headbar', 'grid-template-columns')).toBeNull();
    // U33에서 시상 표가 종목 열을 얻어 리더보드와 같은 4열이 되었다
    expect(declOf(core, '.aw__headbar', 'grid-template-columns')).toBe(cols);
    const capsule = `${LUXE.colTeam}px minmax(0, 1fr) ${LUXE.colValue}px`;
    expect(declOf(core, '.sb__row > .sb__row-body', 'grid-template-columns')).toBe(capsule);
    expect(declOf(core, '.rs__row > .rs__body', 'grid-template-columns')).toBeNull();
    expect(declOf(core, '.aw__row > .aw__body', 'grid-template-columns')).toBe(capsule);
  });

  it('팀 식별색은 아바타 링에서만 쓴다', () => {
    expect(declOf(core, '.luxe-avatar', 'border')).toBe(
      '6px solid color-mix(in srgb, var(--team) 70%, #fff)',
    );
    expect(core).not.toMatch(/background:\s*var\(--team\)/);
  });

  it('재사용 토큰은 display.css가 아니라 tokens.css가 정본이다', () => {
    for (const token of [
      '--luxe-stage',
      '--luxe-panel',
      '--luxe-panel-line',
      '--luxe-capsule-bg',
      '--luxe-capsule-ink',
      '--luxe-violet',
      '--luxe-violet-lit',
      '--luxe-head-grad',
      '--luxe-pill-grad',
      '--luxe-numeral-grad',
    ]) {
      expect(declOf(TOKENS, ':root', token)).not.toBeNull();
      expect(declOf(core, ':root', token)).toBeNull();
    }
    // 죽은 별칭이 남아 있지 않다
    expect(CSSHasSbPurple()).toBe(false);
  });

  it('보조 격자 크기는 세로·가로 예산을 나눠 특이도 충돌을 없앤다', () => {
    // data-teams는 세로 예산만, data-cols는 가로 예산만 건드린다
    expect(declOf(core, ".luxe-rows[data-teams='6']", '--cells-fs-v')).toBe('20px');
    expect(declOf(core, ".luxe-rows[data-teams='6']", '--cells-fs-h')).toBeNull();
    expect(declOf(core, ".luxe-rows[data-cols='4']", '--cells-fs-h')).toBe('22px');
    expect(declOf(core, ".luxe-rows[data-cols='4']", '--cells-fs-v')).toBeNull();
    // 두 예산이 같은 선언에서 만나므로 나중에 온 셀렉터가 이길 자리가 없다
    expect(declOf(sb, '.sb__cell', 'font-size')).toBe(
      'min(var(--cells-fs-v), var(--cells-fs-h))',
    );
    expect(declOf(sb, '.sb__event-label', 'font-size')).toBe(
      'min(var(--cells-label-v), var(--cells-label-h))',
    );
    // 6팀 × 7종목: 세로 20px이 가로 22px보다 작으므로 20px이 이겨야 한다
    expect(sizeLadder()).toEqual([28, 24, 20, 25, 22, 20]);
  });

  it('보드를 쓰는 네 씬이 같은 스테이지 배경을 쓴다', () => {
    for (const scene of ['.scene--score', '.scene--roster', '.award--table', '.award--total']) {
      expect(declOf(core, scene, 'background')).toBe('var(--luxe-stage)');
    }
  });

  it('공통 골격에는 양수 자간이 하나도 없다', () => {
    expect(positiveLetterSpacings(core)).toEqual([]);
  });
});
