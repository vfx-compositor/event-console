import { activeTeamIds, computeScores } from '../state';
import { el } from './dom';
import { fmtPoints } from '../scoring';
import type { Action } from '../state';
import type { AppState, AwardStep } from '../types';
import type { Ctx } from './ctx';

export const meta = { id: 'award', label: '시상' };

const STEPS: { key: AwardStep; label: string; tip: string }[] = [
  { key: 'p1', label: '① 1부 순위', tip: '1부 점수만으로 정렬한 표' },
  { key: 'p2', label: '② 2부 순위', tip: '2부 점수만으로 정렬한 표 (잠금 중이면 1부 표로 대체)' },
  { key: 'total', label: '③ 종합 합산', tip: '총점 카운트업 (1.4초)' },
  { key: 'reveal', label: '④ 순위 공개', tip: '한 등수씩 단독 공개 — 다른 팀은 화면에 없음' },
  { key: 'winner', label: '⑤ 우승', tip: '우승 팀 풀스크린 + 컨페티' },
];

export function awardRankChoices(teamCount: number): number[] {
  return Array.from({ length: teamCount }, (_, index) => index + 1);
}

type AwardOpts = AppState['sceneOpts']['award'];

/**
 * 한 박자에 내보낼 조작 한 벌.
 *
 * `detail`은 스펙의 `{ label, actions }`에 얹은 **설명 전용 필드**다 — 큰 버튼 아래
 * 미리보기 줄과 툴팁이 같은 문장을 쓰게 하려고 여기서 함께 계산한다. 화면 두 곳이
 * 각자 문장을 만들면 문구가 갈라져서 운영자가 다른 안내를 읽게 된다.
 */
export type AwardBeat = { label: string; detail: string; actions: Action[] };

/** 아직 팀까지 공개하지 않은 등수 중 **가장 낮은 등수**(숫자가 큰 쪽). 없으면 null. */
function lowestUnrevealedRank(award: AwardOpts, teamCount: number): number | null {
  for (let rank = teamCount; rank >= 1; rank -= 1) {
    if (!award.revealedRanks.includes(rank)) return rank;
  }
  return null;
}

function rankBeat(rank: number): AwardBeat {
  return {
    label: `${rank}위 등수 노출`,
    detail: `${rank}위 자리만 무대에 띄우고 팀은 가려 둡니다. 다른 등수는 화면에서 사라집니다. MC가 "${rank}위는" 까지 말한 뒤 다음 박자에서 팀을 공개하세요.`,
    // 등수와 팀은 **반드시 두 박자**다. 한 배열에 revealSelectedTeam까지 넣으면
    // 등수 노출과 팀 공개가 한 번의 방송으로 붙어 나가 무대의 뜸이 사라진다.
    //
    // U127 — `award/selectRank`는 `solo`를 생략하면 독립 공개다. 이 박자를 따라가면
    // 무대에는 언제나 그 등수 한 장만 선다(이미 공개한 등수의 이력 카드를 만들지 않는다).
    actions: [
      { type: 'award/step', step: 'reveal' },
      { type: 'award/selectRank', rank },
    ],
  };
}

function winnerBeat(): AwardBeat {
  return {
    label: '우승 세리머니',
    detail: '우승 팀 풀스크린 + 컨페티로 넘어갑니다. 시상의 마지막 박자입니다.',
    actions: [{ type: 'award/step', step: 'winner' }],
  };
}

/**
 * MC를 따라가는 **다음 한 박자**를 계산한다 (U70).
 *
 * 박자 순서: `1부 순위표` → `종합 합산` → `N위 등수 노출` → `N위 팀 공개` → … → `우승 세리머니` → null.
 * 등수는 꼴찌부터 올라간다(`lowestUnrevealedRank`). 2부 잠금 중에는 총점이 1부 총점과 같아
 * 카운트업이 같은 숫자에서 끝나므로 라벨과 안내만 바꿔 운영자가 건너뛸지 고르게 한다.
 *
 * `sceneIsAward`가 false이면 첫 박자에 `scene/set award`를 함께 넣는다 — 이미 시상 씬이면
 * 넣지 않는다(불필요한 씬 재설정으로 전환 효과가 다시 돌지 않게).
 * 상태 리듀서는 건드리지 않는다. 이 함수는 기존 액션만 조합한다.
 */
