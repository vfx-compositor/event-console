import { animatedNumber } from './anim';
import { activeTeamIds, computeScores, P1_EVENT_ORDER } from '../state';
import { fmtPoints } from '../scoring';
import { awardBreakdown, BONUS_COL_KEY, BONUS_COL_TIP, orderByTotal, type AwardCell } from './common';
import { eventMark, rowStyle, rowsStyle } from './luxe-grid';
import { h, renderInto, type VNode } from '../vdom';
import { logoClass, logoUrl } from '../logos';
import type { AppState, Team, TeamId } from '../types';

/**
 * 시상 리빌 상태머신: p1 → p2 → total(카운트업) → reveal(꼴찌부터 등수·팀 두 박자) → winner.
 * 2부 잠금 중이면 p2 단계는 렌더하지 않는다(1부만으로도 시상이 성립하도록 total로 대체).
 *
 * U20에서 시각만 Broadcast Luxe로 교체했다 — 보드·순위 pill·흰 캡슐 격자를 리더보드와 공유하고
 * 상태 전이·공개 순서·미공개 팀 비노출 계약은 그대로다.
 */
type Sorter = (a: TeamId, b: TeamId) => number;

/**
 * 표 단계 종목 격자의 열 수 — **1부 종목 수로 고정**한다 (U80).
 *
 * 예전에는 `eventColumns(칸수)`(= ⌈n/2⌉)를 썼다. 칸이 4개면 2열 2행, 2부가 붙어 5개가 되면
 * 3열 2행이 되어 ④와 2부가 같은 줄에 섞였다 — 1부/2부의 층이 보이지 않았다.
 * 열을 `P1_EVENT_ORDER.length`로 고정하면 **1부 네 종목이 정확히 첫 줄**을 채우고 2부는
 * 다음 줄로 내려간다(2부 칩은 CSS가 줄 전체를 쓰게 한다). 잠금 중에는 칸이 4개뿐이라
 * 한 줄로 끝난다. 리더보드는 `eventColumns()`를 그대로 쓴다 — 거기는 종목 수가 유동적이다.
 */
const AWARD_EVENT_COLS = P1_EVENT_ORDER.length;

function orderBy(state: AppState, pick: (t: { p1: number; p2: number; total: number }) => number): TeamId[] {
  const s = computeScores(state);
  const ids = activeTeamIds(state);
  const cmp: Sorter = (a, b) => pick(s[b]) - pick(s[a]) || ids.indexOf(a) - ids.indexOf(b);
  return [...ids].sort(cmp);
}

/**
 * 시상 무대 상단 마크.
 *
 * 불꽃 엠블럼(`../emblem`)을 쓰지 않는다 — 인계 계약(HANDOFF 2026-08-26 §0-1)의
 * 공개 배포판은 특정 행사 로고를 포함하지 않는다.
 * 행사 로고를 사용할 때의 **교체 지점**은 아래 두 span이다.
 * `emblem.ts`는 지우지 않았다 — 씬 전환 스윕과 조작 패널 헤더가 아직 쓴다.
 */
function stageMark(): VNode {
  return h(
    'div',
    { class: 'award__mark' },
    h('span', { class: 'award__mark-name' }, 'EVENT CONSOLE'),
    h('span', { class: 'award__mark-sub' }, 'AWARDS'),
  );
}

/**
 * 칩 한 개의 조각 — **동그란 번호 + 값**, 이름은 속성으로만 (U80).
 *
 * ## 왜 종목명을 화면에서 지웠나
 * 1부는 언제나 `P1_EVENT_ORDER` 네 종목이 이 순서로 고정이다 — ①컬링 ②신문지 달리기
 * ③끈끈이 낚시 ④몸으로 말해요. 매 방송 같은 이름 네 개가 줄을 채우니 정작 읽어야 할
 * 숫자가 묻혔다(사용자 지적: 두 줄짜리 "종목명 100 · 종목명 100 …"). 순서가 정보를
 * 대신하므로 화면에는 번호와 값만 남긴다.
 *
 * **정보에서 지운 것은 아니다.** 이름은 `title`·`aria-label`에 그대로 있고, `toText()`가
 * 이 두 속성을 읽으므로 잠금 검증(AC-2)과 스크린리더 모두 예전과 같은 문자열을 본다.
 *
 * ## 2부
 * `awardCells()`가 2부를 **합계 한 칸**으로 접어 준다(U33) — 여기서 다시 쪼개지 않는다.
 * 번호 자리에 `2부`가 들어가고 CSS가 채운 마커로 구분한다. 잠금 중에는 그 칸이 애초에
 * 만들어지지 않으므로 DOM에도 없다(P3 미공개 비노출).
 */
