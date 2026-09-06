import { animatedNumber } from './anim';
import { fmtPoints } from '../scoring';
import { BONUS_COL_KEY, BONUS_COL_TIP, orderByTotal, scoreColumns, scoreRows } from './common';
import { eventColumns, eventMark, rowIntroDelayMs, rowStep, rowStyle, rowsStyle } from './luxe-grid';
import { logoClass } from '../logos';
import { h, renderInto, type VNode } from '../vdom';
import type { AppState, TeamId } from '../types';

/** 격자 수치는 세 씬(리더보드·출전명단·시상)이 공유한다. 여기서는 다시 내보내기만 한다. */
export {
  eventColumns,
  ROW_GAP,
  ROWS_AREA,
  rowIntroDelayMs,
  rowStep,
  rowsTop,
} from './luxe-grid';

/**
 * S4 풀스크린 스코어보드 (G2) — Broadcast Luxe 스킨 (2026-09-03 Q1).
 * 행은 팀 순서로 고정 배치하고 tick()에서 transform으로 순위 위치를 잡는다
 * → HTML 교체 없이 CSS transition으로 정렬 애니메이션이 돈다.
 * **2부 잠금 중에는 scoreColumns()가 2부 열을 만들지 않는다.** (P3)
 *
 * U138 — 사회자 재량 보너스·수동 가감점이 있으면 맨 뒤에 `BONUS` 열이 하나 붙는다.
 * 그 전에는 이 점수들이 총점에만 들어가고 열에는 없어서 **종목 열 합 ≠ TOTAL**이었다.
 */
export function view(state: AppState): VNode {
  const cols = scoreColumns(state);
  const rows = scoreRows(state);
  const highlight = state.sceneOpts.score.highlight;
  /**
   * U89 — 종목 점수 공개 큐(`score-<event>`)는 **그 종목 한 칸과 합계만** 보여 준다.
   * 지금 끝난 판의 점수가 이전 종목 숫자 더미에 묻혀 "몇 점 났나"가 한눈에 안 들어왔다
   * (사용자 지시 2026-09-05: "이전 게임들은 안 보이게 … 간결하게").
   *
   * CSS로 가리는 게 아니라 **칸 자체를 만들지 않는다** — 2부 잠금이 열을 만들지 않는 것(P3)과
   * 같은 원칙이다. 숨긴 칸이 격자 폭·글자 예산을 계속 먹으면 남은 두 숫자가 커지지 못한다.
   * F3 전체 스코어보드(highlight = null)는 예전 그대로 전 종목을 늘어놓는다.
   */
  const hlCol = highlight === null ? null : (cols.find((c) => c.key === highlight) ?? null);
  const eventCols = hlCol ? 1 : eventColumns(cols.length);

  return h(
    'div',
    { class: 'scene scene--score' },
    h(
      'div',
      { class: 'sb__board', 'data-teams': String(rows.length) },
      h(
        'div',
        { class: 'sb__masthead' },
        // 세 보드 씬이 같은 중립 모노그램을 쓴다.
        eventMark(),
        h('div', { class: 'sb__title' }, 'EVENT CONSOLE LEADERBOARD'),
      ),
      h(
        'div',
        { class: 'sb__table-head' },
        h('div', { class: 'sb__head-rank' }, 'RANK'),
        h('div', { class: 'sb__head-team' }, 'TEAM'),
        // 헤더도 행과 같은 것만 말한다 — 한 종목만 보일 때는 그 종목 이름이 열 이름이다.
        h('div', { class: 'sb__head-events' }, hlCol ? hlCol.label : 'EVENT SCORE'),
        h('div', { class: 'sb__col sb__col--total' }, 'TOTAL'),
      ),
      h(
        'div',
        {
          class: 'sb__rows',
          style: rowsStyle(rows.length, eventCols),
          'data-teams': String(rows.length),
          'data-cols': String(eventCols),
        },
        rows.map((r, rowIndex) =>
          h(
            'div',
            {
              class: 'sb__row',
              'data-team': r.teamId,
              style: rowStyle(r.color, rowIndex, rows.length),
            },
            h('div', { class: 'sb__rank', 'data-bind': 'rank', 'data-team': r.teamId }, ''),
            h(
              'div',
              { class: 'sb__row-body' },
              h(
                'div',
                { class: 'sb__id' },
                h('span', { class: 'sb__avatar' }, r.logo
                  ? h('img', { class: logoClass('sb__logo', r.logo), src: r.logo, alt: '' })
                  : h('span', { class: 'sb__logo-fallback', 'aria-hidden': 'true' }, 'EC')),
                h('span', { class: 'sb__name' }, r.name),
              ),
              h(
                'div',
                { class: hlCol ? 'sb__cells sb__cells--solo' : 'sb__cells' },
                (hlCol ? r.cells.filter((c) => c.key === hlCol.key) : r.cells).map((c) =>
                  h('div', {
                    class:
                      `sb__event-item${highlight === c.key ? ' is-hl' : ''}` +
                      (c.key === BONUS_COL_KEY ? ' sb__event-item--bonus' : ''),
                    // BONUS는 종목이 아니다 — 무엇을 더한 값인지 hover·스크린리더가 답한다.
                    ...(c.key === BONUS_COL_KEY
                      ? { title: BONUS_COL_TIP, 'aria-label': BONUS_COL_TIP }
                      : {}),
                  },
                    h('span', { class: 'sb__event-label' }, c.label),
                    h('span', {
                      class: `sb__cell is-empty${highlight === c.key ? ' is-hl' : ''}`,
                      'data-bind': 'score-cell', 'data-team': r.teamId, 'data-col': c.key,
                    }, '–')),
                ),
              ),
              h('div', { class: 'sb__total', 'data-bind': 'total', 'data-team': r.teamId }, '0'),
            ),
          ),
        ),
      ),
    ),
  );
}

