/**
 * U132 — 사회자 재량 보너스 점수의 원장 계약.
 *
 * 지시: "사회자 재량으로 아무렇게나 점수 추가도 가능하도록 해줘. 그냥 뽀너스 점수"
 *
 * 확인 모달이 없는 원클릭 기록이라 되돌리기가 유일한 안전망이다. 그래서 이 스위트는
 * "기록된다"보다 **"기록된 것이 기존 되돌리기 경로에 전부 걸린다"**를 더 많이 본다.
 */
import { describe, expect, it } from 'vitest';

import {
  activeLedger,
  computeScores,
  createInitialState,
  pointsByRef,
  pointsByRefPrefix,
  reducer,
  type Action,
} from './state';
import type { AppState } from './types';

const T0 = 1_700_000_000_000;

function run(state: AppState, ...actions: Action[]): AppState {
  return actions.reduce(reducer, state);
}

describe('ledger/bonus — 원장 한 줄', () => {
  it('1부에서 누르면 ref p1:bonus, 기본 사유는 "사회자 보너스"', () => {
    const s = run(createInitialState(), {
      type: 'ledger/bonus',
      teamId: 't1',
      delta: 50,
      part: 'p1',
      now: T0,
    });
    expect(s.ledger).toHaveLength(1);
    expect(s.ledger[0]).toMatchObject({
      teamId: 't1',
      delta: 50,
      ref: 'p1:bonus',
      reason: '사회자 보너스',
      ts: T0,
    });
  });

  it('후반에서 누르면 ref p2:bonus', () => {
    const s = run(createInitialState(), {
      type: 'ledger/bonus',
      teamId: 't2',
      delta: 30,
      part: 'p2',
      now: T0,
    });
    expect(s.ledger[0].ref).toBe('p2:bonus');
  });

  it('사유를 넘기면 그대로 쓰고 공백만 있으면 기본값으로 떨어진다', () => {
    const s = run(
      createInitialState(),
      { type: 'ledger/bonus', teamId: 't1', delta: 10, part: 'p1', reason: ' 재치상 ', now: T0 },
      { type: 'ledger/bonus', teamId: 't1', delta: 10, part: 'p1', reason: '   ', now: T0 + 1 },
    );
    expect(s.ledger[0].reason).toBe('재치상');
    expect(s.ledger[1].reason).toBe('사회자 보너스');
  });

  it('delta 0·NaN·±Infinity는 줄을 만들지 않는다 — 상태 참조가 그대로다', () => {
    const s0 = createInitialState();
    expect(reducer(s0, { type: 'ledger/bonus', teamId: 't1', delta: 0, part: 'p1', now: T0 })).toBe(
      s0,
    );
    expect(
      reducer(s0, { type: 'ledger/bonus', teamId: 't1', delta: Number.NaN, part: 'p1', now: T0 }),
    ).toBe(s0);
    /**
     * U139 m5 — `Number.isFinite` 가드가 NaN만 잡는다고 읽히지 않게 무한대도 못 박는다.
     * `±Infinity`가 원장에 들어가면 `computeScores`의 총점이 통째로 `Infinity`가 되어
     * 순위·스코어보드가 전부 무의미해지고, 되돌릴 대상을 찾기도 어려워진다.
     */
    expect(
      reducer(s0, {
        type: 'ledger/bonus',
        teamId: 't1',
        delta: Number.POSITIVE_INFINITY,
        part: 'p1',
        now: T0,
      }),
    ).toBe(s0);
    expect(
      reducer(s0, {
        type: 'ledger/bonus',
        teamId: 't1',
        delta: Number.NEGATIVE_INFINITY,
        part: 'p1',
        now: T0,
      }),
    ).toBe(s0);
    expect(s0.ledger).toHaveLength(0);
  });

  /**
   * U139 m5 — `part`는 타입상 `'p1' | 'p2'`뿐이지만 리듀서는 `action.part === 'p2'` **하나만**
   * 보고 나머지를 전부 1부로 떨어뜨린다. 저장본 마이그레이션이나 손으로 만든 액션처럼 타입을
   * 우회해 들어오는 값이 조용히 2부 소계에 얹히지 않는다는 것을 고정한다 — 방향이 반대였다면
   * (`=== 'p1'`이 아니면 2부) 잘못된 값이 후반 소계를 오염시켰을 것이다.
   */
  it('p1/p2가 아닌 part는 1부로 떨어진다 (기본값이 안전한 쪽)', () => {
    const bogus = { type: 'ledger/bonus', teamId: 't1', delta: 25, now: T0 } as unknown as Action;
    for (const part of ['', 'P2', 'p3', undefined]) {
      const s = run(createInitialState(), { ...(bogus as object), part } as Action);
      expect(s.ledger).toHaveLength(1);
      expect(s.ledger[0].ref).toBe('p1:bonus');
      const score = computeScores(s).t1;
      expect(score.p1).toBe(25);
      expect(score.p2).toBe(0);
    }
  });

  it('음수(Shift+클릭)는 그대로 감점으로 기록된다', () => {
    const s = run(createInitialState(), {
      type: 'ledger/bonus',
      teamId: 't3',
      delta: -20,
      part: 'p1',
      now: T0,
    });
    expect(computeScores(s).t3.total).toBe(-20);
  });
});

