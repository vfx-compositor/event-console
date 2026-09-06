/**
 * U138 — 스코어보드·시상의 BONUS 열.
 *
 * 목적은 화면에 열 하나를 더 그리는 게 아니라 **"종목 열 합 = TOTAL"을 되찾는 것**이다.
 * 사회자 재량 보너스(`p1:bonus`/`p2:bonus`, U132)와 수동 가감점(`manual`)은 총점에는
 * 들어가는데 종목 열에는 없었다 — 방송 화면에서 더해 보면 숫자가 맞지 않았다.
 * 그러니 이 파일이 고정하는 것은 렌더 모양이 아니라 **합의 항등식**이다.
 */

import { describe, expect, it } from 'vitest';

import { computeScores, createInitialState, reducer, type Action } from '../state';
import {
  awardCells,
  BONUS_COL_KEY,
  BONUS_COL_LABEL,
  bonusPoints,
  hasBonusEntries,
  scoreColumns,
  scoreRows,
} from './common';
import type { AppState, TeamId } from '../types';

const T0 = 1_700_000_000_000;

/** tsconfig lib이 es2021이라 `Array.prototype.at`을 쓸 수 없다 — 마지막 원소 헬퍼. */
function last<T>(xs: readonly T[]): T {
  return xs[xs.length - 1];
}

function run(state: AppState, ...actions: Action[]): AppState {
  return actions.reduce(reducer, state);
}

/** 1부 한 종목을 확정해 종목 열에 실제 점수가 들어간 상태 — 열 합 검증의 바탕. */
function scoredState(): AppState {
  return run(
    createInitialState(),
    { type: 'p1/rank', eventId: 'curling', teamId: 't1', rank: 1 },
    { type: 'p1/rank', eventId: 'curling', teamId: 't2', rank: 2 },
    { type: 'p1/rank', eventId: 'curling', teamId: 't3', rank: 3 },
    { type: 'p1/rank', eventId: 'curling', teamId: 't4', rank: 4 },
    { type: 'p1/confirm', eventId: 'curling', now: T0 },
  );
}

/** 열 값의 합. TOTAL과 이 값이 같아야 방송 화면에서 손으로 더한 숫자가 맞는다. */
function cellSum(state: AppState, teamId: TeamId): number {
  const row = scoreRows(state).find((r) => r.teamId === teamId)!;
  return row.cells.reduce((acc, c) => acc + c.points, 0);
}