/**
 * 순위 pill 등장(`sb-rank-reveal`)이 늦어도 이 시각에는 시작해야 한다 — `rowStyle`이 굽는
 * 클램프와 같은 값이다(`luxe-grid.ts:112`). 두 곳이 어긋나지 않는지는 테스트가 본다.
 */
const RANK_DELAY_MAX_MS = 467;

/** 슬롯(순위) 인덱스가 쓰는 진입 스태거 변수 한 쌍. */
function rowDelayVars(index: number, count: number): { row: string; rank: string } {
  const delay = rowIntroDelayMs(index, count);
  return { row: `${delay}ms`, rank: `${Math.min(delay, RANK_DELAY_MAX_MS)}ms` };
}

/**
 * 화면 슬롯(순위) 순서대로의 진입 지연 (U76 회귀 핀).
 *
 * vitest 환경이 node라 DOM이 없다. tick()이 쓰는 것과 같은 계산을 순수 함수로 뽑아
 * "1위가 가장 먼저 들어온다"를 값으로 고정한다.
 */
export function rowEnterDelays(
  state: AppState,
): { teamId: TeamId; slot: number; delayMs: number }[] {
  const rows = scoreRows(state);
  const order = orderByTotal(state);
  return rows
    .map((r) => {
      const idx = order.indexOf(r.teamId);
      return { teamId: r.teamId, slot: idx + 1, delayMs: rowIntroDelayMs(idx, rows.length) };
    })
    .sort((a, b) => a.slot - b.slot);
}

export function tick(root: HTMLElement, state: AppState, now: number): void {
  const rows = scoreRows(state);
  const order = orderByTotal(state);
  const step = rowStep(rows.length);

  for (const r of rows) {
    const idx = order.indexOf(r.teamId);
    const rowEl = root.querySelector<HTMLElement>(`.sb__row[data-team="${r.teamId}"]`);
    if (rowEl) {
      rowEl.style.transform = `translateY(${idx * step}px)`;
      // 재정렬은 **DOM 순서를 바꾸지 않는다** — `translateY`만 움직인다. 그래서 순위를 여기
      // 남겨야 글로우 정지 판정(D9)이 재정렬을 볼 수 있다. 마크업이 아니라 tick이 쓰므로
      // `renderInto`의 HTML 캐시 키는 그대로다(같은 이유로 transform도 여기서 쓴다).
      rowEl.dataset.rank = String(idx);
      // U76 — 진입 스태거는 DOM(팀 명부) 순서가 아니라 **순위**를 따라야 한다.
      // 마크업의 `--row-delay`는 명부 순서로 구워지므로, 3·4위가 명부와 뒤바뀐 팀에서는
      // 위에서 두 번째 행보다 네 번째 행이 먼저 들어와 1-2-4-3으로 보였다.
      // 인라인 값은 `renderInto`의 HTML 캐시 키 밖이라 재정렬 트윈(D9)을 깨지 않는다.
      const delays = rowDelayVars(idx, rows.length);
      rowEl.style.setProperty('--row-delay', delays.row);
      rowEl.style.setProperty('--rank-delay', delays.rank);
      // 선두만 골드로 — 색을 위계로 쓰는 유일한 자리
      rowEl.classList.toggle('is-lead', idx === 0);
    }

    const value = animatedNumber(`score:${r.teamId}`, r.total, now);
    const totalEl = root.querySelector<HTMLElement>(`.sb__total[data-team="${r.teamId}"]`);
    if (totalEl) totalEl.textContent = fmtPoints(Math.round(value));

    const rankEl = root.querySelector<HTMLElement>(`.sb__rank[data-team="${r.teamId}"]`);
    if (rankEl) rankEl.textContent = String(idx + 1);

    for (const cell of r.cells) {
      const cellEl = root.querySelector<HTMLElement>(
        `.sb__cell[data-team="${r.teamId}"][data-col="${cell.key}"]`,
      );
      if (!cellEl) continue;
      cellEl.textContent = cell.points ? fmtPoints(cell.points) : '–';
      cellEl.title = cell.points ? `${cell.label} · ${fmtPoints(cell.points)}점` : `${cell.label} · 미집계`;
      cellEl.classList.toggle('is-empty', !cell.points);
    }
  }
}

export function render(state: AppState, root: HTMLElement): boolean {
  return renderInto(root, view(state));
}