describe('보너스와 소계 분리', () => {
  it('1부 보너스는 p1 소계, 후반 보너스는 p2 소계로 간다', () => {
    const s = run(
      createInitialState(),
      { type: 'ledger/bonus', teamId: 't1', delta: 50, part: 'p1', now: T0 },
      { type: 'ledger/bonus', teamId: 't1', delta: 30, part: 'p2', now: T0 + 1 },
    );
    const score = computeScores(s).t1;
    expect(score.p1).toBe(50);
    expect(score.p2).toBe(30);
    expect(score.total).toBe(80);
  });

  it('종목 열(pointsByRefPrefix)에는 섞이지 않는다 — p1:bonus는 어떤 종목 id도 아니다', () => {
    const s = run(createInitialState(), {
      type: 'ledger/bonus',
      teamId: 't1',
      delta: 50,
      part: 'p1',
      now: T0,
    });
    expect(pointsByRefPrefix(s, 'p1:curling').t1).toBe(0);
    expect(pointsByRefPrefix(s, 'p1:newspaper').t1).toBe(0);
    expect(pointsByRefPrefix(s, 'p1:sticky').t1).toBe(0);
    expect(pointsByRefPrefix(s, 'p1:sync').t1).toBe(0);
    // 자기 ref로는 정확히 잡힌다
    expect(pointsByRef(s, 'p1:bonus').t1).toBe(50);
    expect(pointsByRefPrefix(s, 'p1:bonus').t1).toBe(50);
  });
});

describe('보너스 되돌리기', () => {
  it('ledger/reverse로 그 한 줄만 역분개된다', () => {
    const s1 = run(
      createInitialState(),
      { type: 'ledger/bonus', teamId: 't1', delta: 50, part: 'p1', now: T0 },
      { type: 'ledger/bonus', teamId: 't2', delta: 20, part: 'p1', now: T0 + 1 },
    );
    const target = s1.ledger[0];
    const s2 = run(s1, { type: 'ledger/reverse', entryId: target.id, now: T0 + 100 });

    expect(computeScores(s2).t1.total).toBe(0);
    expect(computeScores(s2).t2.total).toBe(20);
    // append-only: 지우지 않고 상쇄 줄이 한 줄 더 쌓인다
    expect(s2.ledger).toHaveLength(3);
    expect(s2.ledger[2]).toMatchObject({ reverseOf: target.id, delta: -50, ref: 'p1:bonus' });
  });

  it('ledger/reverseAll·game/restart의 일괄 역분개 대상에 포함된다', () => {
    const s1 = run(
      createInitialState(),
      { type: 'ledger/bonus', teamId: 't1', delta: 50, part: 'p1', now: T0 },
      { type: 'ledger/bonus', teamId: 't2', delta: 30, part: 'p2', now: T0 + 1 },
    );
    const reset = run(s1, { type: 'ledger/reverseAll', reason: '리셋', now: T0 + 100 });
    expect(activeLedger(reset.ledger)).toHaveLength(0);
    expect(computeScores(reset).t1.total).toBe(0);
    expect(computeScores(reset).t2.total).toBe(0);

    const restarted = run(s1, { type: 'game/restart', reason: '새 게임', now: T0 + 100 });
    expect(activeLedger(restarted.ledger)).toHaveLength(0);
    expect(computeScores(restarted).t1.total).toBe(0);
    expect(computeScores(restarted).t2.total).toBe(0);
  });
});
