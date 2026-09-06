/**
 * 현재 총점 · 순위 패널 (U136)
 *
 * 지시: "중간 총점 누적이 내쪽에서 안보이더라고. 게임2 에서 현재 총점과 순위는
 * 이렇습니다-라고 사회자가 말하고싶을때가 있어서. 그걸 보이게 수정해줬으면 좋겠어."
 *
 * 출력(방송) 화면의 스코어바가 아니라 **컨트롤 화면**에 붙는 패널이다. 사회자가 진행
 * 도중 눈으로 훑고 그대로 읽어 주는 자리라서, 숫자를 크게 두고 등수·팀명을 보조로
 * 낮췄다. 점수를 바꾸는 조작은 하나도 없다 — 읽기 전용이다.
 *
 * 원장이 정본이므로 여기서 따로 합계를 세지 않고 `computeScores`/`rankedTeams`를 그대로
 * 쓴다. 화면에 보이는 값과 [점수 원장] 탭의 값이 갈라질 여지를 만들지 않기 위해서다.
 *
 * 이 파일이 만드는 문자열에는 잠금 대상 낱말이 없어야 한다 — 잠금 해제 전 컨트롤 탭에도
 * 그려지기 때문이다. 해제됐을 때만 쓰는 문구는 아래 UNLOCKED-ONLY 블록 한 곳에 모여
 * 있고, 테스트가 그 블록을 도려낸 나머지에서 낱말 부재를 확인한다.
 */

import { activeLedger, activeTeamIds, computeScores, getTeam, rankedTeams } from '../state';
import { fmtPoints } from '../scoring';
import { el } from './dom';
import type { Ctx } from './ctx';
import type { AppState, TeamId } from '../types';

export interface StandingsRow {
  teamId: TeamId;
  /** 공동 등수를 반영한 순위 (1, 2, 2, 4 식) */
  rank: number;
  total: number;
  p1: number;
  p2: number;
  /** 같은 총점인 팀이 하나라도 더 있는가 (칩에 '공동'을 붙일지) */
  tied: boolean;
}

/**
 * 총점 내림차순 한 줄씩. 순서는 `rankedTeams`(동점이면 팀 순서 유지)를 그대로 따르고,
 * 등수만 여기서 다시 매긴다.
 *
 * 등수는 **경쟁 순위(1, 2, 2, 4)** 다 — 동점 두 팀 뒤의 팀을 3위라고 부르면 사회자가
 * 읽는 순간 틀린 말이 된다. `tied`는 그 등수를 나눠 갖는 팀이 있다는 표시이고,
 * 화면에서는 '공동 2위'로 나간다.
 */
export function standingsRows(state: AppState): StandingsRow[] {
  const scores = computeScores(state);
  const order = rankedTeams(state);

  const rows: StandingsRow[] = order.map((teamId, i) => {
    const sc = scores[teamId];
    return { teamId, rank: i + 1, total: sc.total, p1: sc.p1, p2: sc.p2, tied: false };
  });

  for (let i = 0; i < rows.length; i += 1) {
    // 앞 팀과 총점이 같으면 등수를 물려받는다 → 그 다음 팀은 자리 번호(i+1)로 돌아간다.
    if (i > 0 && rows[i].total === rows[i - 1].total) rows[i].rank = rows[i - 1].rank;
    const prevSame = i > 0 && rows[i - 1].total === rows[i].total;
    const nextSame = i + 1 < rows.length && rows[i + 1].total === rows[i].total;
    rows[i].tied = prevSame || nextSame;
  }

  return rows;
}

/**
 * 팀별 유효(역분개되지 않은) 원장 항목 수. hover tip에서 "이 총점이 몇 줄의 합인지"를
 * 말해 주는 데만 쓴다 — 숫자가 이상해 보일 때 원장으로 갈 근거가 된다.
 */
