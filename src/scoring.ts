/**
 * 점수 계산 — 순수 함수만. (SPEC §2, ADR-009)
 *
 * 두 가지 규칙:
 *  1) 순위 → 점수: 점수표의 슬롯을 순위 순서대로 배분. 공동 순위는 그들이 차지한
 *     슬롯들의 **평균**을 나눠 갖는다. (예: 1위 2팀 → (100+80)/2 = 90점씩, 다음 팀은 3위 슬롯)
 *  2) 제출 시각 → 순위: 정답 제출만 시간순 정렬 후, 그룹 선두로부터 tieWindowSec 이내는
 *     동시 제출로 보아 공동 순위. 이후 1) 규칙으로 평균 점수.
 */

import { TEAM_IDS, type RankMap, type Submission, type TeamId } from './types';

/**
 * 점수표 슬롯 평균 배분. ranks 값이 같으면 공동 순위. null은 미참여(0점).
 * `teamIds`는 이번 경기에 실제로 참가하는 4팀 목록. 넘기지 않으면 호환용 전체 슬롯을 본다.
 */
export function pointsFromRanks(
  ranks: RankMap,
  table: number[],
  teamIds: TeamId[] = TEAM_IDS,
): Record<TeamId, number> {
  const out = {} as Record<TeamId, number>;
  for (const id of TEAM_IDS) out[id] = 0;

  const ranked = teamIds.filter((id) => typeof ranks[id] === 'number' && ranks[id]! > 0).sort(
    (a, b) => ranks[a]! - ranks[b]! || teamIds.indexOf(a) - teamIds.indexOf(b),
  );
  if (ranked.length === 0) return out;

  let slot = 0; // 0-based 점수표 인덱스
  let i = 0;
  while (i < ranked.length) {
    const rankValue = ranks[ranked[i]]!;
    const group: TeamId[] = [];
    while (i < ranked.length && ranks[ranked[i]]! === rankValue) {
      group.push(ranked[i]);
      i += 1;
    }
    let sum = 0;
    for (let k = 0; k < group.length; k += 1) sum += table[slot + k] ?? 0;
    const share = sum / group.length;
    for (const id of group) out[id] = share;
    slot += group.length;
  }
  return out;
}

/**
 * 제출 기록 → 공동 순위를 반영한 순위 맵.
 * 오답/미제출은 null(점수 0). 그룹 판정은 "그룹 선두 시각 기준 windowSec 이내".
 */
export function rankSubmissions(
  submissions: Record<TeamId, Submission | null>,
  tieWindowSec: number,
  teamIds: TeamId[] = TEAM_IDS,
): RankMap {
  const out = {} as RankMap;
  for (const id of TEAM_IDS) out[id] = null;
  const correct = teamIds.filter((id) => submissions[id]?.correct).sort((a, b) => {
    const d = submissions[a]!.at - submissions[b]!.at;
    return d !== 0 ? d : teamIds.indexOf(a) - teamIds.indexOf(b);
  });
  if (correct.length === 0) return out;

  const windowMs = Math.max(0, tieWindowSec) * 1000;
  let i = 0;
  let nextRank = 1;
  while (i < correct.length) {
    const leadAt = submissions[correct[i]]!.at;
    const group: TeamId[] = [];
    while (i < correct.length && submissions[correct[i]]!.at - leadAt <= windowMs) {
      group.push(correct[i]);
      i += 1;
    }
    for (const id of group) out[id] = nextRank;
    nextRank += group.length;
  }
  return out;
}

/** 표시용: 점수 소수점 정리 (평균 배분 시 .5 가 나올 수 있음) */
export function fmtPoints(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
