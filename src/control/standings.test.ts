/**
 * U136 — 컨트롤 화면 '현재 총점 · 순위' 패널.
 *
 * 지시: "게임2 에서 현재 총점과 순위는 이렇습니다-라고 사회자가 말하고싶을때가 있어서."
 *
 * 사회자가 **입으로 읽는** 숫자라 틀리면 그 자리에서 방송 사고가 된다. 그래서 이 스위트는
 * 그림보다 등수 계산을 본다 — 특히 동점 처리(1, 2, 2, 4)를. `environment: 'node'`라 DOM이
 * 없으므로 다른 탭 스위트와 같은 관례를 따른다: 판단은 순수 함수(`standingsRows`)로 빼서
 * 값으로 검증하고, DOM 배선은 소스 문자열로 잠근다.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error Vitest runs on Node; the browser app intentionally omits @types/node.
import { readFileSync } from 'node:fs';

import { createInitialState, reducer, type Action } from '../state';
import { EMPTY_LABEL, activeEntryCounts, rankLabel, standingsRows } from './standings';
import type { AppState, TeamId } from '../types';

const source = readFileSync(new URL('./standings.ts', import.meta.url), 'utf8');
const p1Source = readFileSync(new URL('./tab-p1.ts', import.meta.url), 'utf8');
const p2Source = readFileSync(new URL('./tab-p2.ts', import.meta.url), 'utf8');
const ledgerSource = readFileSync(new URL('./tab-ledger.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles/control.css', import.meta.url), 'utf8');

const T0 = 1_700_000_000_000;

function run(state: AppState, ...actions: Action[]): AppState {
  return actions.reduce(reducer, state);
}

/** 보너스 한 줄로 점수를 만든다 — 원장을 타는 가장 짧은 경로다. */
function bonus(teamId: TeamId, delta: number, part: 'p1' | 'p2' = 'p1'): Action {
  return { type: 'ledger/bonus', teamId, delta, part, now: T0 };
}

describe('standingsRows — 순위와 소계', () => {
  it('총점 내림차순으로 줄을 세운다', () => {
    const s = run(createInitialState(), bonus('t3', 100), bonus('t1', 50), bonus('t4', 200));
    expect(standingsRows(s).map((r) => r.teamId)).toEqual(['t4', 't3', 't1', 't2']);
  });

  it('동점은 같은 등수를 나눠 갖고 다음 팀은 자리 번호로 돌아간다 (1, 2, 2, 4)', () => {
    const s = run(
      createInitialState(),
      bonus('t1', 300),
      bonus('t2', 200),
      bonus('t3', 200),
      bonus('t4', 100),
    );
    const rows = standingsRows(s);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 2, 4]);
    expect(rows.map((r) => r.tied)).toEqual([false, true, true, false]);
  });

  it('세 팀이 동점이면 셋 다 같은 등수이고 그 뒤는 4위다', () => {
    const s = run(createInitialState(), bonus('t1', 50), bonus('t2', 50), bonus('t3', 50));
    const rows = standingsRows(s);
    expect(rows.map((r) => r.rank)).toEqual([1, 1, 1, 4]);
    expect(rows.map((r) => r.tied)).toEqual([true, true, true, false]);
  });

  it('total은 소계의 합이다', () => {
    const s = run(createInitialState(), bonus('t1', 100, 'p1'), bonus('t1', 50, 'p2'));
    const row = standingsRows(s).find((r) => r.teamId === 't1')!;
    expect(row).toMatchObject({ p1: 100, p2: 50, total: 150 });
  });

  it('감점도 그대로 반영돼 음수 총점이 꼴찌로 간다', () => {
    const s = run(createInitialState(), bonus('t1', -30), bonus('t2', 10));
    const rows = standingsRows(s);
    expect(rows[rows.length - 1]).toMatchObject({ teamId: 't1', total: -30 });
  });

  it('원장이 비어 있으면 참가 팀 전원이 0점 공동 1위다', () => {
    const rows = standingsRows(createInitialState());
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.total === 0 && r.rank === 1 && r.tied)).toBe(true);
  });

  it('역분개된 줄은 총점에서 빠진다', () => {
    const given = run(createInitialState(), bonus('t1', 100));
    const s = run(given, { type: 'ledger/reverse', entryId: given.ledger[0].id, now: T0 + 1 });
    expect(standingsRows(s).find((r) => r.teamId === 't1')!.total).toBe(0);
  });
});