export function activeEntryCounts(state: AppState): Record<TeamId, number> {
  const out = {} as Record<TeamId, number>;
  const ids = new Set<TeamId>(activeTeamIds(state));
  for (const id of ids) out[id] = 0;
  // 참가하지 않는 슬롯(t5·t6)에 남은 옛 기록은 세지 않는다 — 화면에 그 칩이 없으니까.
  for (const e of activeLedger(state.ledger)) if (ids.has(e.teamId)) out[e.teamId] += 1;
  return out;
}

/** 등수 라벨. 동점이면 '공동'을 앞에 붙인다. */
export function rankLabel(row: StandingsRow): string {
  return row.tied ? `공동 ${row.rank}위` : `${row.rank}위`;
}

/** 아직 아무 점수도 없을 때 칩 자리에 들어가는 문구. */
export const EMPTY_LABEL = '아직 점수 없음';

/** 잠금 중에도 그대로 나가는 tip 꼬리. 합계의 출처만 말한다. */
function baseTip(teamName: string, total: number, entries: number): string {
  return `${teamName} 총점 ${fmtPoints(total)} · 원장 유효 항목 ${entries}건 (합계 = 유효 항목의 합)`;
}

/* >>> UNLOCKED-ONLY — 이 블록의 문자열은 `p2.unlocked`일 때만 만들어진다.
 * 잠금 중에 소계 분해를 보여 주면 존재하지 않아야 할 것을 컨트롤 화면에서 먼저 알려
 * 주는 셈이라, 분기 밖에서는 절대 참조하지 않는다. 테스트는 이 마커 사이를 도려낸
 * 나머지 소스에서 낱말 부재를 확인한다. */
function splitTip(teamName: string, row: StandingsRow, entries: number): string {
  return `${teamName} 총점 ${fmtPoints(row.total)} · 1부 ${fmtPoints(row.p1)} · 2부 ${fmtPoints(
    row.p2,
  )} · 원장 유효 항목 ${entries}건`;
}
/* <<< UNLOCKED-ONLY */

/**
 * @param opts.compact 원장 탭처럼 이미 원장을 보고 있는 자리에서는 [원장] 버튼을 뺀다.
 */
export function renderStandings(ctx: Ctx, opts: { compact?: boolean } = {}): HTMLElement {
  const s = ctx.state;
  const rows = standingsRows(s);
  const counts = activeEntryCounts(s);
  const unlocked = s.p2.unlocked;
  const empty = rows.length === 0 || rows.every((r) => r.total === 0);
  const showLedgerLink = !opts.compact && ctx.tab !== 'ledger';

  return el(
    'section',
    { class: 'standings' },
    el(
      'div',
      { class: 'standings__head' },
      el('h3', { class: 'standings__title', text: '현재 총점 · 순위' }),
      showLedgerLink &&
        el('button', {
          class: 'btn btn--ghost btn--tiny standings__more',
          type: 'button',
          text: '원장',
          data: {
            fid: 'standings-ledger',
            tip: '점수의 정본은 [점수 원장] 탭입니다. 여기 숫자가 이상하면 원장에서 어느 줄 때문인지 확인하고 역분개할 수 있습니다.',
          },
          on: { click: () => ctx.setTab('ledger') },
        }),
    ),
    el(
      'div',
      { class: 'standings__chips' },
      empty
        ? el(
            'div',
            {
              class: 'standings__chip standings__chip--empty',
              data: { tip: '원장에 유효 항목이 아직 없습니다. 점수를 확정하거나 보너스를 주면 여기에 순위가 생깁니다.' },
              tabIndex: 0,
            },
            el('span', { class: 'standings__team', text: EMPTY_LABEL }),
          )
        : rows.map((row) => {
            const team = getTeam(s, row.teamId);
            const entries = counts[row.teamId] ?? 0;
            return el(
              'div',
              {
                class: 'standings__chip',
                style: `--team:${team.color}`,
                data: {
                  tip: unlocked ? splitTip(team.name, row, entries) : baseTip(team.name, row.total, entries),
                },
                tabIndex: 0,
              },
              el('span', { class: 'standings__rank', text: rankLabel(row) }),
              el('span', { class: 'standings__team', text: team.name }),
              el('span', { class: 'standings__total', text: fmtPoints(row.total) }),
            );
          }),
    ),
  );
}