interface ChipParts {
  /** 마커 안에 들어갈 글자 — 1부는 순번, 2부는 `2부`, 보너스는 `±` */
  mark: string;
  /** 화면에 보이는 값 */
  value: string;
  /** `title`·`aria-label`에만 남는 종목명 + 점수 */
  label: string;
  /** 2부 합계 칸인가 — 채운 마커·줄바꿈을 CSS가 이 클래스로 잡는다 */
  isP2: boolean;
  /** 보너스(가감점) 칸인가 — 종목이 아니므로 순번을 받지 않는다 (U138) */
  isBonus: boolean;
}

/**
 * 보너스 칸의 마커는 `±`다. 한 글자라 1부와 같은 원이 되고, 종목 번호와 헷갈리지 않으며
 * "더하거나 뺀 점수"라는 뜻을 글자 하나로 말한다. 이름(`BONUS`)과 산출 근거는 `title`·
 * `aria-label`에 남으므로 hover·스크린리더·`toText()` 잠금 검증이 그대로 읽는다.
 */
function chipParts(cell: AwardCell, index: number): ChipParts {
  const isP2 = cell.key === 'p2';
  const isBonus = cell.key === BONUS_COL_KEY;
  const value = cell.points ? fmtPoints(cell.points) : '–';
  const label = cell.points ? `${cell.label} · ${value}점` : `${cell.label} · 미집계`;
  return {
    mark: isP2 ? '2부' : isBonus ? '±' : String(index + 1),
    value,
    label: isBonus ? `${label} (${BONUS_COL_TIP})` : label,
    isP2,
    isBonus,
  };
}

/** 칩 하나가 쓰는 수식어 클래스 — 칩 줄·표가 같은 문자열을 쓴다. */
function chipMod(p: ChipParts): string {
  if (p.isP2) return ' aw__chip--p2';
  return p.isBonus ? ' aw__chip--bonus' : '';
}

/**
 * 누적 내역 칩 줄 (U33) — 스포트라이트·이력 카드가 같은 마크업을 쓰고 크기만 다르다.
 * 숫자는 `awardBreakdown()`이 준 값 그대로다. 여기서 더하거나 고르지 않는다.
 * **공개된 팀에 대해서만 호출된다** — 미공개 팀은 애초에 이 함수까지 오지 않으므로
 * 점수가 DOM에 새지 않는다(시상 비노출 계약).
 */
function breakdown(cells: AwardCell[], variant: string): VNode | null {
  if (cells.length === 0) return null;
  return h(
    'div',
    { class: `award__breakdown ${variant}` },
    cells.map((c, i) => {
      const p = chipParts(c, i);
      return h(
        'span',
        {
          class: `award__breakdown-chip aw__chip${chipMod(p)}`,
          title: p.label,
          'aria-label': p.label,
        },
        h('span', { class: 'aw__chip-no', 'aria-hidden': 'true' }, p.mark),
        h('span', { class: `award__breakdown-pts aw__chip-val${c.points ? '' : ' is-empty'}` },
          p.value),
      );
    }),
  );
}

/**
 * 표 단계의 보조 격자 — 리더보드 격자 상자(.luxe-cells)에 U80 칩을 담는다.
 *
 * 열은 1부 종목 수(4)로 고정이라 첫 줄이 1부, 둘째 줄이 2부 합계다. 여기에 BONUS까지
 * 붙으면 **셋째 줄**이 생겨 행 높이(4팀 109px)를 넘긴다. 그래서 둘이 함께 있을 때만
 * `--pair`를 달아 2부 합계가 앞 세 열, BONUS가 마지막 열을 쓰게 한다 — 두 줄로 끝난다.
 */