export function nextAwardBeat(
  award: AwardOpts,
  teamCount: number,
  unlocked: boolean,
  sceneIsAward = true,
): AwardBeat | null {
  const enter: Action[] = sceneIsAward ? [] : [{ type: 'scene/set', scene: 'award' }];
  const withEnter = (beat: AwardBeat | null): AwardBeat | null =>
    beat === null ? null : { ...beat, actions: [...beat.actions, ...enter] };

  // 진입 박자 — 아직 시상 씬이 아니고 아무것도 진행하지 않았으면 1부 순위표부터 연다.
  // (진행 도중 다른 씬으로 나갔다 온 경우에는 여기 걸리지 않고 원래 자리로 이어진다.)
  const untouched = award.step === 'p1' && award.selectedRank === null && award.revealedRanks.length === 0;
  if (!sceneIsAward && untouched) {
    return withEnter({
      label: '1부 순위표',
      detail: '시상 씬을 열고 1부 점수만으로 정렬한 순위표를 띄웁니다. MC가 1부 결과를 되짚는 동안 그대로 둡니다.',
      actions: [{ type: 'award/step', step: 'p1' }],
    });
  }

  if (award.step === 'p1' || award.step === 'p2') {
    return withEnter({
      label: unlocked ? '종합 합산' : '종합 합산 (1부 점수 그대로)',
      detail: unlocked
        ? '1부와 2부를 합친 총점을 카운트업으로 올립니다. MC가 "최종 순위는 2부 점수까지 합산합니다"를 말할 자리입니다.'
        : '2부가 잠겨 있어 총점이 1부 점수와 같습니다. 카운트업이 같은 숫자로 끝나니 멘트만 얹거나 이 박자를 건너뛰세요.',
      actions: [{ type: 'award/step', step: 'total' }],
    });
  }

  if (award.step === 'total') {
    const rank = lowestUnrevealedRank(award, teamCount);
    return withEnter(rank === null ? winnerBeat() : rankBeat(rank));
  }

  if (award.step === 'reveal') {
    if (award.selectedRank !== null && !award.selectedTeamRevealed) {
      const rank = award.selectedRank;
      return withEnter({
        label: `${rank}위 팀 공개`,
        detail: `${rank}위 팀 이름과 점수, 누적 내역을 공개합니다. 공개된 등수는 무대 왼쪽 이력으로 넘어갑니다.`,
        actions: [{ type: 'award/revealSelectedTeam' }],
      });
    }
    const rank = lowestUnrevealedRank(award, teamCount);
    return withEnter(rank === null ? winnerBeat() : rankBeat(rank));
  }

  // winner — 더 나갈 박자가 없다.
  return null;
}

/**
 * 지금 무대가 무엇을 보여 주고 있는지 한 줄 (U127).
 *
 * 등수 버튼이 넷이라 "눌렀는데 뭐가 나가 있는지"를 버튼 색(`is-on`) 하나로만 말하면
 * 팀 공개 전/후가 구분되지 않는다. 상태 가시성은 색 + 텍스트 두 신호로 준다.
 */
export function soloStatusLine(award: AwardOpts, step: AppState['sceneOpts']['award']['step']): string {
  if (step !== 'reveal' || award.selectedRank === null) {
    return '아직 등수를 띄우지 않았습니다. 버튼을 누르면 그 등수만 무대에 서고 다른 팀은 화면에서 사라집니다.';
  }
  const rank = award.selectedRank;
  if (!award.solo) {
    return `무대: ${rank}위 (누적 무대 — 이미 공개한 등수가 함께 보입니다)`;
  }
  return award.selectedTeamRevealed
    ? `무대: ${rank}위 팀 공개됨 — 이 등수 한 장만 (다른 팀 화면에 없음)`
    : `무대: ${rank}위 자리만 — 팀 공개 대기 (다른 팀 화면에 없음)`;
}