describe('U138 — BONUS 열', () => {
  it('가감점이 없으면 열이 생기지 않는다 (기존 4열 / 해제 시 7열 그대로)', () => {
    const locked = scoredState();
    expect(hasBonusEntries(locked)).toBe(false);
    expect(scoreColumns(locked)).toHaveLength(4);
    expect(scoreColumns(locked).some((c) => c.key === BONUS_COL_KEY)).toBe(false);

    const unlocked = run(locked, { type: 'p2/unlock' });
    expect(scoreColumns(unlocked)).toHaveLength(7);
  });

  it('p1:bonus 50 + manual -10 → BONUS 열 40, 그리고 열 합 = TOTAL', () => {
    const s = run(
      scoredState(),
      { type: 'ledger/bonus', teamId: 't1', delta: 50, part: 'p1', now: T0 + 1 },
      { type: 'ledger/manual', teamId: 't1', delta: -10, reason: '수동 감점', now: T0 + 2 },
    );

    const cols = scoreColumns(s);
    expect(cols).toHaveLength(5);
    const bonusCol = last(cols);
    expect(bonusCol.key).toBe(BONUS_COL_KEY);
    expect(bonusCol.label).toBe(BONUS_COL_LABEL);
    expect(bonusCol.group).toBe('보너스');

    expect(bonusPoints(s).t1).toBe(40);
    const row = scoreRows(s).find((r) => r.teamId === 't1')!;
    expect(last(row.cells)).toMatchObject({ key: BONUS_COL_KEY, points: 40 });

    // 항등식 — 이 파일의 존재 이유
    for (const id of ['t1', 't2', 't3', 't4'] as TeamId[]) {
      expect(cellSum(s, id)).toBe(computeScores(s)[id].total);
    }
  });

  it('2부 해제 상태에서는 p2:bonus까지 합치고, 8열이 되어도 열 합 = TOTAL', () => {
    const s = run(
      run(scoredState(), { type: 'p2/unlock' }),
      { type: 'ledger/bonus', teamId: 't2', delta: 30, part: 'p1', now: T0 + 1 },
      { type: 'ledger/bonus', teamId: 't2', delta: 20, part: 'p2', now: T0 + 2 },
      { type: 'ledger/manual', teamId: 't2', delta: -5, reason: '수동 감점', now: T0 + 3 },
    );

    expect(scoreColumns(s)).toHaveLength(8);
    expect(bonusPoints(s).t2).toBe(45);
    for (const id of ['t1', 't2', 't3', 't4'] as TeamId[]) {
      expect(cellSum(s, id)).toBe(computeScores(s)[id].total);
    }
  });

  /**
   * 비정상 저장본 방어 (P3). 잠금 중에는 2부 탭이 잠겨 `p2:bonus`가 생길 수 없지만,
   * 리허설 뒤 재잠금 같은 경로로 원장에 남아 있을 수 있다. 그 값이 1부 화면의 BONUS 열로
   * 새면 총점 차이로 2부 진행 상황이 읽힌다 — 그래서 잠금 중 합산 ref를 좁혀 둔다.
   */
  it('잠금 중에는 p2:bonus를 합치지 않고 2부 열도 만들지 않는다', () => {
    const s = run(
      scoredState(),
      { type: 'ledger/bonus', teamId: 't1', delta: 40, part: 'p1', now: T0 + 1 },
      { type: 'ledger/manual', teamId: 't1', delta: 10, reason: '수동 가점', now: T0 + 2 },
      // 잠금 중에는 원래 만들어질 수 없는 줄 — 저장본에 남아 있는 상황을 흉내 낸다
      { type: 'ledger/bonus', teamId: 't1', delta: 70, part: 'p2', now: T0 + 3 },
    );

    const cols = scoreColumns(s);
    expect(cols.some((c) => c.ref.startsWith('p2:'))).toBe(false);
    expect(cols.filter((c) => c.group === '1부')).toHaveLength(4);
    expect(bonusPoints(s).t1).toBe(50);

    // 총점에는 70이 살아 있으므로 **일부러** 열 합과 어긋난다 (숫자는 살아 있고 라벨만 없다)
    expect(computeScores(s).t1.total - cellSum(s, 't1')).toBe(70);
  });

  it('되돌린 보너스는 BONUS 열에서 빠진다 (유효 원장만 본다)', () => {
    const added = run(scoredState(), {
      type: 'ledger/bonus',
      teamId: 't3',
      delta: 25,
      part: 'p1',
      now: T0 + 1,
    });
    const entry = last(added.ledger);
    const s = run(added, { type: 'ledger/reverse', entryId: entry.id, now: T0 + 2 });

    expect(hasBonusEntries(s)).toBe(false);
    expect(scoreColumns(s).some((c) => c.key === BONUS_COL_KEY)).toBe(false);
  });

  it('시상 누적 내역에는 접히지 않고 BONUS 한 칸이 맨 뒤에 선다', () => {
    const s = run(
      run(scoredState(), { type: 'p2/unlock' }),
      { type: 'ledger/bonus', teamId: 't1', delta: 15, part: 'p1', now: T0 + 1 },
    );
    const row = scoreRows(s).find((r) => r.teamId === 't1')!;
    const cells = awardCells(row);

    // 1부 4칸 + 2부 합계 1칸 + BONUS 1칸
    expect(cells.map((c) => c.key)).toEqual([
      'curling',
      'newspaper',
      'sticky',
      'sync',
      'p2',
      BONUS_COL_KEY,
    ]);
    expect(last(cells)).toMatchObject({ label: BONUS_COL_LABEL, points: 15 });
  });

  it('잠금 중 시상 내역은 1부 4칸 + BONUS 한 칸이고 "2부"가 새지 않는다', () => {
    const s = run(scoredState(), {
      type: 'ledger/manual',
      teamId: 't1',
      delta: -20,
      reason: '수동 감점',
      now: T0 + 1,
    });
    const row = scoreRows(s).find((r) => r.teamId === 't1')!;
    const cells = awardCells(row);

    expect(cells).toHaveLength(5);
    expect(last(cells).key).toBe(BONUS_COL_KEY);
    expect(cells.some((c) => c.key === 'p2')).toBe(false);
    expect(cells.map((c) => c.label).join('|')).not.toMatch(/2부/);
  });
});