function tableCells(cells: AwardCell[]): VNode {
  const pairRow =
    cells.some((c) => c.key === 'p2') && cells.some((c) => c.key === BONUS_COL_KEY);
  return h(
    'div',
    { class: `luxe-cells aw__cells${pairRow ? ' aw__cells--pair' : ''}` },
    cells.map((c, i) => {
      const p = chipParts(c, i);
      return h(
        'div',
        {
          class: `luxe-event-item aw__chip${chipMod(p)}`,
          title: p.label,
          'aria-label': p.label,
        },
        h('span', { class: 'aw__chip-no', 'aria-hidden': 'true' }, p.mark),
        h('span', { class: `luxe-cell aw__chip-val${c.points ? '' : ' is-empty'}` }, p.value),
      );
    }),
  );
}

function teamLogo(team: Team): VNode {
  const url = logoUrl(team);
  return url
    ? h('img', { class: logoClass('luxe-logo', url), src: url, alt: '' })
    : h('span', { class: 'luxe-logo-fallback', 'aria-hidden': 'true' }, 'EC');
}

/** 보드 + 매스트헤드 껍데기 — 표·합산 단계가 공유한다. */
function board(state: AppState, eyebrow: string, title: string, headCell: string, body: VNode): VNode {
  const teams = activeTeamIds(state).length;
  return h(
    'div',
    { class: 'luxe-board', 'data-teams': String(teams) },
    h(
      'div',
      { class: 'luxe-mast' },
      // U46 — 텍스트 워드마크를 **교체하지 않고 병기**한다. 리더보드와 같은 자리·같은 크기.
      eventMark(),
      h(
        'div',
        { class: 'luxe-mast__text' },
        h('div', { class: 'luxe-mast__eyebrow' }, eyebrow),
        h('div', { class: 'luxe-mast__title' }, title),
      ),
    ),
    h(
      'div',
      { class: 'luxe-headbar aw__headbar' },
      h('div', { class: 'luxe-headbar__cell luxe-headbar__cell--rank' }, 'RANK'),
      h('div', { class: 'luxe-headbar__cell luxe-headbar__cell--team' }, 'TEAM'),
      h('div', { class: 'luxe-headbar__cell' }, 'EVENT SCORE'),
      h('div', { class: 'luxe-headbar__cell' }, headCell),
    ),
    body,
  );
}

function rankTable(state: AppState, title: string, pick: (t: { p1: number; p2: number; total: number }) => number): VNode {
  const s = computeScores(state);
  const order = orderBy(state, pick);
  const breakdowns = awardBreakdown(state);
  const cols = AWARD_EVENT_COLS;
  return board(
    state,
    '순위 집계',
    title,
    'POINTS',
    h(
      'ol',
      {
        class: 'luxe-rows aw__rows',
        style: rowsStyle(order.length, cols),
        'data-teams': String(order.length),
        'data-cols': String(cols),
      },
      order.map((id, i) => {
        const team = state.teams.find((t) => t.id === id)!;
        return h(
          'li',
          {
            class: `luxe-row aw__row${i === 0 ? ' is-first' : ''}`,
            'data-team': id,
            style: rowStyle(team.color, i, order.length),
          },
          h('div', { class: 'luxe-pill aw__pos' }, `${i + 1}`),
          h(
            'div',
            { class: 'luxe-capsule aw__body' },
            h(
              'div',
              { class: 'luxe-id aw__id' },
              h('span', { class: 'luxe-avatar' }, teamLogo(team)),
              h('span', { class: 'luxe-name' }, team.name),
            ),
            tableCells(breakdowns.get(id) ?? []),
            h('div', { class: 'luxe-value aw__pts' }, `${fmtPoints(pick(s[id]))}점`),
          ),
        );
      }),
    ),
  );
}