export function render(ctx: Ctx): HTMLElement {
  const s = ctx.state;
  const cur = s.sceneOpts.award.step;
  const selectedRank = s.sceneOpts.award.selectedRank;
  const selectedTeamRevealed = s.sceneOpts.award.selectedTeamRevealed;
  const scores = computeScores(s);
  const ids = activeTeamIds(s);
  const n = ids.length;
  const sceneIsAward = s.scene === 'award';
  const beat = nextAwardBeat(s.sceneOpts.award, n, s.p2.unlocked, sceneIsAward);
  const enter: Action[] = sceneIsAward ? [] : [{ type: 'scene/set', scene: 'award' }];
  const order = [...ids].sort(
    (a, b) => scores[b].total - scores[a].total || ids.indexOf(a) - ids.indexOf(b),
  );

  // 수동 [N위 …] 버튼 — 아직 reveal 단계가 아니면 등수만 띄우고 멈춘다.
  // 예전에는 step:reveal과 revealSelectedTeam을 한 배열에 넣어 등수와 팀이 한 박자에
  // 같이 터졌다. 무대에서는 그 사이가 MC의 뜸이므로 반드시 두 번 눌러야 한다.
  const manualRevealLabel =
    selectedRank === null
      ? '먼저 등수를 선택하세요'
      : cur !== 'reveal'
        ? `${selectedRank}위 등수 노출`
        : selectedTeamRevealed
          ? `${selectedRank}위 팀 공개됨`
          : `${selectedRank}위 팀 공개`;

  return el(
    'div',
    { class: 'tabpane' },
    el('h3', { class: 'section__title', text: '진행 (MC 따라가기)' }),
    el('button', {
      class: 'btn btn--primary btn--big btn--block',
      type: 'button',
      disabled: beat === null,
      text: beat === null ? '시상 진행 완료' : `다음: ${beat.label}`,
      data: {
        tip:
          beat === null
            ? '모든 등수와 우승 세리머니까지 끝났습니다. 되돌리려면 아래 수동 조작을 쓰세요.'
            : `${beat.detail} · 한 번 누르면 한 박자만 나갑니다.`,
      },
      on: { click: () => beat && ctx.dispatch(beat.actions) },
    }),
    el('p', {
      class: 'tabpane__hint',
      text:
        beat === null
          ? '모든 등수와 우승 세리머니까지 끝났습니다. 되돌리려면 아래 수동 조작을 쓰세요.'
          : beat.detail,
    }),
    el('h3', { class: 'section__title', text: '수동 조작' }),
    el('p', {
      class: 'tabpane__hint',
      text: '가이드에서 벗어났거나 되돌려야 할 때만 쓰세요. 아래 버튼은 [다음] 순서를 건너뜁니다.',
    }),
    el('button', {
      class: 'btn btn--ghost btn--tiny',
      type: 'button',
      text: '시상 씬으로 전환',
      on: { click: () => ctx.dispatch({ type: 'scene/set', scene: 'award' }) },
    }),
    el(
      'div',
      { class: 'stepgrid' },
      STEPS.map((st) =>
        el('button', {
          class: `step${cur === st.key ? ' is-on' : ''}`,
          type: 'button',
          text: st.label,
          data: { tip: st.tip },
          on: {
            click: () =>
              ctx.dispatch([
                { type: 'award/step', step: st.key },
                { type: 'scene/set', scene: 'award' },
              ]),
          },
        }),
      ),
    ),
    el('h3', { class: 'section__title', text: '등수 단독 공개' }),
    el('p', { class: 'tabpane__hint', text: soloStatusLine(s.sceneOpts.award, cur) }),
    /**
     * U127 — 등수 버튼은 **독립 송출 스위치**다.
     *
     * 누르는 즉시 그 등수 자리가 무대에 서고, **이미 공개한 다른 등수는 화면에서 사라진다**
     * (`award/selectRank`가 `solo`를 켠다 — 가리는 것이 아니라 DOM에서 빠진다). 팀 이름·점수는
     * 여전히 한 번 더 눌러야 나간다(U70 두 박자). 되돌리기가 아니라 정상 진행 경로이므로
     * 위험(붉은) 버튼이 아니다 — 다른 등수 버튼을 눌러 언제든 되돌아갈 수 있다.
     *
     * 순서는 큐시트와 같게 **꼴찌부터**(4위 → 1위) 세운다. 큐 커서와 이 줄이 서로 다른 방향을
     * 가리키면 운영자가 매번 두 번 읽어야 한다.
     */
    el(
      'div',
      { class: 'award-rank-picker' },
      [...awardRankChoices(n)].reverse().map((rank) =>
        el('button', {
          class: `btn btn--tiny${selectedRank === rank && cur === 'reveal' ? ' is-on' : ''}`,
          type: 'button',
          text: `${rank}위 발표`,
          data: {
            tip: `${rank}위 자리만 무대에 띄웁니다. 다른 등수는 화면에서 사라지고, 팀 이름·점수는 아래 버튼을 한 번 더 눌러야 나갑니다.`,
          },
          on: {
            click: () =>
              ctx.dispatch([
                { type: 'award/selectRank', rank },
                { type: 'scene/set', scene: 'award' },
              ]),
          },
        }),
      ),
    ),
    el(
      'div',
      { class: 'revealrow' },
      el('button', {
        class: 'btn',
        type: 'button',
        disabled: selectedRank === null || (cur === 'reveal' && selectedTeamRevealed),
        text: manualRevealLabel,
        data: {
          tip:
            cur === 'reveal'
              ? '선택한 등수의 팀을 공개합니다.'
              : '먼저 등수만 무대에 띄웁니다. 팀 공개는 한 번 더 눌러야 나갑니다.',
        },
        on: {
          click: () => {
            if (selectedRank === null) return;
            ctx.dispatch(
              cur === 'reveal'
                ? [{ type: 'award/revealSelectedTeam' }, ...enter]
                : [
                    { type: 'award/step', step: 'reveal' },
                    { type: 'award/selectRank', rank: selectedRank },
                    ...enter,
                  ],
            );
          },
        },
      }),
    ),
    el('h3', { class: 'section__title', text: '최종 집계 (원장 합계)' }),
    el(
      'table',
      { class: 'scoretable' },
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', { text: '순위' }),
          el('th', { text: '팀' }),
          el('th', { text: '1부' }),
          el('th', { text: '2부' }),
          el('th', { text: '총점' }),
        ),
      ),
      el(
        'tbody',
        {},
        order.map((id, i) => {
          const team = s.teams.find((t) => t.id === id)!;
          return el(
            'tr',
            { style: `--team:${team.color}` },
            el('td', { class: 'scoretable__rank', text: String(i + 1) }),
            el('td', { class: 'scoretable__team', text: team.name }),
            el('td', { text: fmtPoints(scores[id].p1) }),
            el('td', { text: s.p2.unlocked ? fmtPoints(scores[id].p2) : '—' }),
            el('td', { class: 'scoretable__total', text: fmtPoints(scores[id].total) }),
          );
        }),
      ),
    ),
  );
}