describe('rankLabel — 사회자가 읽는 말', () => {
  it('단독이면 "N위", 동점이면 "공동 N위"', () => {
    expect(rankLabel({ teamId: 't1', rank: 1, total: 10, p1: 10, p2: 0, tied: false })).toBe('1위');
    expect(rankLabel({ teamId: 't2', rank: 2, total: 10, p1: 10, p2: 0, tied: true })).toBe('공동 2위');
  });
});

describe('activeEntryCounts — tip의 근거', () => {
  it('유효 항목만 팀별로 센다', () => {
    const given = run(createInitialState(), bonus('t1', 10), bonus('t1', 20), bonus('t2', 30));
    expect(activeEntryCounts(given)).toMatchObject({ t1: 2, t2: 1, t3: 0, t4: 0 });

    const s = run(given, { type: 'ledger/reverse', entryId: given.ledger[0].id, now: T0 + 1 });
    // 되돌린 줄과 상쇄 줄이 둘 다 유효에서 빠진다
    expect(activeEntryCounts(s).t1).toBe(1);
  });
});

describe('DOM 배선', () => {
  it('세 탭이 같은 컴포넌트를 쓴다 — 원장 탭만 compact', () => {
    expect(p1Source).toContain('renderStandings(ctx)');
    expect(p2Source).toContain('renderStandings(ctx)');
    expect(ledgerSource).toContain('renderStandings(ctx, { compact: true })');
  });

  it('두 컨트롤 탭에서는 보너스 스트립 바로 위에 온다', () => {
    for (const src of [p1Source, p2Source]) {
      expect(src.indexOf('renderStandings(ctx)')).toBeLessThan(src.indexOf('renderBonusStrip(ctx,'));
    }
    // 잠금 화면은 이른 return으로 빠져나가므로 그 위에 그려지지 않는다
    expect(p2Source.indexOf('renderStandings(ctx)')).toBeGreaterThan(
      p2Source.indexOf("class: 'tabpane tabpane--locked'"),
    );
  });

  it('읽기 전용이다 — 점수를 바꾸는 dispatch가 없다', () => {
    expect(source).not.toContain('ctx.dispatch');
    expect(source).not.toContain('openModal');
  });

  it('[원장] 버튼은 원장 탭·compact에서 숨는다', () => {
    expect(source).toContain("ctx.tab !== 'ledger'");
    expect(source).toContain('!opts.compact');
    expect(source).toContain("ctx.setTab('ledger')");
  });

  it('총점은 원장 파생값을 그대로 쓴다 — 여기서 다시 세지 않는다', () => {
    expect(source).toContain('computeScores');
    expect(source).toContain('rankedTeams');
  });

  it('칩마다 hover tip이 붙고 키보드로도 열린다', () => {
    expect(source).toContain('tabIndex: 0');
    expect(source).toMatch(/tip: unlocked \?/);
  });

  it('점수가 하나도 없으면 빈 칩 문구로 떨어진다', () => {
    expect(EMPTY_LABEL).toBe('아직 점수 없음');
    expect(source).toContain('rows.every((r) => r.total === 0)');
  });

  it('CSS가 있고 자간을 넓히지 않는다', () => {
    expect(css).toMatch(/\.standings\s*\{/);
    expect(css).toMatch(/\.standings__chip\s*\{/);
    expect(css).toMatch(/\.standings__chip:focus-visible\s*\{/);
    expect(css).toMatch(/\.standings__total\s*\{/);
    const block = css.slice(css.indexOf('.standings {'), css.indexOf('.standings__total') + 200);
    expect(block).not.toMatch(/letter-spacing:\s*0?\.\d/);
  });
});

describe('진행 잠금 계약', () => {
  it('해제 분기 밖의 문자열에는 잠금 대상 낱말이 없다', () => {
    // 해제됐을 때만 만들어지는 문구는 UNLOCKED-ONLY 마커 사이에 모여 있다. 그 블록을
    // 도려낸 나머지가 잠금 중에도 그려질 수 있는 전부다.
    const start = source.indexOf('>>> UNLOCKED-ONLY');
    const end = source.indexOf('<<< UNLOCKED-ONLY');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const locked = source.slice(0, start) + source.slice(end);
    expect(locked).not.toMatch(/후반|용의자|범인|2부/);
  });

  it('소계 분해는 해제됐을 때만 tip에 들어간다', () => {
    expect(source).toMatch(/const unlocked = s\.p2\.unlocked/);
    expect(source).toMatch(/unlocked \? splitTip\(/);
  });
});