export function view(state: AppState): VNode {
  const step = state.sceneOpts.award.step;
  const revealed = state.sceneOpts.award.revealed;
  const unlocked = state.p2.unlocked;

  if (step === 'p1') {
    return h('div', { class: 'scene scene--award award--table' }, rankTable(state, '1부 순위', (t) => t.p1));
  }
  if (step === 'p2') {
    // 잠금 중이면 2부 표를 만들지 않고 1부 표로 안전 대체한다 (P3)
    return h(
      'div',
      { class: 'scene scene--award award--table' },
      unlocked ? rankTable(state, '2부 순위', (t) => t.p2) : rankTable(state, '1부 순위', (t) => t.p1),
    );
  }
  if (step === 'total') {
    const order = orderByTotal(state);
    const breakdowns = awardBreakdown(state);
    const cols = AWARD_EVENT_COLS;
    return h(
      'div',
      { class: 'scene scene--award award--total' },
      board(
        state,
        '종합 합산',
        'FINAL STANDINGS',
        'TOTAL',
        h(
          'div',
          {
            class: 'luxe-rows aw__rows',
            style: rowsStyle(order.length, cols),
            'data-teams': String(order.length),
            'data-cols': String(cols),
          },
          order.map((id, i) => {
            const team = state.teams.find((t) => t.id === id)!;
            return h(
              'div',
              {
                class: `luxe-row aw__row${i === 0 ? ' is-first' : ''}`,
                'data-team': id,
                style: rowStyle(team.color, i, order.length),
              },
              h('div', { class: 'luxe-pill aw__pos' }, `${i + 1}`),
              h(
                'div',
                { class: 'luxe-capsule aw__body' },
                h(
                  'div',
                  { class: 'luxe-id aw__id' },
                  h('span', { class: 'luxe-avatar' }, teamLogo(team)),
                  h('span', { class: 'luxe-name' }, team.name),
                ),
                tableCells(breakdowns.get(id) ?? []),
                // 카운트업 슬롯 — 문자열은 tick()이 채우므로 vnode에는 '0'만 둔다
                h(
                  'div',
                  { class: 'luxe-value aw__total-num', 'data-bind': 'awardtotal', 'data-team': id },
                  '0',
                ),
              ),
            );
          }),
        ),
      ),
    );
  }
  if (step === 'reveal') {
    const order = orderByTotal(state); // 1위 → N위
    const scores = computeScores(state);
    const breakdowns = awardBreakdown(state);
    const directRank = state.sceneOpts.award.selectedRank;
    if (directRank !== null) {
      const directPosition = directRank - 1;
      const directId = order[directPosition];
      const directTeam = state.teams.find((team) => team.id === directId)!;
      const teamRevealed = state.sceneOpts.award.selectedTeamRevealed;
      /**
       * U127 — 독립 공개면 이력 칸 자체를 만들지 않는다.
       *
       * 사용자 지시(2026-09-05 10:56): "최종 순위 발표 때 다른 팀 안 보이게 하고 4위 팀만 공개,
       * 이런 식으로 독립으로 구분." **가리는 것이 아니라 렌더하지 않는다** — U89 점수 공개 씬이
       * 다른 종목을 그리지 않는 것과 같은 규칙이고, `historyCard()`까지 가지 않으므로 다른 팀의
       * 이름·점수·컬러·로고 id가 DOM에 한 글자도 남지 않는다(미공개 팀 비노출 계약의 확장).
       *
       * 빈 `<div>`로 남기지 않는 이유: 격자 첫 칸을 빈 상자가 차지하면 카드 한 장이 오른쪽으로
       * 치우친다. CSS는 `.award--reveal.is-solo`에서 한 칸 격자로 접는다.
       */
      const solo = state.sceneOpts.award.solo;
      const historyRanks = solo
        ? []
        : state.sceneOpts.award.revealedRanks.filter((rank) => rank !== directRank);
      return h(
        'div',
        {
          class: `scene scene--award award--reveal${solo ? ' is-solo' : ''}`,
          'data-selected-rank': String(directRank),
          'data-team-revealed': String(teamRevealed),
          'data-solo': String(solo),
        },
        stageMark(),
        h('div', { class: 'award__eyebrow' }, '최종 순위 발표'),
        h(
          'div',
          { class: 'award__reveal-stage' },
          solo
            ? null
            : h(
                'div',
                { class: 'award__reveal-history' },
                historyRanks.map((rank) => historyCard(state, order, scores, breakdowns, rank)),
              ),
          h(
            'div',
            { class: `award__reveal-focus${teamRevealed ? ' is-team-revealed' : ''}` },
            teamRevealed
              ? [
                  h('span', { class: 'award__focus-rank' }, `${directRank}위`),
                  h('span', { class: 'award__focus-avatar luxe-avatar', style: `--team:${directTeam.color}` }, teamLogo(directTeam)),
                  h('span', { class: 'award__focus-team' }, directTeam.name),
                  h('span', { class: 'award__focus-points' }, `${fmtPoints(scores[directId].total)}점`),
                  breakdown(breakdowns.get(directId) ?? [], 'award__focus-breakdown'),
                ]
              : [
                  h('span', { class: 'award__focus-rank' }, `${directRank}위`),
                  h('span', { class: 'award__focus-guide' }, `${directRank}위 팀은`),
                  h('span', { class: 'award__focus-mask' }, 'TEAM REVEAL'),
                ],
          ),
        ),
      );
    }
    const completedPositions = Array.from({ length: revealed }, (_, i) => order.length - 1 - i);
    const focusPosition = order.length - 1 - revealed;
    return h(
      'div',
      {
        class: 'scene scene--award award--reveal',
        'data-revealed': String(revealed),
        'data-rank-revealed': String(state.sceneOpts.award.rankRevealed),
      },
      stageMark(),
      h('div', { class: 'award__eyebrow' }, '최종 순위 발표'),
      h(
        'div',
        { class: 'award__reveal-stage' },
        h(
          'div',
          { class: 'award__reveal-history' },
          completedPositions.map((pos) => historyCard(state, order, scores, breakdowns, pos + 1)),
        ),
        h(
          'div',
          { class: 'award__reveal-focus' },
          revealed >= order.length
            ? [
                h('span', { class: 'award__focus-complete' }, 'FINAL'),
                h('span', { class: 'award__focus-guide' }, '모든 팀 공개 완료'),
              ]
            : state.sceneOpts.award.rankRevealed
              ? [
                  h('span', { class: 'award__focus-rank' }, `${focusPosition + 1}위`),
                  h('span', { class: 'award__focus-guide' }, '등수 공개'),
                  h('span', { class: 'award__focus-mask' }, 'TEAM REVEAL'),
                ]
              : [
                  h('span', { class: 'award__focus-wait' }, '?'),
                  h('span', { class: 'award__focus-guide' }, '다음 등수를 공개하세요'),
                ],
        ),
      ),
    );
  }

  // winner
  const order = orderByTotal(state);
  const winner = state.teams.find((t) => t.id === order[0])!;
  const scores = computeScores(state);
  const winnerCells = awardBreakdown(state).get(winner.id) ?? [];
  return h(
    'div',
    { class: 'scene scene--award award--winner', style: `--team:${winner.color}` },
    h('div', { class: 'confetti-slot', 'data-confetti': '1' }),
    h('div', { class: 'winner__eyebrow' }, 'CHAMPION'),
    h('div', { class: 'winner__avatar luxe-avatar' }, teamLogo(winner)),
    h('div', { class: 'winner__name' }, winner.name),
    h('div', { class: 'winner__pts' }, `${fmtPoints(scores[winner.id].total)}점`),
    breakdown(winnerCells, 'winner__breakdown'),
  );
}

/** 이미 공개된 등수 한 장. 공개 전 팀은 호출 자체가 없으므로 DOM에 흔적이 남지 않는다. */
function historyCard(
  state: AppState,
  order: TeamId[],
  scores: Record<TeamId, { total: number }>,
  breakdowns: Map<TeamId, AwardCell[]>,
  rank: number,
): VNode {
  const id = order[rank - 1];
  const team = state.teams.find((candidate) => candidate.id === id)!;
  return h(
    'div',
    {
      class: `award__history-card${rank === 1 ? ' is-winner' : ''}`,
      style: `--team:${team.color}`,
    },
    h('span', { class: 'luxe-pill award__history-pos' }, `${rank}위`),
    h(
      'span',
      { class: 'luxe-capsule award__history-body' },
      h('span', { class: 'luxe-avatar' }, teamLogo(team)),
      h(
        'span',
        { class: 'award__history-id' },
        h('span', { class: 'luxe-name award__history-team' }, team.name),
        breakdown(breakdowns.get(id) ?? [], 'award__history-breakdown'),
      ),
      h('span', { class: 'luxe-value award__history-pts' }, `${fmtPoints(scores[id].total)}점`),
    ),
  );
}

export function tick(root: HTMLElement, state: AppState, now: number): void {
  if (state.sceneOpts.award.step !== 'total') return;
  const s = computeScores(state);
  for (const id of activeTeamIds(state)) {
    const el = root.querySelector<HTMLElement>(`[data-bind="awardtotal"][data-team="${id}"]`);
    if (!el) continue;
    const v = animatedNumber(`award:${id}`, s[id].total, now, 1400);
    el.textContent = fmtPoints(Math.round(v));
  }
}

export function render(state: AppState, root: HTMLElement): boolean {
  return renderInto(root, view(state));
}
